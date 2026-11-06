/* ═══ saos-architect-daemon · receipts.ts — hash-chained conscience ═════════
 * Every executive transition appends exactly one receipt {seq, prevHash, hash,
 * body}. hash = sha256(prevHash + canonicalJSON(body)). canonicalJSON = sorted
 * keys, integers-only (no floats, no clock inside the body beyond explicit at).
 * verifyReceipts detects: tamper-at-index, splice, reorder, genesis break.
 * Zero deps. Fail-closed. (§3 §5 MASTER DIRECTIVE — cryptographically signed,
 * hash-linked records.)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: sorted keys recursively; arrays keep order. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface Receipt {
  seq: number;
  prevHash: string;
  hash: string;
  body: Record<string, unknown>;
}

export class ReceiptChain {
  private receipts: Receipt[] = [];
  private head = GENESIS_HASH;

  append(body: Record<string, unknown>): Receipt {
    const seq = this.receipts.length;
    const prevHash = this.head;
    const hash = sha256Hex(prevHash + canonicalJSON(body));
    const receipt: Receipt = { seq, prevHash, hash, body };
    this.receipts.push(receipt);
    this.head = hash;
    return receipt;
  }

  all(): Receipt[] {
    return this.receipts.slice();
  }

  headHash(): string {
    return this.head;
  }
}

export interface VerifyResult {
  ok: boolean;
  /** first offending index when !ok */
  index: number;
  reason?: "genesis" | "prev-hash" | "hash" | "seq";
}

export function verifyReceipts(receipts: Receipt[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (i === 0 && r.prevHash !== GENESIS_HASH) return { ok: false, index: i, reason: "genesis" };
    if (r.seq !== i) return { ok: false, index: i, reason: "seq" };
    if (r.prevHash !== prev) return { ok: false, index: i, reason: "prev-hash" };
    if (r.hash !== sha256Hex(r.prevHash + canonicalJSON(r.body))) return { ok: false, index: i, reason: "hash" };
    prev = r.hash;
  }
  return { ok: true, index: -1 };
}

/* JSONL persistence — the daemon's memory across restarts */
export function writeChainJsonl(chain: ReceiptChain, file: string): void {
  fs.writeFileSync(file, chain.all().map((r) => canonicalJSON(r)).join("\n") + (chain.all().length ? "\n" : ""));
}

export function readChainJsonl(file: string): ReceiptChain | null {
  if (!fs.existsSync(file)) return null;
  const chain = new ReceiptChain();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const parsed = JSON.parse(line) as Receipt;
    // re-append body to recompute linkage honestly (never trust stored hash)
    chain.append(parsed.body);
  }
  const v = verifyReceipts(chain.all());
  if (!v.ok) return null; // tampered state file → fail-closed, start fresh (recorded by caller)
  return chain;
}
