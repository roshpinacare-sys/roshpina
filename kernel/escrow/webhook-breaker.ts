/**
 * lib/escrow/webhook-breaker.ts — the circuit breaker state machine (K3, v145).
 * Since K4 (v146) it guards TWO arteries: the outbound webhook lane (K3,
 * per-registration) and the external settlement-rail lane (K4, per-tenant|rail
 * — wired inside SettlementService.disburse).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Dispatch is the artery every outbound byte flows through (K2). A dead or
 * malicious endpoint today absorbs unlimited consecutive failed deliveries —
 * a retry storm waiting for the route layer, and an attacker's cheapest way to
 * fill the delivery log and stall workers. K3 trips a per-registration breaker:
 * after N consecutive failed deliveries the registration OPENS (dispatch
 * refuses WITHOUT touching the gate or the transport, loudly, with a receipt
 * in the delivery log); after a cooldown it allows exactly ONE probe
 * (half-open); success closes, failure re-opens with a fresh cooldown.
 *
 * DNA (honest): this is the classic circuit-breaker state machine, sharpened
 * for our artery — NOT copied from coinbase/agentkit (verified dive 2026-10-14:
 * no breaker in the core — the spend-cap pattern there is on-chain spend
 * permissions). The breaker-shape was described by AutarchDistrict's README
 * (content-correct, framework-inflated — verdict of Task 25); the state machine
 * here is our own law with measured semantics.
 *
 * Law:
 *   • Fail-closed: an OPEN breaker refuses — it never "tries anyway".
 *   • Loud: every refusal is recordable; the service writes the refusal into
 *     the delivery log (never silent).
 *   • One probe in half-open: concurrent dispatches cannot stampede the probe
 *     (probeUsed flag under the single-threaded event loop).
 *   • Success resets completely — a recovered endpoint is trusted again.
 *   • `now` is injectable so time is measurable, not slept.
 *   • K4 addition: `peekDecision` answers "would a probe be granted right
 *     now?" WITHOUT consuming it — a caller that only wants to refuse loudly
 *     (K4 retryDisburse) asks without eating the half-open probe. The artery
 *     gate (canAttempt) remains the single probe-granter.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerDecision {
  state: BreakerState;
  allowed: boolean;
  /** Why a refusal happened (present only when allowed=false). */
  reason?: "circuit_breaker_open";
  /** ISO time the breaker opened (present when open/half-open). */
  since?: string;
  /** Consecutive failures counted so far (present when open/half-open). */
  consecutiveFailures?: number;
}

export interface BreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  threshold?: number;
  /** Cool-down before a single half-open probe is allowed. Default 15 min. */
  cooldownMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
}

interface BreakerCell {
  consecutiveFailures: number;
  state: BreakerState;
  openedAt: number | null;
  probeUsed: boolean;
}

export class ConsecutiveFailuresBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly cells = new Map<string, BreakerCell>();

  constructor(opts: BreakerOptions = {}) {
    const t = opts.threshold ?? 5;
    const c = opts.cooldownMs ?? 15 * 60_000;
    if (!Number.isInteger(t) || t < 1) {
      throw new Error(`breaker threshold must be an integer ≥1 (got ${t}) — a breaker that never trips is decoration`);
    }
    if (!Number.isFinite(c) || c < 0) {
      throw new Error(`breaker cooldownMs must be a finite number ≥0 (got ${c})`);
    }
    this.threshold = t;
    this.cooldownMs = c;
    this.now = opts.now ?? Date.now;
  }

  /** Consult before touching the gate or the transport. */
  canAttempt(registrationId: string): BreakerDecision {
    const cell = this.cells.get(registrationId);
    if (!cell || cell.state === "closed") return { state: "closed", allowed: true };
    const elapsed = this.now() - (cell.openedAt ?? 0);
    if (cell.state === "open" && elapsed >= this.cooldownMs && !cell.probeUsed) {
      // exactly one probe — concurrent callers see probeUsed immediately
      cell.probeUsed = true;
      return {
        state: "half-open",
        allowed: true,
        since: new Date(cell.openedAt ?? 0).toISOString(),
        consecutiveFailures: cell.consecutiveFailures,
      };
    }
    return {
      state: "open",
      allowed: false,
      reason: "circuit_breaker_open",
      since: new Date(cell.openedAt ?? 0).toISOString(),
      consecutiveFailures: cell.consecutiveFailures,
    };
  }

  /**
   * Non-consuming consult: identical verdict to canAttempt, but NEVER mutates
   * probeUsed. Safe to ask from outside the artery (K4 retryDisburse refuses
   * loudly from here while the actual probe is granted only by canAttempt at
   * the disburse gate).
   */
  peekDecision(registrationId: string): BreakerDecision {
    const cell = this.cells.get(registrationId);
    if (!cell || cell.state === "closed") return { state: "closed", allowed: true };
    const elapsed = this.now() - (cell.openedAt ?? 0);
    if (cell.state === "open" && elapsed >= this.cooldownMs && !cell.probeUsed) {
      return {
        state: "half-open",
        allowed: true,
        since: new Date(cell.openedAt ?? 0).toISOString(),
        consecutiveFailures: cell.consecutiveFailures,
      };
    }
    return {
      state: "open",
      allowed: false,
      reason: "circuit_breaker_open",
      since: new Date(cell.openedAt ?? 0).toISOString(),
      consecutiveFailures: cell.consecutiveFailures,
    };
  }

  /** A delivery succeeded — fully reset (a recovered endpoint is trusted again). */
  recordSuccess(registrationId: string): void {
    this.cells.delete(registrationId);
  }

  /** A delivery failed — count it; trip when the threshold is crossed; re-open on a failed probe. */
  recordFailure(registrationId: string): BreakerDecision {
    const cell = this.cells.get(registrationId) ?? { consecutiveFailures: 0, state: "closed" as BreakerState, openedAt: null, probeUsed: false };
    if (cell.state === "open" || (cell.state === "half-open" && cell.probeUsed)) {
      // failed probe (or refusal-adjacent bookkeeping): re-open with a fresh cooldown
      cell.state = "open";
      cell.openedAt = this.now();
      cell.probeUsed = false;
      this.cells.set(registrationId, cell);
      return { state: "open", allowed: false, reason: "circuit_breaker_open", since: new Date(cell.openedAt).toISOString(), consecutiveFailures: cell.consecutiveFailures };
    }
    cell.consecutiveFailures += 1;
    if (cell.consecutiveFailures >= this.threshold) {
      cell.state = "open";
      cell.openedAt = this.now();
      cell.probeUsed = false;
    }
    this.cells.set(registrationId, cell);
    return {
      state: cell.state,
      allowed: cell.state !== "open",
      ...(cell.state === "open" ? { reason: "circuit_breaker_open" as const, since: new Date(cell.openedAt ?? 0).toISOString(), consecutiveFailures: cell.consecutiveFailures } : {}),
    };
  }

  /** Direct read for receipts/tests — never mutates. */
  peek(registrationId: string): BreakerState {
    return this.cells.get(registrationId)?.state ?? "closed";
  }
}
