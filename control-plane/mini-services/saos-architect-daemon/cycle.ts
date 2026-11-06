/* ═══ saos-architect-daemon · cycle.ts — the executive loop ═════════════════
 * One cycle = AUDIT → SELECT → CURE → VERIFY → LAND → RECEIPT.
 * Single-flight (lock.ts). Fail-closed everywhere:
 *   · verify failure  → byte-identical revert → receipt 'aborted'
 *   · push race       → fetch/rebase/push loop ≤3 → honest verdict
 *   · no curable work → receipt 'no-work' (honest null, never fabricated)
 * The daemon edits ONLY the files its cure plans declare; commit adds exactly
 * those paths (never `git add -A` — resident writers' state never rides along).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseEvidence, selectContract, TsContract } from "./executive.ts";
import { CURE_REGISTRY, applyCure, revertToSnapshot, boundaryRewindSelection, Snapshot } from "./registry.ts";
import { canonicalJSON, ReceiptChain, verifyReceipts, writeChainJsonl } from "./receipts.ts";
import { acquireLock, releaseLock, LockHandle } from "./lock.ts";
import { commitArgs, rebaseArgs, gpgSecretKeyAvailable } from "./git-law.ts";
import type { Selection } from "./executive.ts";

export const SERVICE_DIR = import.meta.dir;
export const REPO_ROOT = path.resolve(SERVICE_DIR, "..", "..");
export const STATE_DIR = path.join(SERVICE_DIR, "state");
export const RECEIPTS_PATH = path.join(STATE_DIR, "receipts.jsonl");
export const LOCK_PATH = path.join(STATE_DIR, "cycle.lock");
export const PORT = 3051;

export interface CycleVerdict {
  ok: boolean;
  verdict: "landed" | "no-work" | "aborted" | "lock-held" | "feed-error";
  contract?: TsContract;
  cureId?: string;
  beforeErrors: number;
  afterErrors: number;
  commit?: string;
  pushed?: boolean;
  detail?: string;
}

function sh(cwd: string, cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 10 * 60 * 1000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runTsc(root: string): { evidence: string; count: number } {
  const r = sh(root, "bunx", ["tsc", "--noEmit", "-p", "."]);
  const evidence = r.out;
  const count = parseEvidence(evidence).length;
  return { evidence, count };
}

export function loadChain(): ReceiptChain {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existing = fs.existsSync(RECEIPTS_PATH) ? readOrNull(RECEIPTS_PATH) : null;
  return existing ?? new ReceiptChain();
}

function readOrNull(file: string): ReceiptChain | null {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const chain = new ReceiptChain();
    for (const line of lines) chain.append((JSON.parse(line) as { body: Record<string, unknown> }).body);
    return verifyReceipts(chain.all()).ok ? chain : null;
  } catch {
    return null;
  }
}

export function runCycle(root: string = REPO_ROOT, pid: number = process.pid): CycleVerdict {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let lock: LockHandle;
  try {
    lock = acquireLock(LOCK_PATH, pid);
  } catch (e) {
    return { ok: false, verdict: "lock-held", beforeErrors: -1, afterErrors: -1, detail: String(e) };
  }
  const chain = loadChain();
  const finish = (v: CycleVerdict): CycleVerdict => {
    writeChainJsonl(chain, RECEIPTS_PATH);
    releaseLock(lock);
    return v;
  };
  try {
    /* 1. AUDIT — live trunk evidence */
    chain.append({ kind: "audit", at: new Date().toISOString(), stage: "tsc-start" });
    const before = runTsc(root);
    chain.append({ kind: "audit", at: new Date().toISOString(), errors: before.count });

    /* 2. SELECT — deterministic, curable-first; boundary-rewind pre-flight guards the evidence plane */
    const contracts = parseEvidence(before.evidence);
    const sel: Selection | null = boundaryRewindSelection(root) ?? selectContract(contracts, CURE_REGISTRY);
    if (!sel) {
      return finish({ ok: true, verdict: "no-work", beforeErrors: before.count, afterErrors: before.count, detail: `${contracts.length} contracts, none curable by registry` });
    }
    chain.append({ kind: "selected", at: new Date().toISOString(), cureId: sel.cureId, contract: sel.contract });

    /* 3. CURE — snapshot-first */
    let snap: Snapshot;
    try {
      snap = applyCure(root, sel);
    } catch (e) {
      chain.append({ kind: "aborted", at: new Date().toISOString(), cureId: sel.cureId, reason: String(e) });
      return finish({ ok: false, verdict: "aborted", beforeErrors: before.count, afterErrors: before.count, contract: sel.contract, cureId: sel.cureId, detail: `cure-refused: ${e}` });
    }

    /* 4. VERIFY — errors must strictly decrease, never increase */
    const after = runTsc(root);
    if (after.count >= before.count) {
      revertToSnapshot(root, snap);
      chain.append({ kind: "aborted", at: new Date().toISOString(), cureId: sel.cureId, reason: `verify-fail ${before.count}→${after.count}`, reverted: true });
      return finish({ ok: false, verdict: "aborted", beforeErrors: before.count, afterErrors: after.count, contract: sel.contract, cureId: sel.cureId, detail: "verify-fail — byte-identical revert applied" });
    }
    chain.append({ kind: "verified", at: new Date().toISOString(), cureId: sel.cureId, errors: `${before.count}→${after.count}` });

    /* 5. LAND — add declared files only, commit, rebase loop, push, ls-remote prove
     *    G78-i: the signing law is MEASURED per cycle, never trusted to the env:
     *    sovereign key present → force-signed; absent → honest-unsigned trailer. */
    const gpgKeyPresent = gpgSecretKeyAvailable((cmd, args) => sh(root, cmd, args));
    const planFiles = sel.cure.build(root, sel.contract).files.map((f) => path.join(root, f));
    for (const f of planFiles) sh(root, "git", ["add", "--", path.relative(root, f)]);
    const msg = `fix(architect): ${sel.cureId} — ${sel.contract.file}:${sel.contract.line} ${sel.contract.code} cured (architect-daemon cycle, tsc ${before.count}→${after.count}${gpgKeyPresent ? ", gpg-signed" : ", honest-unsigned"})`;
    const commitMsg = sh(root, "git", commitArgs(msg, { gpg: gpgKeyPresent }));
    if (commitMsg.code !== 0) {
      revertToSnapshot(root, snap);
      const nothing = commitMsg.out.includes("nothing to commit");
      chain.append({ kind: "aborted", at: new Date().toISOString(), reason: nothing ? "idempotent-no-op" : `commit-fail: ${commitMsg.out.slice(0, 200)}`, reverted: !nothing });
      return finish({ ok: nothing, verdict: nothing ? "no-work" : "aborted", beforeErrors: before.count, afterErrors: after.count, contract: sel.contract, cureId: sel.cureId, detail: nothing ? "cure already present upstream" : "commit failed — reverted" });
    }
    const sha = sh(root, "git", ["rev-parse", "HEAD"]).out.trim();

    let pushed = false;
    let lastErr = "";
    for (let attempt = 0; attempt < 3 && !pushed; attempt++) {
      sh(root, "git", ["fetch", "origin", "main"]);
      const rebase = sh(root, "git", rebaseArgs());
      if (rebase.code !== 0) {
        // mid-rebase conflict: our tree = adopted truth; abort honestly (revert-by-abort), keep receipts
        sh(root, "git", ["rebase", "--abort"]);
        lastErr = `rebase-conflict: ${rebase.out.slice(0, 200)}`;
        break;
      }
      const push = sh(root, "git", ["push", "origin", "main"]);
      if (push.code === 0) {
        const remote = sh(root, "git", ["ls-remote", "origin", "main"]).out.trim().split("\t")[0];
        pushed = remote === sh(root, "git", ["rev-parse", "HEAD"]).out.trim();
        if (!pushed) lastErr = "ls-remote mismatch after push";
      } else {
        lastErr = `push-rejected: ${push.out.slice(0, 120)}`;
      }
    }

    chain.append({ kind: "landed", at: new Date().toISOString(), cureId: sel.cureId, sha, pushed, errors: `${before.count}→${after.count}`, detail: pushed ? undefined : lastErr });
    return finish({ ok: true, verdict: "landed", contract: sel.contract, cureId: sel.cureId, beforeErrors: before.count, afterErrors: after.count, commit: sha, pushed, detail: pushed ? undefined : lastErr });
  } catch (e) {
    chain.append({ kind: "feed-error", at: new Date().toISOString(), reason: String(e).slice(0, 300) });
    return finish({ ok: false, verdict: "feed-error", beforeErrors: -1, afterErrors: -1, detail: String(e) });
  }
}

export function statusReport(): Record<string, unknown> {
  const chain = loadChain();
  const all = chain.all();
  const last = all[all.length - 1];
  return {
    schema: "saos-architect-daemon/status@1",
    receipts: all.length,
    headHash: chain.headHash(),
    chainVerified: verifyReceipts(all).ok,
    last: last ? { kind: last.body.kind, at: last.body.at, cureId: last.body.cureId, sha: last.body.sha, pushed: last.body.pushed } : null,
    pid: process.pid,
  };
}

export { canonicalJSON };
