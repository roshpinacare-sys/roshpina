/**
 * lib/risk/risk-intelligence.ts — the Risk Intelligence Fusion Engine.
 *
 * WHAT THIS IS (higher intelligence, done as transparent engineering)
 * ------------------------------------------------------------------
 * TFA already has separate intelligence pieces: a static taxonomy (the floor), a
 * behavioural escalator (contextual-risk: velocity/value/sensitivity), and an actor
 * reputation score (track-record). Until now they did not talk to each other — each
 * decided in isolation. Real intelligence is not a bigger black box; it is FUSING
 * multiple independent signals into one coherent, explainable judgement.
 *
 * `assessRisk` fuses signal families into a single deterministic assessment:
 *   1. STATIC FLOOR     — the approval class the action's risk class mandates.
 *   2. BEHAVIOURAL       — contextual signals (delegates to scoreContextualRisk).
 *   3. REPUTATION        — the actor's track-record trust score (0-100).
 *   4. DRIFT (optional)  — a pre-computed predictive trend (scoreRiskDrift), folded
 *                          in via the same monotonic maxApproval() join (§2.C-8).
 *
 * It produces:
 *   • riskScore 0-100   — a reproducible fused score (anyone with the same inputs
 *                          gets the same number — verifiable, pairs with
 *                          verifyDecisionIntegrity);
 *   • effectiveApprovalClass — MONOTONIC: it can only escalate above the static
 *                          floor, never below it. A trusted actor lowers the
 *                          informational score but can NEVER weaken the gate.
 *   • factors[]         — the explainable contribution of every signal, so the
 *                          decision is auditable and defensible.
 *
 * Deterministic, pure, zero external deps. "Intelligence" here = multi-signal
 * fusion that a human can read and reproduce — not an opaque model.
 */

import type { ApprovalClass } from "../orchestrator/types";
import { scoreContextualRisk, maxApproval, type RiskContext, type ContextualRiskResult } from "./contextual-risk";
import type { RiskDriftResult } from "./risk-drift";

/** Numeric floor each approval class contributes to the fused 0-100 score. */
const CLASS_SCORE: Record<ApprovalClass, number> = {
  auto: 10,
  opa_check: 30,
  human: 55,
  threshold_escrow: 80,
  deny: 100,
};

/** Reputation bands derived from the track-record trust score (0-100, 50 = no history). */
export type ReputationBand = "untrusted" | "new" | "normal" | "trusted";

export function reputationBand(score: number | undefined): ReputationBand {
  if (score === undefined) return "new";
  if (score < 25) return "untrusted";
  if (score < 45) return "new";
  if (score >= 70) return "trusted";
  return "normal";
}

export interface RiskFactor {
  factor: string;
  /** Signed contribution to the fused risk score (positive = riskier). */
  contribution: number;
  detail: string;
}

export interface RiskIntelligenceInput {
  /** The statically-resolved approval class for this action (the floor). */
  baseApprovalClass: ApprovalClass;
  /** Behavioural context (velocity, value, sensitivity, off-hours, novelty). */
  context?: RiskContext;
  /** Actor reputation trust score 0-100 from track-record (50 = no history). */
  reputationScore?: number;
  /**
   * Pre-computed predictive drift (§2.C sub-step 8 — drift-triggered escalation).
   * Caller computes this via scoreRiskDrift(history) from the actor's trust-score
   * window and passes the result in — assessRisk stays a pure fusion function and
   * does not fetch history itself. Omitted/undefined → no drift escalation applied
   * (the conservative default: an action is never escalated based on a trend that
   * was never computed; it is simply judged on the other three signals, exactly as
   * it would be without this feature).
   */
  drift?: RiskDriftResult;
}

export interface RiskAssessment {
  /** Fused, reproducible risk score in [0,100]. */
  riskScore: number;
  baseApprovalClass: ApprovalClass;
  effectiveApprovalClass: ApprovalClass;
  escalated: boolean;
  reputationBand: ReputationBand;
  /** True iff a drift signal was supplied and contributed to the assessment. */
  driftApplied: boolean;
  factors: RiskFactor[];
  contextual: ContextualRiskResult;
  explanation: string[];
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * assessRisk — fuse static floor + behavioural signals + reputation into one
 * deterministic, explainable assessment. MONOTONIC: the effective approval class
 * is never below the static floor.
 *
 * fail-closed: an unknown base class is treated as "deny"; an out-of-range
 * reputation score throws (bad input must not silently lower risk).
 */
export function assessRisk(input: RiskIntelligenceInput): RiskAssessment {
  if (!input || typeof input !== "object") {
    throw new Error("assessRisk: input must be an object");
  }
  const baseApprovalClass: ApprovalClass = baseClass(input.baseApprovalClass);
  if (
    input.reputationScore !== undefined &&
    (typeof input.reputationScore !== "number" ||
      !Number.isFinite(input.reputationScore) ||
      input.reputationScore < 0 ||
      input.reputationScore > 100)
  ) {
    throw new Error("assessRisk: reputationScore must be a number in [0,100]");
  }
  if (input.drift !== undefined) {
    if (!input.drift || typeof input.drift !== "object") {
      throw new Error("assessRisk: drift must be a RiskDriftResult object");
    }
    if (
      typeof input.drift.driftScore !== "number" ||
      !Number.isFinite(input.drift.driftScore) ||
      input.drift.driftScore < -100 ||
      input.drift.driftScore > 100
    ) {
      throw new Error("assessRisk: drift.driftScore must be a number in [-100,100]");
    }
    if (!(input.drift.driftEscalation in CLASS_SCORE)) {
      throw new Error("assessRisk: drift.driftEscalation must be a known ApprovalClass");
    }
  }

  const factors: RiskFactor[] = [];

  // 1. Static floor contributes its class score.
  const floorScore = CLASS_SCORE[baseApprovalClass];
  factors.push({ factor: "static_floor", contribution: floorScore, detail: `base class ${baseApprovalClass}` });

  // 2. Behavioural escalation (delegated, explainable). Each signal adds points
  //    proportional to how far up the ladder it pushes.
  const contextual = scoreContextualRisk(baseApprovalClass, input.context ?? {});
  let behaviouralPoints = 0;
  for (const s of contextual.signals) {
    const pts = Math.max(0, CLASS_SCORE[s.escalateTo] - floorScore);
    if (pts > 0) {
      behaviouralPoints += pts;
      factors.push({ factor: `behavioural:${s.signal}`, contribution: pts, detail: s.detail });
    }
  }

  // 3. Reputation adjustment. Low reputation ADDS risk and can escalate; high
  //    reputation lowers the informational score but NEVER the approval class.
  const band = reputationBand(input.reputationScore);
  let reputationPoints = 0;
  let reputationEscalation: ApprovalClass = "auto";
  if (band === "untrusted") {
    reputationPoints = 25;
    reputationEscalation = "human";
    factors.push({ factor: "reputation:untrusted", contribution: 25, detail: `trust score ${input.reputationScore} (<25) → review` });
  } else if (band === "new") {
    reputationPoints = 12;
    reputationEscalation = "opa_check";
    factors.push({ factor: "reputation:new", contribution: 12, detail: `low/no history (score ${input.reputationScore ?? "n/a"})` });
  } else if (band === "trusted") {
    reputationPoints = -10; // informational reduction only — does not touch the class floor
    factors.push({ factor: "reputation:trusted", contribution: -10, detail: `established trust (score ${input.reputationScore})` });
  }

  // 4. Predictive drift (§2.C sub-step 8). Optional — only contributes when the
  //    caller supplies a pre-computed drift result. Only the deteriorating side
  //    (driftScore > 0) ever adds points/escalation; an improving trend is
  //    informational only here too, mirroring the "trusted reputation" rule:
  //    a positive trend can never weaken the gate, only a negative one can
  //    raise it. This keeps the engine monotonic in the same direction as the
  //    other two escalating signals.
  const driftApplied = input.drift !== undefined;
  let driftPoints = 0;
  if (driftApplied) {
    const d = input.drift as RiskDriftResult;
    if (d.driftScore > 0) {
      driftPoints = Math.round(d.driftScore * 0.3); // dampened: a trend alone is weaker evidence than a point-in-time signal
      factors.push({
        factor: "drift:deteriorating",
        contribution: driftPoints,
        detail: `drift score ${d.driftScore} over ${d.windowSize} records (${d.windowSpanMs}ms) → ${d.driftEscalation}`,
      });
    } else if (d.driftScore < 0) {
      factors.push({
        factor: "drift:improving",
        contribution: 0,
        detail: `drift score ${d.driftScore} (improving trend; informational only, never lowers the gate)`,
      });
    }
  }

  // Fused score (clamped). Monotonic class is the max of floor, behavioural, reputation, drift escalation.
  const riskScore = clamp(floorScore + behaviouralPoints + reputationPoints + driftPoints);
  let effectiveApprovalClass = maxApproval(baseApprovalClass, contextual.effectiveApprovalClass);
  effectiveApprovalClass = maxApproval(effectiveApprovalClass, reputationEscalation);
  if (driftApplied) {
    effectiveApprovalClass = maxApproval(effectiveApprovalClass, (input.drift as RiskDriftResult).driftEscalation);
  }

  const escalated = effectiveApprovalClass !== baseApprovalClass;
  const explanation: string[] = [
    `risk score ${riskScore}/100 · band ${band} · class ${baseApprovalClass}${escalated ? ` → ${effectiveApprovalClass}` : " (no escalation)"}`,
    ...factors.map((f) => `• ${f.factor}: ${f.contribution >= 0 ? "+" : ""}${f.contribution} (${f.detail})`),
  ];

  return { riskScore, baseApprovalClass, effectiveApprovalClass, escalated, reputationBand: band, driftApplied, factors, contextual, explanation };
}

function baseClass(c: ApprovalClass): ApprovalClass {
  return c in CLASS_SCORE ? c : "deny";
}
