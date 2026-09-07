/**
 * lib/risk/approval-policy.ts — ApprovalPolicy router: risk class → approval class.
 *
 * Second sub-step of MANIFEST "החסר הבא" #1 (ActionRiskClass + ApprovalPolicy).
 * This file maps each ActionRiskClass to the required ApprovalClass, produces a
 * signed decision trace for every evaluation, and wires as a GuardPolicy.
 *
 * DESIGN
 * ------
 * • `RISK_TO_APPROVAL_MAP` is governance-as-DATA: replaceable without code changes.
 * • `resolveApprovalClass` is FAIL-CLOSED: an undefined / unmapped risk class ⇒ "deny".
 * • `approvalPolicyRouter` is a GuardPolicy placed SECOND in the chain (after
 *   `injectRiskClass`). It reads `ctx.riskClass`, resolves the approval class,
 *   creates a signed decision trace, and:
 *     - "deny" → returns { allow: false }
 *     - anything else → returns { allow: true } (the trace is still captured on ctx)
 * • The trace is stored on `ctx.approvalTrace` so the orchestrator can append it
 *   to the audit record (see lib/orchestrator/orchestrator.ts).
 *
 * Zero external dependencies — node:crypto only for canonical JSON signing.
 */

import type { ActionContext, ActionRiskClass, ApprovalClass, GuardPolicy, Signer } from "../orchestrator/types";
import type { SimulationResult } from "./action-simulator";
import { simulateAction } from "./action-simulator";
import { scoreContextualRisk } from "./contextual-risk";
import type { RiskContext, ContextualRiskResult } from "./contextual-risk";
import { assessRisk, reputationBand } from "./risk-intelligence";
import type { RiskAssessment, RiskFactor, ReputationBand } from "./risk-intelligence";

/** All approval classes, for iteration / validation. */
export const APPROVAL_CLASSES: readonly ApprovalClass[] = [
  "auto",
  "opa_check",
  "human",
  "threshold_escrow",
  "deny",
] as const;

/**
 * RISK_TO_APPROVAL_MAP — canonical mapping of every risk class → approval class.
 * Governance-as-data: a tenant admin can ship a different map without touching
 * kernel code. fail-closed: any risk class not in this map is treated as deny.
 */
export const RISK_TO_APPROVAL_MAP: Readonly<Record<ActionRiskClass, ApprovalClass>> = {
  "read_only": "auto",
  "write_safe": "auto",
  "write_destructive": "human",
  "value_moving": "threshold_escrow",
  "irreversible": "deny",
  "privacy_sensitive": "opa_check",
  "regulated": "deny",
} as const;

/**
 * resolveApprovalClass — map a risk class to its required approval class.
 * FAIL-CLOSED: undefined / unknown / unmapped → "deny".
 */
export function resolveApprovalClass(riskClass: ActionRiskClass | undefined): ApprovalClass {
  if (!riskClass) return "deny";
  return RISK_TO_APPROVAL_MAP[riskClass] ?? "deny";
}

/**
 * DecisionTrace — a signed, canonical record of the approval decision.
 * The signature covers a canonical JSON representation (keys sorted) so
 * offline verifiers can recompute and verify without guessing field order.
 *
 * v235: `simulation` added (additive). When present it is included in the
 * signed payload so the predicted effect is tamper-evident. This allows an
 * approver to trust that the simulation they saw matches the action they're
 * approving — the simulation cannot be swapped after signing.
 * BigInt fields (valueAtRiskMicrounits) are serialised as decimal strings
 * in the canonical payload to remain JSON-safe.
 */
export interface DecisionTrace {
  policy: string;
  riskClass: ActionRiskClass | "unknown";
  approvalClass: ApprovalClass;
  timestamp: string;
  /** Pre-action simulation / dry-run (v235). Included in signature when present. */
  simulation?: {
    actionType: string;
    riskClass: ActionRiskClass;
    riskSource: "coding_taxonomy" | "general_taxonomy" | "fail_closed_default";
    reversible: boolean;
    blastRadius: string;
    predictedEffect: string;
    valueAtRiskMicrounits?: string; // μ¢ as decimal string (BigInt-safe)
    requiresBackup: boolean;
    warnings: string[];
  };
  /** Contextual risk escalation result (v286). Included in signature when present. */
  contextualRisk?: {
    baseApprovalClass: ApprovalClass;
    effectiveApprovalClass: ApprovalClass;
    escalated: boolean;
    signals: { signal: string; escalateTo: ApprovalClass; detail: string }[];
    explanation: string[];
  };
  /** Risk-intelligence fusion result (v298). Included in signature when present. */
  riskIntelligence?: {
    riskScore: number;
    effectiveApprovalClass: ApprovalClass;
    factors: RiskFactor[];
    reputationBand: ReputationBand;
  };
  /**
   * Vendor-neutral agent provenance (v320). When present, the agent's cross-vendor
   * identity (vendor, agentId, provenanceId fingerprint) is included in the signed
   * payload so the identity of the acting agent is tamper-evident in the decision trace.
   * Only the audit-relevant fields are captured (not sessionId/product/model —
   * identity fields only so the trace stays concise and tamper-evident for the core use case).
   */
  provenance?: {
    vendor: string;
    agentId: string;
    provenanceId: string;
  };
  signature: string;
}

/**
 * Create a canonical JSON string of the trace payload (without signature).
 * Keys are sorted so the signing input is deterministic.
 */
/**
 * Serialise a SimulationResult for inclusion in the canonical trace payload.
 * BigInt fields are converted to decimal strings (JSON-safe).
 * Returns undefined if no simulation provided.
 */
function serialiseSimulation(sim: SimulationResult | undefined): DecisionTrace["simulation"] | undefined {
  if (!sim) return undefined;
  return {
    actionType: sim.actionType,
    riskClass: sim.riskClass,
    riskSource: sim.riskSource,
    reversible: sim.reversible,
    blastRadius: sim.blastRadius,
    predictedEffect: sim.predictedEffect,
    ...(sim.valueAtRiskMicrounits !== undefined
      ? { valueAtRiskMicrounits: sim.valueAtRiskMicrounits.toString() }
      : {}),
    requiresBackup: sim.requiresBackup,
    warnings: sim.warnings,
  };
}

/**
 * Create a canonical JSON string of the trace payload (without signature).
 * Keys are sorted so the signing input is deterministic.
 * v235: simulation is included when present, binding it cryptographically to
 * the trace — an approver cannot be shown one simulation and sign another.
 * Exported for use in verification tests.
 */
export function canonicalTracePayload(
  policy: string,
  riskClass: ActionRiskClass | "unknown",
  approvalClass: ApprovalClass,
  timestamp: string,
  simulation?: DecisionTrace["simulation"],
  contextualRisk?: DecisionTrace["contextualRisk"],
  riskIntelligence?: DecisionTrace["riskIntelligence"],
  provenance?: DecisionTrace["provenance"],
): string {
  // Keys in pre-computed lexicographic sort order:
  //   approvalClass < contextualRisk < policy < provenance
  //   < riskClass < riskIntelligence < simulation < timestamp
  // Building the object in this order avoids the intermediate `obj` accumulator,
  // the `ordered` copy-object, and the Object.keys().sort() call on every signed action.
  const ordered: Record<string, unknown> = { approvalClass };
  if (contextualRisk !== undefined) ordered.contextualRisk = contextualRisk;
  ordered.policy = policy;
  if (provenance !== undefined) ordered.provenance = provenance;
  ordered.riskClass = riskClass;
  if (riskIntelligence !== undefined) ordered.riskIntelligence = riskIntelligence;
  if (simulation !== undefined) ordered.simulation = simulation;
  ordered.timestamp = timestamp;
  return JSON.stringify(ordered);
}

/**
 * Create a signed DecisionTrace from the action context and resolved approval class.
 * v235: optionally accepts a SimulationResult; if provided it is serialised and
 * included in the signed payload so the predicted effect is tamper-evident.
 */
export function createDecisionTrace(
  ctx: ActionContext,
  approvalClass: ApprovalClass,
  signer: Signer,
  policyName = "approval-policy-router",
  simulation?: SimulationResult,
  contextualRiskResult?: ContextualRiskResult,
  riskAssessment?: RiskAssessment,
): DecisionTrace {
  const riskClass = ctx.riskClass ?? "unknown";
  const timestamp = new Date().toISOString();
  const serialisedSim = serialiseSimulation(simulation);
  const riskIntelligence = riskAssessment
    ? {
        riskScore: riskAssessment.riskScore,
        effectiveApprovalClass: riskAssessment.effectiveApprovalClass,
        factors: riskAssessment.factors,
        reputationBand: riskAssessment.reputationBand,
      }
    : undefined;
  // v320: extract identity fields from agentProvenance on ctx (if present).
  // Only vendor, agentId, provenanceId are bound — the deterministic fingerprint
  // is what matters for tamper-evidence; optional decorators (product/model/sessionId)
  // stay in the outer receipt provenance for full fidelity.
  const provenance: DecisionTrace["provenance"] = ctx.agentProvenance
    ? {
        vendor: ctx.agentProvenance.vendor,
        agentId: ctx.agentProvenance.agentId,
        provenanceId: ctx.agentProvenance.provenanceId,
      }
    : undefined;
  const payload = canonicalTracePayload(policyName, riskClass, approvalClass, timestamp, serialisedSim, contextualRiskResult, riskIntelligence, provenance);
  const signature = signer.sign(payload);
  return {
    policy: policyName,
    riskClass,
    approvalClass,
    timestamp,
    ...(serialisedSim !== undefined ? { simulation: serialisedSim } : {}),
    ...(contextualRiskResult !== undefined ? { contextualRisk: contextualRiskResult } : {}),
    ...(riskIntelligence !== undefined ? { riskIntelligence } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    signature,
  };
}

/**
 * approvalPolicyRouter — GuardPolicy that reads `ctx.riskClass`, resolves the
 * required ApprovalClass, creates a signed decision trace, and either allows or
 * denies based on the resolved class.
 *
 * The trace is always stored on `ctx.approvalTrace` so the orchestrator can
 * append it to the audit record regardless of outcome.
 *
 * Placement: SECOND in the policy chain (immediately after injectRiskClass).
 */
export function approvalPolicyRouter(signer: Signer, name = "approval-policy-router"): GuardPolicy {
  // Import simulateAction lazily to avoid circular dep (coding-actions → approval-policy).
  // The import is cached by the module system after the first call.
  let _simulate: typeof import("./action-simulator").simulateAction | undefined;
  async function getSimulate() {
    if (!_simulate) {
      const mod = await import("./action-simulator");
      _simulate = mod.simulateAction;
    }
    return _simulate;
  }

  return {
    name,
    evaluate: (ctx: ActionContext) => {
      const baseApprovalClass = resolveApprovalClass(ctx.riskClass);
      const riskCtx = ctx.riskContext as RiskContext | undefined;

      // v298: fuse static floor + behavioural signals + reputation into one
      // deterministic assessment when reputationScore is available.
      // Backward-compat: when reputationScore is absent, use contextual-risk only.
      let riskAssessment: RiskAssessment | undefined;
      let effectiveApprovalClass: ApprovalClass;
      // v384: hoisted to outer scope so the legacy path computes scoreContextualRisk
      // once and reuses the result when building the trace — previously called twice.
      let legacyRiskResult: ContextualRiskResult | undefined;
      if (ctx.reputationScore !== undefined) {
        try {
          riskAssessment = assessRisk({ baseApprovalClass, context: riskCtx, reputationScore: ctx.reputationScore });
        } catch {
          // If assessRisk throws (bad input), treat as deny (fail-closed) and
          // preserve the contextual_risk_error signal for audit transparency.
          const raw = ctx.reputationScore;
          const band = (typeof raw === "number" && raw >= 0 && raw <= 100) ? reputationBand(raw) : "new";
          riskAssessment = {
            riskScore: 100,
            baseApprovalClass,
            effectiveApprovalClass: "deny",
            escalated: true,
            reputationBand: band,
            factors: [{ factor: "contextual_risk_error", contribution: 100, detail: "contextual risk scoring threw" }],
            contextual: {
              baseApprovalClass,
              effectiveApprovalClass: "deny",
              escalated: true,
              signals: [{ signal: "contextual_risk_error", escalateTo: "deny", detail: "contextual risk scoring threw" }],
              explanation: ["contextual risk scoring failed → deny (fail-closed)"],
            },
            explanation: ["contextual risk scoring failed → deny (fail-closed)"],
          };
        }
        effectiveApprovalClass = riskAssessment.effectiveApprovalClass;
      } else {
        // Legacy path (no reputationScore yet wired from track-record).
        // scoreContextualRisk is called exactly once; legacyRiskResult is reused
        // below when building the trace — no second call needed.
        try {
          legacyRiskResult = scoreContextualRisk(baseApprovalClass, riskCtx);
        } catch {
          legacyRiskResult = {
            baseApprovalClass,
            effectiveApprovalClass: "deny" as ApprovalClass,
            escalated: true,
            signals: [{ signal: "contextual_risk_error", escalateTo: "deny" as ApprovalClass, detail: "contextual risk scoring threw" }],
            explanation: ["contextual risk scoring failed → deny (fail-closed)"],
          };
        }
        effectiveApprovalClass = legacyRiskResult.effectiveApprovalClass;
      }

      // v235: run simulation synchronously if actionType is available.
      // simulateAction is pure (no I/O) so it is safe to call here.
      // Errors are swallowed (simulation is advisory, not gating) so the
      // policy never becomes unavailable due to a simulator bug.
      let simulation: SimulationResult | undefined;
      const actionType: string | undefined = (ctx.action as any)?.type ?? (ctx as any)?.actionType;
      if (typeof actionType === "string" && actionType.length > 0) {
        try {
          simulation = simulateAction({ actionType, valueMicrounits: (ctx.action as any)?.valueMicrounits });
        } catch {
          // If simulateAction fails, proceed without simulation (advisory only).
        }
      }

      let trace: DecisionTrace;
      if (riskAssessment) {
        trace = createDecisionTrace(ctx, effectiveApprovalClass, signer, name, simulation, riskAssessment.contextual, riskAssessment);
      } else {
        // Legacy path: reuse legacyRiskResult computed above — no second call.
        trace = createDecisionTrace(ctx, effectiveApprovalClass, signer, name, simulation, legacyRiskResult);
      }
      ctx.approvalTrace = JSON.stringify(trace, (_k, v) => typeof v === "bigint" ? v.toString() : v);

      if (effectiveApprovalClass === "deny") {
        return {
          allow: false,
          reason: `approval policy denied: riskClass=${ctx.riskClass ?? "unknown"} → base=${baseApprovalClass} effective=${effectiveApprovalClass} | trace=${ctx.approvalTrace}`,
        };
      }

      return { allow: true };
    },
  };
}
