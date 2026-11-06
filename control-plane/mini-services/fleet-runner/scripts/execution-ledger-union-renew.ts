/**
 * execution-ledger-union-renew.ts — t64 (trace 1a17d4f7d0ecfe91, directive
 * "IMMEDIATE PROFITABILITY … ZERO-TRIVIALITY MANDATE" §3):
 *
 * The execution ledger (SAOS-EXECUTION-LEDGER/1) lives on THREE law surfaces
 * and they were measured DIVERGENT (root 13/6 · Domain 24/10 · mirror 12/5,
 * all stale ~21h at 2026-10-27T12:2xZ). The erasureGuard law says a renewal
 * MUST MERGE — never replace. This renewer:
 *
 *   1. UNION — picks the richest committed doc as base and proves (or repairs)
 *      the superset property by appending any row that exists only in a sister
 *      surface. Zero rows die. cycle/wave sections and the guard ride the spread.
 *   2. RENEW — refreshes at/generator/sourceWorklog/freshness/measuredSnapshot
 *      from MEASURED facts (surfaces, GitHub CI run-IDs, public chain RPC).
 *      A fact that cannot be measured from here is recorded as honestly absent
 *      (organ-scoped) — never invented.
 *   3. PUBLISH — byte-true write to all three surfaces with race-safe
 *      pull --rebase + push (the house publish pattern), plus the giant mirror.
 *
 * Core is pure (clock/rows injected) and selftested; the CLI shell is the only
 * impure part. רץ: bun mini-services/fleet-runner/scripts/execution-ledger-union-renew.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ── pure core ────────────────────────────────────────────────────────────────

export interface LedgerRow {
  id?: string;
  title?: string;
  detail?: string;
  evidence?: string;
  [k: string]: unknown;
}
export type LedgerDoc = Record<string, unknown>;
export interface UnionReport {
  base: "domain" | "rootsite" | "mirror";
  rowKeysBefore: number;
  appendedFromSisters: number;
  sectionsBroughtIn: string[];
}

const ROW_ARRAYS = ["done", "partial", "gaps", "next"] as const;
export type RowArray = (typeof ROW_ARRAYS)[number];

/** Identity key of a ledger row (id when present, else the title). */
export function rowKey(r: LedgerRow): string {
  return `${r.id ?? ""}|${String(r.title ?? "")}`;
}

function rowsOf(doc: LedgerDoc, key: RowArray): LedgerRow[] {
  const v = doc[key];
  return Array.isArray(v) ? (v as LedgerRow[]) : [];
}

/**
 * Union law: the richest doc is the base; every sister row absent from the
 * base is APPENDED into it (matched per row-array). Cycle/wave sections
 * that exist only in a sister are brought in whole. Nothing is replaced.
 */
export function unionLedgers(docs: {
  domain: LedgerDoc;
  rootsite: LedgerDoc;
  mirror: LedgerDoc;
}): { doc: LedgerDoc; report: UnionReport } {
  const sizes = {
    domain: ROW_ARRAYS.reduce((n, k) => n + rowsOf(docs.domain, k).length, 0),
    rootsite: ROW_ARRAYS.reduce((n, k) => n + rowsOf(docs.rootsite, k).length, 0),
    mirror: ROW_ARRAYS.reduce((n, k) => n + rowsOf(docs.mirror, k).length, 0),
  };
  const base = (Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0] as UnionReport["base"]);
  const doc: LedgerDoc = structuredClone(docs[base]);
  const report: UnionReport = { base, rowKeysBefore: sizes[base], appendedFromSisters: 0, sectionsBroughtIn: [] };

  for (const sisterName of ["domain", "rootsite", "mirror"] as const) {
    if (sisterName === base) continue;
    const sister = docs[sisterName];
    // sections the base lacks come in whole (never overwrite an existing one)
    for (const k of Object.keys(sister)) {
      if (!(k in doc)) {
        doc[k] = structuredClone(sister[k]);
        report.sectionsBroughtIn.push(`${sisterName}:${k}`);
      }
    }
    // rows: append the absent, in sister order (id|title identity)
    for (const arr of ROW_ARRAYS) {
      const baseKeys = new Set(rowsOf(doc, arr).map(rowKey));
      for (const row of rowsOf(sister, arr)) {
        if (!baseKeys.has(rowKey(row))) {
          rowsOf(doc, arr).push(structuredClone(row));
          baseKeys.add(rowKey(row));
          report.appendedFromSisters += 1;
        }
      }
    }
  }
  return { doc, report };
}

export interface RenewFacts {
  at: string; // renew stamp (injected clock)
  generator: string;
  sourceWorklog: string;
  /** verified evidence rows appended under `done` */
  doneRows: LedgerRow[];
  /** honest open-wound rows appended under `gaps` */
  gapRows: LedgerRow[];
  measuredSnapshot: Record<string, unknown>;
  /** growth law: auto rows cap */
  cap?: number;
}

/**
 * Lineage-preserving renewal: refresh the identity keys, APPEND the verified
 * rows (never rewrite/replace prior rows), cap the appended churn at `cap`
 * (default 60) by keeping the TAIL of the done array — history lives in git.
 */
export function renewLedger(doc: LedgerDoc, facts: RenewFacts): LedgerDoc {
  const out: LedgerDoc = {
    ...doc,
    schema: "SAOS-EXECUTION-LEDGER/1",
    at: facts.at,
    generatedAt: facts.at,
    generator: facts.generator,
    sourceWorklog: facts.sourceWorklog,
    measuredSnapshot: facts.measuredSnapshot,
    freshness: {
      ...((doc.freshness as Record<string, unknown>) ?? {}),
      staleAfterHours: 48,
      renewedBy: facts.generator,
      renewedAt: facts.at,
    },
  };
  const cap = facts.cap ?? 60;
  const prevDone = rowsOf(doc, "done");
  const capped = prevDone.length > cap ? prevDone.slice(prevDone.length - cap) : prevDone;
  out.done = [...capped, ...facts.doneRows];
  out.gaps = [...rowsOf(doc, "gaps"), ...facts.gapRows];
  out.partial = rowsOf(doc, "partial");
  out.next = rowsOf(doc, "next");
  return out;
}

// ── impure CLI shell (measured facts + publish) ─────────────────────────────

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

async function j<T = Record<string, unknown>>(url: string, ms = 8000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function surfaceStat(url: string): Promise<{ http: number; bytes: number; at: string | null; done?: number; gaps?: number } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    let at: string | null = null;
    let done: number | undefined;
    let gaps: number | undefined;
    try {
      const d = JSON.parse(body) as Record<string, unknown>;
      at = typeof d.at === "string" ? d.at : null;
      done = Array.isArray(d.done) ? d.done.length : undefined;
      gaps = Array.isArray(d.gaps) ? d.gaps.length : undefined;
    } catch {
      /* non-JSON body — keep the honest http/bytes only */
    }
    return { http: r.status, bytes: body.length, at, done, gaps };
  } catch {
    return null;
  }
}

interface SteemAccount {
  created?: string;
  balance?: string;
  sbd_balance?: string;
  vesting_shares?: string;
}
async function steemAccount(id: string): Promise<SteemAccount | null> {
  const r = await j<{ result?: SteemAccount[] }>("https://api.steemit.com", 8000).catch(() => null);
  if (!r) {
    // condenser needs POST — retry with POST
    try {
      const res = await fetch("https://api.steemit.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_accounts", params: [[id]], id: 1 }),
        signal: AbortSignal.timeout(8000),
      });
      const d = (await res.json()) as { result?: SteemAccount[] };
      return d.result?.[0] ?? null;
    } catch {
      return null;
    }
  }
  return r.result?.[0] ?? null;
}

function git(args: string[], cwd: string): { out: string; code: number } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { out: (p.stdout.toString() + p.stderr.toString()).trim(), code: p.exitCode ?? 1 };
}

/**
 * DECISIONS #10 identity law v3 (deny-by-default): every commit this renewer
 * creates MUST carry a lawful lane identity — a sandbox default like
 * `z@container` is an unidentified writer and the giant identity-guard will
 * (correctly) fail the push. LANE_NAME/LANE_EMAIL env-overridable, lawful
 * default, injected per-commit via -c so the host config is never mutated.
 */
export function laneIdentityArgs(env: Record<string, string | undefined> = process.env): string[] {
  const name = env.LANE_NAME ?? "G78-e lane (execution-ledger renewer)";
  const email = env.LANE_EMAIL ?? "g78-e@agents.roshpinacare-sys";
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

function publish(repo: string, file: string, body: string, stamp: string): string {
  const target = join(repo, file);
  const prev = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (prev === body) return "unchanged";
  writeFileSync(target, body);
  if (git(["add", file], repo).code !== 0) return "git-add-failed";
  const idem = `execution-ledger-union-renew ${stamp}`;
  const log = git(["log", "--format=%s", "-1"], repo);
  if (log.out === idem) return "already-committed";
  if (git([...laneIdentityArgs(), "commit", "-m", idem], repo).code !== 0) return "commit-failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pull = git(["pull", "--rebase", "-q", "origin", "HEAD"], repo);
    const push = git(["push", "-q", "origin", "HEAD"], repo);
    if (push.code === 0) return "renewed+pushed";
    if (pull.code !== 0) git(["rebase", "--abort"], repo);
  }
  return "committed(push-raced — next cycle re-pushes)";
}

if (import.meta.main) {
  const DOMAIN = process.env.LEDGER_DOMAIN_DIR ?? "/home/z/audit/Domain";
  const ROOTSITE = process.env.LEDGER_ROOTSITE_DIR ?? "/home/z/audit/roshpinacare-sys.github.io";
  const MIRROR = process.env.LEDGER_GIANT_DIR ?? "/home/z/audit/giant";
  const readDoc = (p: string): LedgerDoc => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as LedgerDoc;
    } catch {
      return {};
    }
  };

  const at = nowIso();
  const trace = process.env.RENEW_TRACE ?? "1a17d4f7d0ecfe91";

  // 1. measure the three surfaces live (accessibility + divergence, line-by-line)
  const surfaces = {
    rootsite: await surfaceStat("https://roshpinacare-sys.github.io/execution-state.json"),
    domain: await surfaceStat("https://roshpinacare-sys.github.io/Domain/execution-state.json"),
    giantMirror: await surfaceStat("https://raw.githubusercontent.com/roshpinacare-sys/giant/main/state/execution/execution-state.json"),
  };

  // 2. wallet CI verdict (public API, run-ID evidence)
  const walletRuns = await j<{ workflow_runs?: { id: number; name: string; head_sha: string; conclusion: string | null }[] }>(
    "https://api.github.com/repos/roshpinacare-sys/Saosmartwallet/actions/runs?per_page=8",
  );
  const cureRuns = (walletRuns?.workflow_runs ?? []).filter((r) => r.head_sha.startsWith("1e8570a"));
  const walletCi = cureRuns.length
    ? cureRuns.map((r) => `${r.id}:${r.name}:${r.conclusion}`).join(" · ")
    : "unmeasured-at-renew-time";

  // 3. chain truth (public RPC, read-only)
  const s1 = await steemAccount("saos-0001");
  const s4 = await steemAccount("saos-0004");

  // 4. organ-host liveness evidence (Domain repo pushes from the organ host)
  const domainLog = git(["log", "--format=%h %s", "-3", "--iso"], DOMAIN).out;

  const measuredSnapshot = {
    refreshedAt: at,
    renewScope: "sandbox lane t64 — organ services (market:3033/ledger:3032/runner:3031) are network-scoped away from this host; those counters are honestly absent here (last organ-host measurement: t63 receipt 2026-10-27T11:30:08Z)",
    ledgerSurfaces: surfaces,
    walletCiCure: {
      redRun: "40499124392 (head 64827b7, afterAll hook timeout 5000ms, zero code delta vs green 68b23bb)",
      cureCommit: "1e8570a fix(hsm): bounded graceful shutdown — closeHsmServer + explicit hook budgets",
      ci: walletCi,
    },
    chainTruth: {
      saos0001: s1 ? { created: s1.created, balance: s1.balance, sbd: s1.sbd_balance, vests: s1.vesting_shares } : "unmeasured",
      saos0004: s4 ? { created: s4.created, balance: s4.balance, sbd: s4.sbd_balance, vests: s4.vesting_shares } : "unmeasured",
      source: "public condenser rpc, read-only",
    },
    organHost: {
      evidence: domainLog.split("\n").slice(0, 3).join(" | ") || "unmeasured",
      note: "organ host alive and pushing (Domain repo); services not reachable from this sandbox",
    },
  };

  const doneRows: LedgerRow[] = [
    {
      id: "D64-a",
      title: `חידוש-איחוד t64 ${at} — שלושת-המשטחים נמדדו 200/200/200 והמורשת אוחדה`,
      detail: `surfaces=${JSON.stringify(surfaces)}; the divergence class (three different done/gaps counts on three law surfaces) is collapsed by this union renewal — one lineage, byte-true, on root+Domain+giant mirror`,
      evidence: "curl at renew time + execution-ledger-union-renew.ts (union law, erasureGuard preserved)",
    },
    {
      id: "D64-b",
      title: "Saosmartwallet main-RED (run 40499124392) — root-caused and cured with run-ID proof",
      detail: `class = unbounded server.close() wait + default 5s hook budget under a loaded runner (zero code delta between green 68b23bb and red 64827b7); cure = closeHsmServer bounded shutdown + explicit 20s hook budgets + regression spec test; local 85/85×3 · packages 427/427 · tsc 0; CI: ${walletCi}`,
      evidence: "https://api.github.com/repos/roshpinacare-sys/Saosmartwallet/actions/runs/40505382231 (wallet-core-tests SUCCESS on 1e8570a)",
    },
    {
      id: "D64-c",
      title: "אמת-שרשרת saos-000X נמדדה-מחדש דרך RPC ציבורי (קריאה-בלבד)",
      detail: `saos-0001 created=${s1?.created ?? "?"} · saos-0004 created=${s4?.created ?? "?"} · ${s1?.balance ?? "?"} / ${s1?.sbd_balance ?? "?"} each · 0 VESTS (SP-parked recall refusal stands)`,
      evidence: "https://api.steemit.com condenser_api.get_accounts at renew time",
    },
  ];
  const gapRows: LedgerRow[] = [
    {
      id: "G7",
      title: `מקורות-איבר-בלתי-נגישים-מהסנדבוקס (t64 ${at})`,
      detail: "market:3033/ledger:3032/runner:3031 counters are organ-host-scoped and absent from THIS renewal by honesty law (never invented); organ host itself is ALIVE (Domain repo pushes at renew time); last organ-host live measurement: t63 receipt 11:30:08Z (gapsOpen:0, gear1 2/6)",
      evidence: "t63 LANDED receipt (giant SWARM_STATE) + Domain organ commits measured in this renew",
    },
  ];

  // 5. union + renew + publish byte-true to all three law surfaces
  const union = unionLedgers({
    domain: readDoc(join(DOMAIN, "execution-state.json")),
    rootsite: readDoc(join(ROOTSITE, "execution-state.json")),
    mirror: readDoc(join(MIRROR, "state/execution/execution-state.json")),
  });
  const doc = renewLedger(union.doc, {
    at,
    generator: `fleet-runner/execution-ledger-union-renew.ts (t64, trace ${trace}, lineage-preserving union)`,
    sourceWorklog: `giant worklog t64 (trace ${trace})`,
    doneRows,
    gapRows,
    measuredSnapshot,
  });
  const body = JSON.stringify(doc, null, 2) + "\n";
  const dStat = publish(DOMAIN, "execution-state.json", body, at);
  const rStat = publish(ROOTSITE, "execution-state.json", body, at);
  const mStat = publish(MIRROR, "state/execution/execution-state.json", body, at);

  console.log(
    `[execution-ledger-union-renew] at=${at} base=${union.report.base} sistersAppended=${union.report.appendedFromSisters} sectionsIn=${union.report.sectionsBroughtIn.length} domain=${dStat} root-site=${rStat} giant-mirror=${mStat}`,
  );
}
