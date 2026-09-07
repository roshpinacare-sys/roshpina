/**
 * lib/potential/index.ts — barrel export for the Potential Engine module.
 *
 * Public API:
 *   PotentialEngine — main entry point (analyze + route via TfaOrchestrator).
 *   StrengthMapper  — maps KG + analytics signals to a StrengthProfile.
 *   OpportunityRouter — matches a StrengthProfile to Opportunities.
 *   Types           — all shared types.
 */

export { PotentialEngine } from "./potential-engine";
export type { PassportIssuanceOptions } from "./potential-engine";
export { CollaborationEscrowBridge, COLLABORATION_ESCROW_ACTION_TYPE } from "./collaboration-escrow-bridge";
export type { CollaborationEscrowInput, CollaborationEscrowResult, EscrowPassportOptions } from "./collaboration-escrow-bridge";
export { StrengthMapper } from "./strength-mapper";
export { OpportunityRouter } from "./opportunity-router";
export { PersonalityMapper, DEFAULT_TRAIT_MAP } from "./personality-mapper";
export { SuccessPathRouter } from "./success-path-router";
export { CollaborationMatcher } from "./collaboration-matcher";
export { InMemoryKnowledgeGraphSource } from "./in-memory-kg-source";
export { POTENTIAL_ACTION_TYPES } from "./types";
export type { PotentialActionType } from "./types";
export type {
  KnowledgeSignal,
  AnalyticsSignal,
  UserStrength,
  StrengthProfile,
  Opportunity,
  OpportunityMatch,
  RoutingDecision,
  AnalysisInput,
  RoutingInput,
  StrengthCategory,
  ISOTimestamp,
  PotentialEngineResult,
  KnowledgeGraphSource,
} from "./types";
export type {
  PersonalityTraits,
  PersonalityProfile,
  TraitEvidence,
  EnrichedProfile,
  LearningStep,
  SuccessPath,
  SuccessPathInput,
  CollaborationMatch,
  CollaborationInput,
} from "./personality-types";
