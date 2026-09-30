/**
 * lib/risk/policy-simulator.ts — Policy Simulation Harness.
 *
 * "What-if" engine: given an ActionIntent + policy chain + optional enrichment,
 * simulate the FULL guard → risk → assessment pipeline WITHOUT executing,
 * writing audit records, or mutating state.
 *
 * USE CASES
 * ---------
 * • Pre-flight check by agents: "will this intent pass policy before I run it?"
 * • Policy comparison: compare outcomes under different policy sets (governance drift).
 * • Scenario planning: "what happens if I add a spending cap?" — simulate before deploy.
 *
 * DESIGN
 * ------
 * • PURE: zero side-effects. No audit writes, no workflow creation, no store updates.
 * • FAIL-CLOSED: invalid intent → throws; policy throw → treated as deny; unknown risk class → deny.
 * • SERVER-SIDE CLASSIFICATION: the client's claimed riskClass is ignored; the server
 *   re-classifies from toolId via classifyActionServerSide (same chokepoint as the live path).
 * • PER-POLICY VISIBILITY: each policy's decision is captured separately so callers can
 *   see WHICH policy denied (not just "denied somewhere").
 * • SCENARIO COMPARISON: compareScenarios() runs N simulations and computes differences + consensus.
 *
 * Zero external dependencies.
 */

import type {
  ActionIntent,
  Action,
  ActionContext,
  GuardPolicy,
  GuardDecision,
  ActionRiskClass,
  ApprovalClass,
  Signer,
} from "../orchestrator/types";
import { validateActionIntent } from "../orchestrator/action-intent";
import { classifyActionServerSide } from "../risk/coding-actions";
import { simulateAction } from "../risk/action-simulator";
import type { SimulationResult } from "../risk/action-simulator";
import { scoreContextualRisk } from "../risk/contextual-risk";
import type { RiskContext, ContextualRiskResult } from "../risk/contextual-risk";
import { assessRisk, reputationBand } from "../risk/risk-intelligence";
import type { RiskAssessment } from "../risk/risk-intelligence";
import { resolveApprovalClass, createDecisionTrace } from "../risk/approval-policy";
import type { DecisionTrace } from "../risk/approval-policy";
import { applyKillSwitch } from "../policy/kill-switch";
import type { KillSwitch } from "../policy/kill-switch";

/** Single-policy evaluation outcome (name + decision + timing). */
export interface PolicyDecisionRecord {
  name: string;
  decision: GuardDecision;
  /** Evaluation time in milliseconds (advisory, 0 if not measured). */
  ms: number;
}

/** Input to a single policy simulation scenario. */
export interface PolicySimulationInput {
  /** The intent to simulate. */
  intent: ActionIntent;
  /** Guard policies to evaluate against (AND semantics). */
  policies: GuardPolicy[];
  /** Optional reputation score (0–100). When provided, full risk-intelligence fusion runs. */
  reputationScore?: number;
  /** Optional behavioural context for contextual risk scoring. */
  riskContext?: RiskContext;
  /** Optional signer for generating a DecisionTrace preview. */
  signer?: Signer;
  /** Optional kill-switch to consult (fail-closed: tripped → deny). */
  killSwitch?: KillSwitch;
  /** Value escalation threshold for contextual risk (μ¢ BigInt). */
  valueEscalationThreshold?: bigint;
  /** Optional scenario label for comparison reports. */
  scenarioLabel?: string;
}

/** Result of simulating one intent against one policy set. */
export interface PolicySimulationResult {
  /** The simulated intent. */
  intent: ActionIntent;
  /** The Action derived from the intent (what the orchestrator would see). */
  action: Action;
  /** Per-policy decisions, in evaluation order. */
  policyDecisions: PolicyDecisionRecord[];
  /** Overall guard decision (AND of all policies, fail-closed on throws). */
  guardDecision: GuardDecision;
  /** Server-derived risk class (never client-supplied). */
  riskClass: ActionRiskClass;
  /** Static floor approval class from riskClass → approval mapping. */
  baseApprovalClass: ApprovalClass;
  /** Effective approval class after contextual + reputation fusion. */
  effectiveApprovalClass: ApprovalClass;
  /** True only if guard allows AND effective class is not "deny". */
  wouldAllow: boolean;
  /** Human-readable adapter decision: allowed | approval_required | denied. */
  adapterDecision: "allowed" | "approval_required" | "denied";
  /** Predicted-effect simulation (dry-run of the action itself). */
  simulation: SimulationResult;
  /** Contextual risk escalation result (signals + explanations). */
  contextualRisk: ContextualRiskResult;
  /** Full risk-intelligence fusion (only present when reputationScore was supplied). */
  riskAssessment?: RiskAssessment;
  /** Preview of the DecisionTrace that would be created (only if signer provided). */
  decisionTracePreview?: DecisionTrace;
  /** Kill-switch verdict (only if killSwitch was consulted). */
  killSwitchVerdict?: { tripped: boolean; scope?: string; reason?: string };
  /** Human-readable summary sentence. */
  summary: string;
  /** Scenario label from input (for comparison reports). */
  scenarioLabel?: string;
}

/** Comparison of multiple scenarios. */
export interface ScenarioComparison {
  /** Results for each scenario, in input order. */
  scenarios: PolicySimulationResult[];
  /** Human-readable differences between scenarios. */
  differences: string[];
  /** Points all scenarios agree on. */
  consensus: string[];
}

/**
 * Build an Action from an ActionIntent.
 * The action id is the intent nonce (unique, replay-protected).
 */
function actionFromIntent(intent: ActionIntent): Action {
  const isFinancial =
    intent.riskClass === "value_moving" ||
    intent.riskClass === "regulated";
  // Autonomous = not from an interactive human session (heuristic: provenance !== "human").
  const isAutonomous = intent.provenance !== "human";
  return {
    id: intent.nonce,
    tenantId: intent.tenantId,
    type: intent.toolId,
    payload: {
      resourceRef: intent.resourceRef,
      valueMicrounits: intent.valueMicrounits,
      privacyLevel: intent.privacyLevel,
      approvalPolicyRef: intent.approvalPolicyRef,
      evidencePolicy: intent.evidencePolicy,
    },
    source: intent.actorId,
    isFinancial,
    isAutonomous,
    requestedAt: intent.expiry, // best available timestamp
  };
}

/** Map an ApprovalClass to the adapter-facing decision. */
function adapterDecisionFromApprovalClass(ac: ApprovalClass): "allowed" | "approval_required" | "denied" {
  if (ac === "auto") return "allowed";
  if (ac === "deny") return "denied";
  return "approval_required";
}

/**
 * runPolicySimulation — simulate ONE intent against ONE policy set.
 * Pure. Zero side-effects. Does NOT write audit records or open workflows.
 */
export async function runPolicySimulation(input: PolicySimulationInput): Promise<PolicySimulationResult> {
  if (!input || typeof input !== "object") {
    throw new Error("runPolicySimulation: input must be an object");
  }
  if (!Array.isArray(input.policies)) {
    throw new Error("runPolicySimulation: policies must be an array");
  }

  // 1. Validate intent (fail-closed).
  const intent = validateActionIntent(input.intent);

  // 2. Build Action + Context.
  const action = actionFromIntent(intent);
  const ctx: ActionContext = {
    action,
    tenantId: action.tenantId,
    timestamp: new Date().toISOString(),
    // TS-CFA: RiskContext is an interface (no implicit index signature), so a
    // shallow copy is used to satisfy ActionContext's Record<string, unknown>.
    riskContext: input.riskContext ? { ...input.riskContext } : undefined,
  };

  // 3. Server-side risk classification (never trusts client claim).
  const { riskClass: serverRiskClass } = classifyActionServerSide(action.type);
  ctx.riskClass = serverRiskClass;

  // 3b. Synchronise action flags with server-derived classification so guard
  // policies (e.g. denyFinancial) see a consistent picture.
  action.isFinancial = serverRiskClass === "value_moving" || serverRiskClass === "regulated";

  // 4. Evaluate each policy individually (for visibility), AND derive the
  // overall guard decision in the SAME pass (step 5 below used to construct a
  // fresh GuardEvaluator and call .evaluate(ctx) again here, which re-ran
  // every policy.evaluate() a second time — real work, not just iteration,
  // since policies can be arbitrarily expensive). The merged loop below
  // mirrors GuardEvaluator's exact branching so the derived guardDecision is
  // byte-for-byte identical to what a second evaluate() call would return:
  // a thrown exception's raw message is the final reason as-is; an explicit
  // deny decision's reason is wrapped as `policy "X" denied: ...`; the first
  // failure wins (GuardEvaluator's short-circuit), but — unlike
  // GuardEvaluator — every policy still runs here, for full simulator
  // visibility into each individual decision.
  const policyDecisions: PolicyDecisionRecord[] = [];
  let guardDecision: GuardDecision | undefined;
  for (const policy of input.policies) {
    const t0 = performance.now();
    let decision: GuardDecision;
    try {
      decision = await Promise.resolve(policy.evaluate(ctx)) as GuardDecision;
      // Normalise: ensure it's a valid decision object.
      if (!decision || typeof decision !== "object") {
        decision = { allow: false, reason: `policy "${policy.name}" returned non-decision (fail-closed)` };
      }
      if (!decision.allow && !guardDecision) {
        guardDecision = { allow: false, reason: `policy "${policy.name}" denied: ${decision.reason}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      decision = { allow: false, reason: `fail-closed: policy "${policy.name}" threw: ${msg}` };
      if (!guardDecision) {
        guardDecision = { allow: false, reason: `fail-closed: policy "${policy.name}" threw: ${msg}` };
      }
    }
    policyDecisions.push({ name: policy.name, decision, ms: Math.round(performance.now() - t0) });
  }

  // 5. Overall guard decision (AND semantics, same as GuardEvaluator) —
  // already computed above for the all-pass case; only the zero-policy
  // special case (GuardEvaluator's fail-closed-for-financial/autonomous
  // branch) and the all-allow fallthrough still need to be filled in here.
  if (!guardDecision) {
    guardDecision = input.policies.length === 0
      ? (action.isFinancial || action.isAutonomous
          ? {
              allow: false,
              reason:
                "fail-closed: no guard policies registered for " +
                (action.isFinancial ? "financial" : "autonomous") +
                " action",
            }
          : { allow: true })
      : { allow: true };
  }

  // 6. Resolve base approval class from server-derived risk class.
  const baseApprovalClass = resolveApprovalClass(serverRiskClass);

  // 7. Contextual risk scoring.
  const riskCtx: RiskContext = {
    ...(input.riskContext ?? {}),
    valueMicrounits: intent.valueMicrounits,
    ...(input.valueEscalationThreshold !== undefined ? { valueEscalationThreshold: input.valueEscalationThreshold } : {}),
  };

  let contextualRisk: ContextualRiskResult;
  try {
    contextualRisk = scoreContextualRisk(baseApprovalClass, riskCtx);
  } catch {
    contextualRisk = {
      baseApprovalClass,
      effectiveApprovalClass: "deny",
      escalated: true,
      signals: [{ signal: "contextual_risk_error", escalateTo: "deny" as ApprovalClass, detail: "contextual risk scoring threw" }],
      explanation: ["contextual risk scoring failed → deny (fail-closed)"],
    };
  }

  // 8. Reputation / risk-intelligence fusion (if reputationScore provided).
  let riskAssessment: RiskAssessment | undefined;
  let effectiveApprovalClass: ApprovalClass;
  if (input.reputationScore !== undefined) {
    try {
      riskAssessment = assessRisk({ baseApprovalClass, context: riskCtx, reputationScore: input.reputationScore });
      effectiveApprovalClass = riskAssessment.effectiveApprovalClass;
    } catch {
      // fail-closed: bad reputation input → deny
      const band = reputationBand(input.reputationScore);
      riskAssessment = {
        riskScore: 100,
        baseApprovalClass,
        effectiveApprovalClass: "deny",
        escalated: true,
        reputationBand: band,
        // fail-closed catch path: no drift signal was ever supplied or applied here
        driftApplied: false,
        factors: [{ factor: "risk_intelligence_error", contribution: 100, detail: "risk intelligence fusion threw" }],
        contextual: contextualRisk,
        explanation: ["risk intelligence fusion failed → deny (fail-closed)"],
      };
      effectiveApprovalClass = "deny";
    }
  } else {
    effectiveApprovalClass = contextualRisk.effectiveApprovalClass;
  }

  // 9. Action simulation (predicted effect).
  let simulation: SimulationResult;
  try {
    simulation = simulateAction({ actionType: action.type, valueMicrounits: intent.valueMicrounits, resourceRef: intent.resourceRef });
  } catch {
    // fail-closed: if simulateAction throws, produce a worst-case preview.
    simulation = {
      actionType: action.type,
      riskClass: serverRiskClass,
      riskSource: "fail_closed_default",
      reversible: false,
      blastRadius: "unknown",
      predictedEffect: `Simulation failed for "${action.type}": effect cannot be predicted — assume irreversible.`,
      requiresBackup: true,
      warnings: ["simulation error: assume worst-case (irreversible, unknown blast radius)"],
      simulatedAt: new Date().toISOString(),
    };
  }

  // 10. Adapter decision from effective class, but override to denied if guard denies.
  let adapterDecision: "allowed" | "approval_required" | "denied";
  if (!guardDecision.allow) {
    adapterDecision = "denied";
  } else {
    adapterDecision = adapterDecisionFromApprovalClass(effectiveApprovalClass);
  }

  // 11. Kill-switch check (if provided).
  let killSwitchVerdict: PolicySimulationResult["killSwitchVerdict"];
  if (input.killSwitch) {
    const ksResult = applyKillSwitch(adapterDecision, input.killSwitch, { tenantId: intent.tenantId, actionType: action.type });
    adapterDecision = ksResult.decision as "allowed" | "approval_required" | "denied";
    killSwitchVerdict = ksResult.killSwitch;
  }

  // 12. Decision trace preview (if signer provided).
  let decisionTracePreview: DecisionTrace | undefined;
  if (input.signer) {
    try {
      decisionTracePreview = createDecisionTrace(
        ctx,
        effectiveApprovalClass,
        input.signer,
        "policy-simulator",
        simulation,
        contextualRisk,
        riskAssessment,
      );
    } catch {
      // Advisory: trace preview is optional.
    }
  }

  // 13. Final "would allow" — guard AND effective class must both permit.
  const wouldAllow = guardDecision.allow === true && effectiveApprovalClass !== "deny" && adapterDecision !== "denied";

  // 14. Summary.
  const guardStatus = guardDecision.allow ? "guard=allow" : `guard=deny (${guardDecision.reason})`;
  const classStatus = `${baseApprovalClass} → ${effectiveApprovalClass}`;
  const simStatus = `${simulation.reversible ? "reversible" : "IRREVERSIBLE"}, blast=${simulation.blastRadius}`;
  const summary = wouldAllow
    ? `WOULD ALLOW: ${intent.toolId} on ${intent.resourceRef} | ${guardStatus} | class=${classStatus} | ${simStatus}`
    : `WOULD DENY: ${intent.toolId} on ${intent.resourceRef} | ${guardStatus} | class=${classStatus} | ${simStatus}`;

  return {
    intent,
    action,
    policyDecisions,
    guardDecision,
    riskClass: serverRiskClass,
    baseApprovalClass,
    effectiveApprovalClass,
    wouldAllow,
    adapterDecision,
    simulation,
    contextualRisk,
    riskAssessment,
    decisionTracePreview,
    killSwitchVerdict,
    summary,
    scenarioLabel: input.scenarioLabel,
  };
}

/**
 * compareScenarios — run multiple policy simulations and compute differences + consensus.
 *
 * Typical use: compare the SAME intent under different policy sets (e.g.
 * "current governance" vs "proposed governance") to see what changes.
 */
export async function compareScenarios(inputs: PolicySimulationInput[]): Promise<ScenarioComparison> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("compareScenarios: inputs must be a non-empty array");
  }

  const scenarios: PolicySimulationResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const label = input.scenarioLabel ?? `scenario-${i + 1}`;
    scenarios.push(await runPolicySimulation({ ...input, scenarioLabel: label }));
  }

  const differences: string[] = [];
  const consensus: string[] = [];

  // Consensus / differences on wouldAllow.
  const allAllow = scenarios.every((s) => s.wouldAllow);
  const allDeny = scenarios.every((s) => !s.wouldAllow);
  if (allAllow) {
    consensus.push("All scenarios would ALLOW this intent.");
  } else if (allDeny) {
    consensus.push("All scenarios would DENY this intent.");
  } else {
    // Single-pass partition: every scenario is in exactly one bucket (allow
    // or deny), so one loop suffices instead of filter+map twice (4 passes).
    const allowLabels: string[] = [];
    const denyLabels: string[] = [];
    for (const [i, s] of scenarios.entries()) {
      // scenarioLabel is always set by the loop above (scenario-${i + 1}); the
      // fallback only satisfies the optional field's type, matching that naming.
      const label = s.scenarioLabel ?? `scenario-${i + 1}`;
      if (s.wouldAllow) allowLabels.push(label);
      else denyLabels.push(label);
    }
    differences.push(`Allow/deny split: ALLOW in [${allowLabels.join(", ")}] vs DENY in [${denyLabels.join(", ")}].`);
  }

  // Consensus / differences on effectiveApprovalClass.
  const firstClass = scenarios[0].effectiveApprovalClass;
  const allSameClass = scenarios.every((s) => s.effectiveApprovalClass === firstClass);
  if (allSameClass) {
    consensus.push(`Effective approval class is "${firstClass}" in all scenarios.`);
  } else {
    for (let i = 1; i < scenarios.length; i++) {
      if (scenarios[i].effectiveApprovalClass !== firstClass) {
        differences.push(
          `Approval class differs: "${scenarios[0].scenarioLabel}" → ${firstClass}, "${scenarios[i].scenarioLabel}" → ${scenarios[i].effectiveApprovalClass}.`,
        );
      }
    }
  }

  // Consensus / differences on riskScore (when present).
  const scored = scenarios.filter((s) => s.riskAssessment !== undefined);
  if (scored.length > 1) {
    const firstScore = scored[0].riskAssessment!.riskScore;
    const allSameScore = scored.every((s) => s.riskAssessment!.riskScore === firstScore);
    if (allSameScore) {
      consensus.push(`Risk score ${firstScore}/100 is identical across all scored scenarios.`);
    } else {
      for (let i = 1; i < scored.length; i++) {
        if (scored[i].riskAssessment!.riskScore !== firstScore) {
          differences.push(
            `Risk score differs: "${scored[0].scenarioLabel}" = ${firstScore}, "${scored[i].scenarioLabel}" = ${scored[i].riskAssessment!.riskScore}.`,
          );
        }
      }
    }
  }

  // Consensus / differences on guard policy denials.
  const deniedScenarios = scenarios.filter((s) => !s.guardDecision.allow);
  if (deniedScenarios.length > 0) {
    for (const ds of deniedScenarios) {
      // Single-pass: collect names of denying policies without building an
      // intermediate filtered array first.
      const denyingPolicies: string[] = [];
      for (const pd of ds.policyDecisions) {
        if (!pd.decision.allow) denyingPolicies.push(pd.name);
      }
      differences.push(`"${ds.scenarioLabel}" denied by policy(s): [${denyingPolicies.join(", ")}].`);
    }
  }

  // Blast radius consensus.
  const firstBlast = scenarios[0].simulation.blastRadius;
  const allSameBlast = scenarios.every((s) => s.simulation.blastRadius === firstBlast);
  if (allSameBlast) {
    consensus.push(`Blast radius "${firstBlast}" is identical across all scenarios.`);
  } else {
    for (let i = 1; i < scenarios.length; i++) {
      if (scenarios[i].simulation.blastRadius !== firstBlast) {
        differences.push(
          `Blast radius differs: "${scenarios[0].scenarioLabel}" = ${firstBlast}, "${scenarios[i].scenarioLabel}" = ${scenarios[i].simulation.blastRadius}.`,
        );
      }
    }
  }

  return { scenarios, differences, consensus };
}
