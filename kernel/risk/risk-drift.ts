/**
 * lib/risk/risk-drift.ts — Predictive risk drift (§2.C sub-step 7).
 *
 * WHAT THIS IS
 * ------------
 * `scoreRiskDrift` detects a *trend* in an agent's trust score before the
 * score itself crosses a threshold. The today-signal (`scoreContextualRisk`)
 * sees a point; this module sees the slope.
 *
 * Algorithm: Ordinary Least Squares linear regression over a caller-supplied
 * window of `DriftRecord` items {score, timestampMs}. The OLS slope in
 * (score-units / ms) is scaled by the observation window span to produce a
 * dimensionless `rawTrend` in [−window, +window] score points. That is clamped
 * to [-100, 100] and negated into a `driftScore` where:
 *   • positive driftScore → score is falling → deteriorating
 *   • negative driftScore → score is rising  → improving
 *
 * MONOTONIC (same invariant as scoreContextualRisk)
 * -------------------------------------------------
 * `driftEscalation` can only escalate above "auto". A caller who joins this
 * with a static base class must use `maxApproval(base, driftEscalation)`.
 *
 * FAIL-CLOSED
 * -----------
 * • < 2 records             → throw (cannot compute slope from a single point)
 * • non-number / NaN score  → throw
 * • score out of [0, 100]   → throw
 * • non-number timestampMs  → throw
 * • all identical timestamps → slope = 0, direction = "stable" (no divide-by-zero)
 * • null / non-array input  → throw
 *
 * Zero external dependencies.
 */

import type { ApprovalClass } from "../orchestrator/types";

/** One historical trust-score sample. */
export interface DriftRecord {
  /** Trust score at this moment in [0, 100]. */
  score: number;
  /** Unix epoch in milliseconds. Must be a finite number. */
  timestampMs: number;
}

export interface DriftFactor {
  factor: string;
  /** Contribution to the final drift score (positive = more risk). */
  contribution: number;
  detail: string;
}

export interface RiskDriftResult {
  /**
   * Drift score in [−100, 100].
   *   > 0  → trust score is on a falling trend  (deteriorating, higher risk)
   *   < 0  → trust score is on a rising trend   (improving, lower risk)
   *   = 0  → flat / stable
   */
  driftScore: number;
  direction: "improving" | "stable" | "deteriorating";
  /**
   * The minimum approval class that drift alone warrants.
   * Monotonic: join with your static base via maxApproval(base, driftEscalation).
   */
  driftEscalation: ApprovalClass;
  /** How many records were used. */
  windowSize: number;
  /** Span of the observation window in milliseconds. */
  windowSpanMs: number;
  /** OLS slope in score-points per millisecond (raw, unscaled). */
  slopePerMs: number;
  factors: DriftFactor[];
  explanation: string[];
}

/** driftScore thresholds (all inclusive). Mirrors the contextual-risk velocity thresholds. */
const DRIFT_HUMAN_THRESHOLD = 25;
const DRIFT_ESCROW_THRESHOLD = 55;
const DRIFT_DENY_THRESHOLD = 80;

/** Direction bands. */
const IMPROVING_THRESHOLD = 15;  // driftScore < -15 → clearly improving
const STABLE_BAND = 15;          // |driftScore| <= 15 → stable

/**
 * scoreRiskDrift — compute a deterministic deterioration slope from a window
 * of past trust-score records and return a [−100, 100] drift score plus an
 * escalation class. Monotonic and fail-closed.
 *
 * @param records  Ordered or unordered list of past DriftRecord items. At least 2 required.
 */
export function scoreRiskDrift(records: DriftRecord[]): RiskDriftResult {
  if (!Array.isArray(records)) {
    throw new Error("scoreRiskDrift: records must be an array");
  }
  if (records.length < 2) {
    throw new Error(
      `scoreRiskDrift: need at least 2 records to compute drift (got ${records.length})`,
    );
  }

  // Validate every record up-front (fail-closed: bad input must not silently lower risk).
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== "object") {
      throw new Error(`scoreRiskDrift: records[${i}] is not an object`);
    }
    if (typeof r.score !== "number" || !Number.isFinite(r.score)) {
      throw new Error(`scoreRiskDrift: records[${i}].score must be a finite number`);
    }
    if (r.score < 0 || r.score > 100) {
      throw new Error(
        `scoreRiskDrift: records[${i}].score=${r.score} is out of [0,100]`,
      );
    }
    if (typeof r.timestampMs !== "number" || !Number.isFinite(r.timestampMs)) {
      throw new Error(
        `scoreRiskDrift: records[${i}].timestampMs must be a finite number`,
      );
    }
  }

  // Sort by time ascending so OLS is deterministic regardless of input order.
  const sorted = records.slice().sort((a, b) => a.timestampMs - b.timestampMs);

  const n = sorted.length;
  const windowSpanMs = sorted[n - 1].timestampMs - sorted[0].timestampMs;

  // OLS linear regression: slope = Σ((t-t̄)(s-s̄)) / Σ((t-t̄)²)
  // When all timestamps are identical the denominator is 0 → stable (score unchanged).
  let sumT = 0;
  let sumS = 0;
  for (const r of sorted) {
    sumT += r.timestampMs;
    sumS += r.score;
  }
  const meanT = sumT / n;
  const meanS = sumS / n;

  let cov = 0; // Σ((t-t̄)(s-s̄))
  let varT = 0; // Σ((t-t̄)²)
  for (const r of sorted) {
    const dt = r.timestampMs - meanT;
    const ds = r.score - meanS;
    cov += dt * ds;
    varT += dt * dt;
  }

  const slopePerMs = varT === 0 ? 0 : cov / varT;

  // Scale slope over the observation window → predicted score change (raw trend).
  // Positive rawTrend = score going UP over the window (improving).
  const rawTrend = slopePerMs * windowSpanMs;

  // driftScore: positive = BAD (score is falling), negative = GOOD (score is rising).
  // Clamp to [−100, 100].
  const driftScore = clamp(-rawTrend);

  // Direction classification.
  const direction: RiskDriftResult["direction"] =
    driftScore <= -IMPROVING_THRESHOLD
      ? "improving"
      : driftScore >= STABLE_BAND
      ? "deteriorating"
      : "stable";

  // Monotonic escalation: only kicks in for deterioration.
  let driftEscalation: ApprovalClass = "auto";
  if (driftScore >= DRIFT_DENY_THRESHOLD) {
    driftEscalation = "deny";
  } else if (driftScore >= DRIFT_ESCROW_THRESHOLD) {
    driftEscalation = "threshold_escrow";
  } else if (driftScore >= DRIFT_HUMAN_THRESHOLD) {
    driftEscalation = "human";
  }

  // Build factors + explanation.
  const factors: DriftFactor[] = [];

  factors.push({
    factor: "ols_slope",
    contribution: driftScore,
    detail: `slope ${slopePerMs.toExponential(3)} pts/ms over ${n} records; scaled trend ${rawTrend.toFixed(2)} pts`,
  });

  if (windowSpanMs === 0) {
    factors.push({
      factor: "zero_span",
      contribution: 0,
      detail: "all records share the same timestamp; slope is 0",
    });
  }

  const explanation: string[] = [
    `drift score ${driftScore} · direction ${direction} · escalation ${driftEscalation}`,
    `window ${n} records over ${windowSpanMs}ms`,
    ...factors.map(
      (f) =>
        `• ${f.factor}: ${f.contribution >= 0 ? "+" : ""}${f.contribution.toFixed(1)} (${f.detail})`,
    ),
  ];

  return {
    driftScore,
    direction,
    driftEscalation,
    windowSize: n,
    windowSpanMs,
    slopePerMs,
    factors,
    explanation,
  };
}

function clamp(v: number): number {
  return Math.max(-100, Math.min(100, Math.round(v)));
}
