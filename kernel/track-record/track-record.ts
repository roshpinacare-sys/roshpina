/**
 * lib/track-record/track-record.ts — Verified Track Record (the breakthrough primitive).
 *
 * From TFA_breakthrough_research.md: the system's real asset is the VERIFIED TRACK RECORD, and the
 * possible world-first is TRUST PRICE DISCOVERY — an agent's earned authority derived from provable
 * history. This module is step one: a pure READ-MODEL over the signed audit chain. It writes
 * nothing, asserts nothing new — it only AGGREGATES what the hash-chained, signed records already
 * prove. Therefore it inherits the chain's integrity: you cannot fake a track record without
 * breaking signatures.
 *
 * Derivation rules (conservative, fail-closed):
 *   • Only records of the requested tenant are read (isolation).
 *   • "settled"   = escrow.release allowed actions where the identity was the WORKER (they delivered)
 *                   — and separately counted where they were the FUNDER (they paid as promised).
 *   • "refunded"  = escrow.refund allowed actions touching the identity.
 *   • "denied"    = any action sourced by the identity that policy denied (kept on the record —
 *                   accountability includes what you TRIED).
 *   • score ∈ [0,100]: starts at 50 (unknown ≠ trusted), rises with settled volume+count,
 *                   falls with denials. Deterministic, explainable, recomputable by anyone
 *                   from the same chain — no hidden state, no ML, no gaming surface.
 */
import type { AuditRecord } from "../orchestrator/types";
import { buildDelegationChain } from "../agent-identity/delegation";
import type { IdentityStore } from "../agent-identity/types";

/**
 * Resolver for looking up the owner identity of a ledger account.
 * Returns the ownerId (identity id) or null if unknown.
 * Pass this from the route layer where ledger access is available.
 */
export type AccountOwnerResolver = (
  tenantId: string,
  accountId: string,
) => Promise<string | null>;

export interface TrackRecord {
  tenantId: string;
  identityId: string;
  /** escrows the identity completed as worker (got paid on completion) */
  settledAsWorker: number;
  /** escrows the identity honored as funder (paid out on completion) */
  settledAsFunder: number;
  /** escrows refunded (cancelled) involving the identity */
  refunded: number;
  /** actions sourced by the identity that policy denied */
  denied: number;
  /** total μ¢ moved in settlements involving the identity (as string for JSON) */
  settledVolume: string;
  /** deterministic trust score 0-100; 50 = no history */
  score: number;
  /** how the score was computed — transparency is the product */
  explanation: string[];
  /**
   * Number of settlements detected as self-dealing (funder and worker share the same
   * delegation root). Self-dealing settlements do NOT raise the score — they are
   * counted here for transparency but excluded from the positive scoring factors.
   */
  selfDealing: number;
  computedAt: string;
}

export interface ChainReader { getChain(tenantId: string): AuditRecord[]; }
export interface EscrowReader { list(tenantId: string): Promise<Array<{
  state: string; amount: bigint; fundedBy?: string;
  payerAccountId: string; workerAccountId: string;
}>>; }

/**
 * Compute the verified track record for one identity within one tenant.
 * Sources of truth (both already signed/recorded):
 *   • escrow agreements — settlement outcomes (state, fundedBy, parties, amount, auditIds)
 *   • audit chain      — denied attempts sourced by the identity
 * Pure read-model: anyone with the same data reproduces the same score.
 */
/**
 * Options for anti-gaming detection.
 * Both fields are optional; omitting them skips self-dealing detection (backward-compatible).
 */
export interface TrackRecordOptions {
  /**
   * Resolves a ledger account id → identity owner id.
   * Required for self-dealing detection: the worker's identity is derived from their account owner.
   */
  accountOwnerResolver?: AccountOwnerResolver;
  /**
   * Identity store for delegation chain root lookup.
   * When provided, funder and worker roots are compared up the delegation tree.
   * When omitted, only direct identity equality is checked.
   */
  identityStore?: IdentityStore;
}

export async function computeTrackRecord(
  chain: ChainReader,
  escrows: EscrowReader,
  tenantId: string,
  identityId: string,
  opts: TrackRecordOptions = {},
): Promise<TrackRecord> {
  if (!tenantId || !identityId) {
    throw new Error("computeTrackRecord: tenantId and identityId are required");
  }
  let settledAsWorker = 0, settledAsFunder = 0, refunded = 0, denied = 0, selfDealing = 0;
  let volume = 0n;
  const { accountOwnerResolver, identityStore } = opts;

  /**
   * Per-call memoization cache for ownerOf: accountId → resolved owner Promise.
   * Deduplicates repeated async resolver calls within one computeTrackRecord invocation.
   * An agent appearing as worker in N escrows incurs one resolver call, not N.
   */
  const ownerCache = new Map<string, Promise<string>>();

  /**
   * Per-call memoization cache for getRoot: identityId → delegation root id.
   * Avoids re-traversing the full delegation chain for the same identity.
   */
  const rootCache = new Map<string, string>();

  /**
   * Get the delegation-chain root (human) id for a given identity.
   * Returns the identity itself when no IdentityStore is available.
   * Result is memoized within this invocation — same id → single traversal.
   */
  function getRoot(id: string): string {
    if (!identityStore || !id) return id;
    const cached = rootCache.get(id);
    if (cached !== undefined) return cached;
    const delegChain = buildDelegationChain(identityStore, id, tenantId);
    const root = (!delegChain || delegChain.length === 0) ? id : delegChain[delegChain.length - 1].id;
    rootCache.set(id, root);
    return root;
  }

  // Resolve an account id to its owning identity (account-identity vs actor-identity: the report's
  // semantic-drift fix). track-record keys on ACTOR identity throughout; accounts are mapped to
  // their owner before any comparison. Falls back to the raw id when no resolver is wired.
  // Result is Promise-memoized within this invocation — same accountId → single resolver call.
  const ownerOf = (accountId: string): Promise<string> => {
    const cached = ownerCache.get(accountId);
    if (cached !== undefined) return cached;
    if (!accountOwnerResolver) {
      const p = Promise.resolve(accountId);
      ownerCache.set(accountId, p);
      return p;
    }
    const p = accountOwnerResolver(tenantId, accountId).then(owner => owner ?? accountId);
    ownerCache.set(accountId, p);
    return p;
  };

  for (const a of await escrows.list(tenantId)) {
    const amt = typeof a.amount === "bigint" ? a.amount : BigInt(String(a.amount));
    const workerOwner = await ownerOf(a.workerAccountId);
    const payerOwner = await ownerOf(a.payerAccountId);
    if (a.state === "released") {
      // Anti-gaming: funder and worker sharing a delegation root = self-dealing → does NOT raise score.
      const isSelfDealing = !!a.fundedBy && getRoot(a.fundedBy) === getRoot(workerOwner);
      if (isSelfDealing) {
        selfDealing++;
      } else {
        if (a.fundedBy === identityId) { settledAsFunder++; volume += amt; }
        if (workerOwner === identityId) { settledAsWorker++; volume += amt; }
      }
    } else if (a.state === "refunded") {
      if (a.fundedBy === identityId || workerOwner === identityId || payerOwner === identityId) refunded++;
    }
  }
  for (const rec of chain.getChain(tenantId)) {
    const src = String((rec as unknown as { source?: unknown }).source ?? "");
    if (rec.outcome === "denied" && src === identityId) denied++;
  }

  // Deterministic, explainable scoring. Unknown = 50, not 0 and not 100.
  const explanation: string[] = ["base 50 (no assumed trust)"];
  let score = 50;
  const settleCount = settledAsWorker + settledAsFunder;
  if (settleCount > 0) {
    const settleBoost = Math.min(35, settleCount * 5);
    score += settleBoost;
    explanation.push(`+${settleBoost} for ${settleCount} settled escrow(s)`);
  }
  if (volume > 0n) {
    // log-ish volume boost: +1 per order of magnitude above 10,000 μ¢ ($1), capped at +10
    let mag = 0; let v = volume;
    while (v >= 10000n && mag < 10) { v /= 10n; mag++; }
    if (mag > 0) { score += mag; explanation.push(`+${mag} for settled volume ${volume} μ¢`); }
  }
  if (refunded > 0) {
    const pen = Math.min(10, refunded * 2);
    score -= pen;
    explanation.push(`-${pen} for ${refunded} refunded escrow(s)`);
  }
  if (denied > 0) {
    const pen = Math.min(25, denied * 5);
    score -= pen;
    explanation.push(`-${pen} for ${denied} policy denial(s)`);
  }
  score = Math.max(0, Math.min(100, score));

  return {
    tenantId, identityId,
    settledAsWorker, settledAsFunder, refunded, denied,
    settledVolume: volume.toString(),
    selfDealing,
    score, explanation,
    computedAt: new Date().toISOString(),
  };
}
