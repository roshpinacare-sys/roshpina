/**
 * lib/risk/drift-explain.ts — §2.C sub-step 9: Drift explainability
 *
 * WHAT THIS IS
 * ------------
 * Connects `RiskAssessment.factors` (including `drift:*`) to a structured
 * compliance response that answers: "Why is this agent deteriorating?"
 *
 * The caller supplies:
 *   • agentId      — the actor under review
 *   • records      — at least 2 DriftRecord items (their trust-score history)
 *   • context      — optional RiskIntelligenceInput overrides (behavioural
 *                    signals, reputationScore). If omitted, only drift drives
 *                    the assessment.
 *
 * This function:
 *   1. Runs scoreRiskDrift over the supplied window.
 *   2. Runs assessRisk with the drift result wired in.
 *   3. Builds a DriftComplianceReport: ranked factors, a severity sentence,
 *      escalation class, actionable recommendation, and a machine-readable
 *      verdict.
 *
 * FAIL-CLOSED
 * -----------
 * • < 2 records              → throws (scoreRiskDrift propagates)
 * • invalid record fields    → throws (scoreRiskDrift propagates)
 * • missing agentId          → throws
 *
 * Zero external dependencies.
 */

import { scoreRiskDrift } from "./risk-drift";
import { assessRisk } from "./risk-intelligence";
import type { DriftRecord, DriftFactor } from "./risk-drift";
import type { RiskIntelligenceInput, RiskFactor } from "./risk-intelligence";
import type { ApprovalClass } from "../orchestrator/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriftExplainInput {
  /** The agent or actor being assessed. Must be non-empty. */
  agentId: string;
  /** Historical trust-score window. At least 2 required. */
  records: DriftRecord[];
  /**
   * Optional additional risk context (behavioural signals, reputationScore,
   * baseApprovalClass, etc.). When omitted, a neutral base context is used so
   * drift alone drives the assessment — safe and fail-closed.
   */
  context?: Partial<Omit<RiskIntelligenceInput, "drift">>;
}

/** A single ranked contribution in the compliance report. */
export interface ExplainedFactor {
  /** Factor identifier (e.g. "drift:deteriorating", "reputation:untrusted"). */
  factor: string;
  /** Net contribution to the fused risk score (positive = more risk). */
  contribution: number;
  /** Human-readable detail string. */
  detail: string;
  /**
   * Whether this factor originated from the drift computation (true) or from
   * the static/behavioural/reputation assessment (false).
   */
  isDrift: boolean;
}

export interface DriftComplianceReport {
  agentId: string;
  /** Fused risk score [0, 100] from assessRisk. */
  riskScore: number;
  /** Drift score [−100, 100] from scoreRiskDrift (positive = deteriorating). */
  driftScore: number;
  direction: "improving" | "stable" | "deteriorating";
  /** The effective approval class after drift escalation. */
  effectiveApprovalClass: ApprovalClass;
  /**
   * Factors sorted by absolute contribution descending — the biggest drivers first.
   * Includes both drift and static/behavioural/reputation factors.
   */
  factors: ExplainedFactor[];
  /**
   * Primary compliance sentence: a single human-readable statement of the verdict.
   * E.g. "Agent agent:abc is deteriorating (drift score 62) — escalated to human review."
   */
  summary: string;
  /** Per-factor narrative lines (ready to paste into a compliance report). */
  explanation: string[];
  /**
   * Actionable recommendation keyed on the effective approval class:
   *   auto             → "No immediate action required; monitor."
   *   human            → "Escalate to human reviewer before next high-risk action."
   *   threshold_escrow → "Lock value in escrow; do not release until drift reverses."
   *   deny             → "Block the agent immediately; initiate review."
   */
  recommendation: string;
  /** True iff the drift trend contributed to a class escalation. */
  driftEscalated: boolean;
  /** Number of records used in the drift window. */
  windowSize: number;
  /** Span of the observation window in milliseconds. */
  windowSpanMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RECOMMENDATIONS: Record<ApprovalClass, string> = {
  auto:             "No immediate action required; continue monitoring.",
  human:            "Escalate to human reviewer before the next high-risk action.",
  threshold_escrow: "Lock value in escrow; do not release until the drift trend reverses.",
  deny:             "Block the agent immediately and initiate a compliance review.",
};

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * explainDriftCompliance — §2.C sub-step 9.
 *
 * Runs scoreRiskDrift + assessRisk and assembles a DriftComplianceReport
 * that answers "why is this agent deteriorating" in both machine-readable
 * (factors[]) and human-readable (summary, explanation, recommendation) form.
 */
export function explainDriftCompliance(input: DriftExplainInput): DriftComplianceReport {
  if (!input || typeof input !== "object") {
    throw new Error("explainDriftCompliance: input must be an object");
  }
  if (typeof input.agentId !== "string" || input.agentId.trim() === "") {
    throw new Error("explainDriftCompliance: agentId must be a non-empty string");
  }
  // records validation is delegated to scoreRiskDrift (fail-closed there).

  // 1. Compute drift.
  const drift = scoreRiskDrift(input.records);

  // 2. Fuse with static/behavioural/reputation context.
  const baseContext: RiskIntelligenceInput = {
    baseApprovalClass: "auto",    // neutral default — drift is the signal
    behaviouralSignals: [],
    reputationScore: undefined,
    ...(input.context ?? {}),
    drift,                        // always wire drift — cannot be overridden by caller
  };
  const assessment = assessRisk(baseContext);

  // 3. Build ranked factors from assessment.factors (which includes drift:* factors).
  const explained: ExplainedFactor[] = assessment.factors.map((f: RiskFactor) => ({
    factor: f.factor,
    contribution: f.contribution,
    detail: f.detail,
    isDrift: f.factor.startsWith("drift:"),
  }));
  // Sort by absolute contribution descending (biggest drivers first).
  explained.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // 4. Summary sentence.
  const directionLabel =
    drift.direction === "deteriorating"
      ? `deteriorating (drift score ${drift.driftScore})`
      : drift.direction === "improving"
      ? `improving (drift score ${drift.driftScore})`
      : "stable";
  const escalationNote =
    assessment.driftApplied && assessment.escalated
      ? ` — escalated to ${assessment.effectiveApprovalClass}`
      : assessment.escalated
      ? ` — escalated to ${assessment.effectiveApprovalClass} (non-drift)`
      : "";
  const summary = `Agent ${input.agentId} is ${directionLabel}${escalationNote}.`;

  // 5. Explanation lines (concise for compliance reports).
  const explanation: string[] = [
    summary,
    `Fused risk score: ${assessment.riskScore}/100 · window: ${drift.windowSize} records over ${drift.windowSpanMs}ms`,
    "Factor breakdown (highest impact first):",
    ...explained.map(
      (f) =>
        `  • ${f.factor}: ${f.contribution >= 0 ? "+" : ""}${f.contribution} — ${f.detail}`,
    ),
  ];

  return {
    agentId: input.agentId,
    riskScore: assessment.riskScore,
    driftScore: drift.driftScore,
    direction: drift.direction,
    effectiveApprovalClass: assessment.effectiveApprovalClass,
    factors: explained,
    summary,
    explanation,
    recommendation: RECOMMENDATIONS[assessment.effectiveApprovalClass],
    driftEscalated: assessment.driftApplied && assessment.escalated,
    windowSize: drift.windowSize,
    windowSpanMs: drift.windowSpanMs,
  };
}
