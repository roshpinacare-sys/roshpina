/**
 * lib/risk/contextual-risk.ts — context-aware risk escalation.
 *
 * THE INTELLIGENCE UPGRADE (done correctly, not as faked ML)
 * ---------------------------------------------------------
 * Until now the gate decided from a STATIC map: a given toolId always resolved to
 * the same approvalClass, regardless of WHO acted, HOW OFTEN, on WHAT resource, or
 * whether the request deviated from the actor's normal behaviour. That is the real
 * "low-intelligence" gap — not the engineering depth, but the absence of CONTEXT.
 *
 * This engine adds behavioural intelligence the right way:
 *   • It consumes explainable, deterministic SIGNALS (velocity vs baseline, value
 *     magnitude, resource sensitivity, off-hours, novelty for this actor).
 *   • It ESCALATES ONLY — never downgrades. The static approvalClass is a FLOOR;
 *     context can lift "auto" → "human" → "threshold_escrow" → "deny", never the
 *     reverse. This keeps the gate fail-closed and provably no weaker than before.
 *   • Every escalation carries a human-readable explanation and the signal that
 *     caused it, so the decision stays auditable and re-derivable (pairs with
 *     verifyDecisionIntegrity — the contextual inputs are part of the trace).
 *
 * It is deterministic and pure (no ML model, no randomness, no I/O), so it honours
 * every TFA invariant: zero external deps, BigInt money, fail-closed on bad input.
 * Intelligence here means "uses context", not "calls a black box".
 */

import type { ApprovalClass } from "../orchestrator/types";

/** Escalation ladder (low → high). opa_check is treated as equivalent to human. */
const LADDER: ApprovalClass[] = ["auto", "opa_check", "human", "threshold_escrow", "deny"];

/**
 * O(1) rank lookup — replaces LADDER.indexOf (O(n) scan) with a pre-built Map.
 * With 5 fixed classes this is a tiny win per call, but rank() is invoked on every
 * maxApproval() and the inner signals loop, so every risk-intelligence hot path benefits.
 * Unknown classes map to LADDER.length - 1 (fail-closed, same semantics as before).
 */
const LADDER_RANK: ReadonlyMap<string, number> = new Map(
  LADDER.map((cls, i) => [cls, i]),
);
const LADDER_MAX_RANK = LADDER.length - 1;

/** Rank within the ladder; unknown classes are treated as the most restrictive. */
function rank(c: ApprovalClass): number {
  return LADDER_RANK.get(c) ?? LADDER_MAX_RANK;
}

/** Pick the more restrictive of two approval classes (monotonic join). */
export function maxApproval(a: ApprovalClass, b: ApprovalClass): ApprovalClass {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Behavioural context for an action. All fields optional — a signal only fires
 * when its inputs are present, so partial context never fabricates risk.
 */
export interface RiskContext {
  /** Requests by this actor in the recent window. */
  actorRecentCount?: number;
  /** The actor's established baseline request count for that window. */
  actorBaselineCount?: number;
  /** Value at stake in μ¢ (BigInt). */
  valueMicrounits?: bigint;
  /** Tenant threshold (μ¢) above which value is "large" and needs escrow. */
  valueEscalationThreshold?: bigint;
  /** Caller-supplied resource sensitivity. */
  resourceSensitivity?: "normal" | "sensitive" | "critical";
  /** True if the action is outside normal operating hours for the tenant. */
  offHours?: boolean;
  /** True if this actor has never performed this actionType before. */
  novelForActor?: boolean;
}

export interface RiskSignal {
  signal: string;
  /** How far this signal pushes the approval class up the ladder. */
  escalateTo: ApprovalClass;
  detail: string;
}

export interface ContextualRiskResult {
  baseApprovalClass: ApprovalClass;
  effectiveApprovalClass: ApprovalClass;
  escalated: boolean;
  signals: RiskSignal[];
  explanation: string[];
}

/** Velocity multiple (recent / baseline) at/above which we escalate to human review. */
const VELOCITY_HUMAN_MULTIPLE = 3;
/** Velocity multiple at/above which we escalate to threshold_escrow. */
const VELOCITY_ESCROW_MULTIPLE = 10;

/**
 * scoreContextualRisk — given the statically-resolved approval class and a
 * behavioural context, return the (possibly escalated) effective class plus an
 * explainable signal list. Monotonic: effective >= base, always.
 *
 * fail-closed: a malformed base class is treated as "deny"; non-BigInt money throws.
 */
export function scoreContextualRisk(base: ApprovalClass, ctx: RiskContext = {}): ContextualRiskResult {
  const baseApprovalClass: ApprovalClass = LADDER_RANK.has(base) ? base : "deny";
  if (ctx.valueMicrounits !== undefined && typeof ctx.valueMicrounits !== "bigint") {
    throw new Error("scoreContextualRisk: valueMicrounits must be a BigInt (μ¢)");
  }
  if (ctx.valueEscalationThreshold !== undefined && typeof ctx.valueEscalationThreshold !== "bigint") {
    throw new Error("scoreContextualRisk: valueEscalationThreshold must be a BigInt (μ¢)");
  }

  const signals: RiskSignal[] = [];

  // 1. Velocity: acting far above the actor's own baseline → anomalous burst.
  if (
    typeof ctx.actorRecentCount === "number" &&
    typeof ctx.actorBaselineCount === "number" &&
    ctx.actorBaselineCount > 0 &&
    ctx.actorRecentCount > 0
  ) {
    const multiple = ctx.actorRecentCount / ctx.actorBaselineCount;
    if (multiple >= VELOCITY_ESCROW_MULTIPLE) {
      signals.push({
        signal: "velocity_extreme",
        escalateTo: "threshold_escrow",
        detail: `actor volume ${multiple.toFixed(1)}× baseline (≥${VELOCITY_ESCROW_MULTIPLE}×)`,
      });
    } else if (multiple >= VELOCITY_HUMAN_MULTIPLE) {
      signals.push({
        signal: "velocity_elevated",
        escalateTo: "human",
        detail: `actor volume ${multiple.toFixed(1)}× baseline (≥${VELOCITY_HUMAN_MULTIPLE}×)`,
      });
    }
  }

  // 2. Value magnitude: large value movement needs escrow/threshold approval.
  if (
    ctx.valueMicrounits !== undefined &&
    ctx.valueEscalationThreshold !== undefined &&
    ctx.valueMicrounits >= ctx.valueEscalationThreshold &&
    ctx.valueEscalationThreshold > 0n
  ) {
    signals.push({
      signal: "value_large",
      escalateTo: "threshold_escrow",
      detail: `value ${ctx.valueMicrounits.toString()}μ¢ ≥ threshold ${ctx.valueEscalationThreshold.toString()}μ¢`,
    });
  }

  // 3. Resource sensitivity.
  if (ctx.resourceSensitivity === "critical") {
    signals.push({ signal: "resource_critical", escalateTo: "human", detail: "resource marked critical" });
  } else if (ctx.resourceSensitivity === "sensitive") {
    signals.push({ signal: "resource_sensitive", escalateTo: "opa_check", detail: "resource marked sensitive" });
  }

  // 4. Off-hours activity is a soft anomaly → at least human review.
  if (ctx.offHours === true) {
    signals.push({ signal: "off_hours", escalateTo: "human", detail: "action outside normal operating hours" });
  }

  // 5. Novel action for this actor → soft escalation.
  if (ctx.novelForActor === true) {
    signals.push({ signal: "novel_for_actor", escalateTo: "human", detail: "actor has not performed this action before" });
  }

  // Monotonic join: effective is the max of base and every signal's target.
  let effectiveApprovalClass = baseApprovalClass;
  for (const s of signals) effectiveApprovalClass = maxApproval(effectiveApprovalClass, s.escalateTo);

  const escalated = rank(effectiveApprovalClass) > rank(baseApprovalClass);
  const explanation: string[] = [];
  if (escalated) {
    explanation.push(`escalated ${baseApprovalClass} → ${effectiveApprovalClass} on ${signals.length} signal(s)`);
    for (const s of signals) explanation.push(`• ${s.signal}: ${s.detail} (→ ${s.escalateTo})`);
  } else {
    explanation.push(`no escalation; base approval class ${baseApprovalClass} stands`);
  }

  return { baseApprovalClass, effectiveApprovalClass, escalated, signals, explanation };
}
