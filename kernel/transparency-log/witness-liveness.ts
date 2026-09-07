/**
 * lib/transparency-log/witness-liveness.ts — witness liveness/staleness monitor.
 *
 * WHY THIS EXISTS (TRUST_INTEGRITY_ROADMAP.md §2.D-12)
 * -----------------------------------------------------
 * Quorum (witness.ts, v387) tells you whether ENOUGH witnesses signed a given
 * root. It says nothing about whether a SPECIFIC registered witness has gone
 * quiet. A witness that stops signing recent roots is a signal worth raising
 * on its own — either it has failed operationally, or (more concerning) it is
 * colluding with the log operator to selectively withhold co-signatures on a
 * root it would otherwise contest. Liveness closes that gap: for every
 * registered witness, how long ago did we last see a STATEMENT THAT ACTUALLY
 * VERIFIES, and is that within an acceptable freshness window?
 *
 * DESIGN
 * ------
 * • Pure function: no I/O, no in-process state — same shape as
 *   runConsistencyMonitor. `WitnessRegistry.checkLiveness()` is the thin
 *   stateful wrapper, mirroring how `quorumFor` wraps `collectWitnessQuorum`.
 * • Zero-trust-in-prover: a statement only counts toward a witness's
 *   liveness if it independently verifies against that witness's registered
 *   key (resolveSigner + verifyWitnessStatement) — the same trust model as
 *   collectWitnessQuorum. An unverified statement proves nothing about who
 *   actually produced it, so it cannot be used to mask staleness.
 * • FAIL-CLOSED:
 *     - A registered witness with NO verified statement observed is "stale"
 *       (never "live" by default/vacuous truth) — silence is the exact
 *       failure mode this module exists to catch.
 *     - A statement timestamped in the FUTURE relative to `now` is ignored
 *       when computing "most recent observation" — a forged or clock-skewed
 *       future timestamp must never be used as proof of freshness.
 *     - Invalid `maxAgeMs` (not a positive finite number) throws rather than
 *       silently picking a default window that could mask staleness.
 * • Zero external dependencies (reuses witness.ts's own verify primitive).
 */

import type { Signer } from "../orchestrator/types";
import { verifyWitnessStatement, type WitnessStatement } from "./witness";

/** Per-witness liveness status. */
export interface WitnessLivenessStatus {
  witnessId: string;
  /** ISO-8601 timestamp of the most recent VERIFIED statement, or null if none was ever observed. */
  lastObservedAt: string | null;
  /** treeSize carried by that most recent verified statement, or null. */
  lastTreeSize: number | null;
  /** Milliseconds between `now` and lastObservedAt. null when never observed. */
  ageMs: number | null;
  /** True iff the witness has a verified observation within maxAgeMs. A witness that never signed is never live. */
  live: boolean;
}

/** Aggregate liveness report for a set of registered witnesses. */
export interface WitnessLivenessReport {
  /** The `now` the check was evaluated against (ISO-8601). */
  checkedAt: string;
  /** The freshness window that was enforced. */
  maxAgeMs: number;
  /** One status per (deduplicated) registered witnessId, sorted by witnessId. */
  statuses: WitnessLivenessStatus[];
  /** witnessIds that are NOT live — the failure/collusion signal. */
  staleWitnessIds: string[];
  /** True iff every registered witness is live (staleWitnessIds is empty). Vacuously true with zero registered witnesses. */
  allLive: boolean;
}

export interface WitnessLivenessOptions {
  /** Freshness window in milliseconds — must be a positive finite number. */
  maxAgeMs: number;
  /** Evaluation clock; defaults to `new Date()`. */
  now?: Date;
  /** When set, only statements for this logId count toward liveness (mirrors collectWitnessQuorum's log scoping). */
  logId?: string;
}

export type WitnessLivenessErrorCode = "BAD_INPUT";

export class WitnessLivenessError extends Error {
  readonly code: WitnessLivenessErrorCode;
  constructor(code: WitnessLivenessErrorCode, message: string) {
    super(message);
    this.name = "WitnessLivenessError";
    this.code = code;
  }
}

/**
 * Determine, for each registered witness, whether it has a verified
 * statement within `opts.maxAgeMs` of `opts.now`.
 *
 * @param registeredWitnessIds  every witness the operator currently trusts
 *   for this scope (deduplicated internally; order does not matter).
 * @param statements  candidate statements to search for evidence of
 *   liveness (e.g. WitnessRegistry's stored statements for the tenant).
 * @param resolveSigner  maps a witnessId to its verifying Signer, or null if
 *   unknown — exactly the callback shape collectWitnessQuorum uses.
 */
export function checkWitnessLiveness(
  registeredWitnessIds: string[],
  statements: WitnessStatement[],
  resolveSigner: (witnessId: string) => Signer | null,
  opts: WitnessLivenessOptions,
): WitnessLivenessReport {
  if (!Array.isArray(registeredWitnessIds)) {
    throw new WitnessLivenessError("BAD_INPUT", "checkWitnessLiveness: registeredWitnessIds must be an array");
  }
  if (!Array.isArray(statements)) {
    throw new WitnessLivenessError("BAD_INPUT", "checkWitnessLiveness: statements must be an array");
  }
  if (typeof resolveSigner !== "function") {
    throw new WitnessLivenessError("BAD_INPUT", "checkWitnessLiveness: resolveSigner must be a function");
  }
  const maxAgeMs = opts?.maxAgeMs;
  if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new WitnessLivenessError("BAD_INPUT", "checkWitnessLiveness: opts.maxAgeMs must be a positive finite number");
  }
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new WitnessLivenessError("BAD_INPUT", "checkWitnessLiveness: opts.now must be a valid Date");
  }
  const nowMs = now.getTime();

  // Most recent VERIFIED observation per witnessId — single pass over statements.
  const mostRecent = new Map<string, { observedAt: string; observedMs: number; treeSize: number }>();

  for (const st of statements) {
    if (!st || typeof st.witnessId !== "string") continue;
    if (opts.logId !== undefined && st.logId !== opts.logId) continue;

    const observedMs = Date.parse(st.observedAt);
    if (!Number.isFinite(observedMs)) continue; // malformed timestamp → not usable evidence
    if (observedMs > nowMs) continue; // future-dated → never proof of freshness (clock-skew/forgery guard)

    const signer = resolveSigner(st.witnessId);
    if (!signer) continue; // unregistered witness → cannot attribute liveness to it
    if (!verifyWitnessStatement(st, signer)) continue; // unverified → proves nothing

    const prev = mostRecent.get(st.witnessId);
    if (!prev || observedMs > prev.observedMs) {
      mostRecent.set(st.witnessId, { observedAt: st.observedAt, observedMs, treeSize: st.treeSize });
    }
  }

  const dedupedIds = [...new Set(registeredWitnessIds)].sort();

  // Single pass: build each status and accumulate staleWitnessIds together,
  // instead of statuses.filter(!live).map(id) (two extra full scans of
  // `statuses` after the map that built it).
  const statuses: WitnessLivenessStatus[] = [];
  const staleWitnessIds: string[] = [];

  for (const witnessId of dedupedIds) {
    const seen = mostRecent.get(witnessId);
    let status: WitnessLivenessStatus;
    if (!seen) {
      status = { witnessId, lastObservedAt: null, lastTreeSize: null, ageMs: null, live: false };
    } else {
      const ageMs = nowMs - seen.observedMs;
      status = {
        witnessId,
        lastObservedAt: seen.observedAt,
        lastTreeSize: seen.treeSize,
        ageMs,
        live: ageMs <= maxAgeMs,
      };
    }
    statuses.push(status);
    if (!status.live) staleWitnessIds.push(status.witnessId);
  }

  return {
    checkedAt: now.toISOString(),
    maxAgeMs,
    statuses,
    staleWitnessIds,
    allLive: staleWitnessIds.length === 0,
  };
}
