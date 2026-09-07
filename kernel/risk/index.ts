/**
 * lib/risk/index.ts — Risk & Approval Policy barrel export.
 */

export {
  RISK_CLASSES,
  MOST_RESTRICTIVE_RISK_CLASS,
  ACTION_RISK_MAP,
  classifyRisk,
  isClassified,
  injectRiskClass,
} from "./action-risk";

export {
  APPROVAL_CLASSES,
  RISK_TO_APPROVAL_MAP,
  resolveApprovalClass,
  createDecisionTrace,
  approvalPolicyRouter,
} from "./approval-policy";

export type { DecisionTrace } from "./approval-policy";

export {
  CODING_ACTION_TYPES,
  CODING_ACTION_RISK_MAP,
  CODING_ACTION_METADATA,
  classifyCodingAction,
  isCodingAction,
  classifyActionServerSide,
  type CodingActionType,
  type CodingActionMeta,
} from "./coding-actions";

export {
  confidenceGate,
  verifyConfidenceGateTrace,
  validateConfig as validateConfidenceGateConfig,
  resolveScore,
  resolveVerdict,
  DEFAULT_CONFIDENCE_CONFIG,
  ConfidenceGateError,
  type ConfidenceGateConfig,
  type ConfidenceVerdict,
  type ConfidenceGateTrace,
} from "./confidence-gate";

export { simulateAction } from "./action-simulator";
export type { SimulationResult, SimulationInput, BlastRadius } from "./action-simulator";

export { scoreContextualRisk, maxApproval } from "./contextual-risk";
export type { RiskContext, RiskSignal, ContextualRiskResult } from "./contextual-risk";

export { assessRisk } from "./risk-intelligence";
export type { RiskAssessment, RiskIntelligenceInput, RiskFactor, ReputationBand } from "./risk-intelligence";

export { injectReputationScore } from "./reputation-policy";
export type { InjectReputationScoreOptions } from "./reputation-policy";

export {
  InMemoryActorBaselineStore,
  injectActorBaseline,
} from "./actor-baseline";
export type {
  ActorBaselineStore,
  ActorBaselineOptions,
  InjectActorBaselineOptions,
} from "./actor-baseline";

export {
  runPolicySimulation,
  compareScenarios,
} from "./policy-simulator";
export type {
  PolicySimulationInput,
  PolicySimulationResult,
  PolicyDecisionRecord,
  ScenarioComparison,
} from "./policy-simulator";

export { scoreRiskDrift } from "./risk-drift";
export type { DriftRecord, DriftFactor, RiskDriftResult } from "./risk-drift";

export { explainDriftCompliance } from "./drift-explain";
export type { DriftExplainInput, DriftComplianceReport, ExplainedFactor } from "./drift-explain";
