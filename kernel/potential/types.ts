/**
 * lib/potential/types.ts — TFA Potential Engine: shared types.
 *
 * The Potential Engine is the core vision of TFA:
 *   1. Map the strengths of a user (from Knowledge Graph + Analytics signals).
 *   2. Route to opportunities that match those strengths.
 *   3. Every routing decision flows through TfaOrchestrator (guard + audit).
 *
 * All operations are autonomous (isAutonomous: true) → fail-closed:
 * the engine WILL NOT run without at least one registered guard policy.
 *
 * Tenant isolation is enforced at every layer:
 *   • Signals are filtered by tenantId + userId before computation.
 *   • Opportunities are matched only within the same tenantId.
 *   • Audit records are per-tenant chains.
 *
 * Zero external dependencies.
 */

// ─── Action types ─────────────────────────────────────────────────────────────

/**
 * Canonical action-type strings used by PotentialEngine when calling
 * TfaOrchestrator.run(). Include these in your guard policy allowlist so
 * potential.analyze / potential.route pass the ledger-allowlist policy.
 *
 * Usage in composition:
 *   import { POTENTIAL_ACTION_TYPES } from "../lib/potential/types";
 *   const known = [...Object.values(LEDGER_ACTION_TYPES), ...Object.values(POTENTIAL_ACTION_TYPES)];
 */
export const POTENTIAL_ACTION_TYPES = {
  ANALYZE:              "potential.analyze",
  ROUTE:                "potential.route",
  PERSONALITY:          "potential.personality",
  COLLABORATION_ESCROW: "potential.collaboration.escrow",
  COLLABORATION_COMPLETE: "potential.collaboration.complete",
} as const;

export type PotentialActionType =
  (typeof POTENTIAL_ACTION_TYPES)[keyof typeof POTENTIAL_ACTION_TYPES];

// ─── Primitives ───────────────────────────────────────────────────────────────

/** ISO-8601 timestamp string. */
export type ISOTimestamp = string;

/**
 * A strength category label.
 * Open-ended string (e.g. "technical", "leadership", "creative", "analytical").
 */
export type StrengthCategory = string;

// ─── Signals (raw inputs to StrengthMapper) ───────────────────────────────────

/**
 * KnowledgeSignal — a signal derived from a Knowledge Graph node.
 *
 * Represents a concrete skill, achievement, project, or connection that
 * contributes to a user's strength in a given category.
 *
 * weight: 0–1. Higher = stronger evidence for this category.
 */
export interface KnowledgeSignal {
  userId: string;
  tenantId: string;
  /** The KG node type, e.g. "skill", "achievement", "project". Used as evidence label. */
  nodeType: string;
  category: StrengthCategory;
  /** Contribution weight, 0–1. */
  weight: number;
}

/**
 * AnalyticsSignal — a signal derived from a tracked analytics event.
 *
 * Represents a user behaviour (task completion, workflow execution, etc.)
 * that contributes to a strength category.
 *
 * value: 0–1. Higher = stronger evidence.
 */
export interface AnalyticsSignal {
  userId: string;
  tenantId: string;
  /** The analytics event type, e.g. "task.completed", "workflow.run". Used as evidence label. */
  eventType: string;
  category: StrengthCategory;
  /** Contribution value, 0–1. */
  value: number;
}

// ─── Computed strengths ───────────────────────────────────────────────────────

/**
 * UserStrength — a computed strength for a single category.
 *
 * score: 0–100. Average of all signal contributions (weight|value × 100).
 * confidence: 0–1. Grows with signal count; saturates at 1 after 5+ signals.
 * evidence: unique signal source types (nodeType / eventType) that contributed.
 */
export interface UserStrength {
  category: StrengthCategory;
  /** Weighted average score, 0–100. */
  score: number;
  /** Confidence in the score, 0–1. min(1, signalCount / 5). */
  confidence: number;
  /** Unique evidence labels (signal source types) that contributed. */
  evidence: string[];
}

/**
 * StrengthProfile — the full computed strength map for a user.
 *
 * Output of StrengthMapper.map(). Input to OpportunityRouter.route().
 */
export interface StrengthProfile {
  userId: string;
  tenantId: string;
  strengths: UserStrength[];
  analyzedAt: ISOTimestamp;
}

// ─── Opportunities ────────────────────────────────────────────────────────────

/**
 * Opportunity — a role, project, or challenge that a user can be routed to.
 *
 * requiredStrengths: the minimum scores the user must have in each category
 * for the opportunity to be a strong match. An empty list = open to everyone.
 */
export interface Opportunity {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  requiredStrengths: Array<{ category: StrengthCategory; minScore: number }>;
  /**
   * Optional budget in μ¢ (micro-cents, BigInt). When present, a claim on this
   * opportunity automatically creates + funds an escrow agreement so payment is
   * contingent on completion rather than just claiming.
   */
  budget?: bigint;
}

/**
 * OpportunityMatch — the result of matching a user profile to one opportunity.
 *
 * fitScore: 0–100. How well the user meets all requirements.
 * matchedStrengths: categories where the user meets or exceeds minScore.
 * missingStrengths: categories where the user is below minScore, with the gap.
 */
export interface OpportunityMatch {
  opportunity: Opportunity;
  /** 0–100. Average of (userScore / requiredScore) across all requirements. */
  fitScore: number;
  matchedStrengths: StrengthCategory[];
  missingStrengths: Array<{ category: StrengthCategory; gap: number }>;
}

/**
 * RoutingDecision — the full output of a route() call.
 *
 * Contains the computed profile and all ranked opportunity matches.
 * Matches are sorted by fitScore descending (best fit first).
 */
export interface RoutingDecision {
  userId: string;
  tenantId: string;
  profile: StrengthProfile;
  /** All matched opportunities, sorted by fitScore descending. */
  matches: OpportunityMatch[];
  decidedAt: ISOTimestamp;
}

// ─── Engine inputs ────────────────────────────────────────────────────────────

/** Input to PotentialEngine.analyze() and StrengthMapper.map(). */
export interface AnalysisInput {
  userId: string;
  tenantId: string;
  knowledgeSignals: KnowledgeSignal[];
  analyticsSignals: AnalyticsSignal[];
}

/** Input to PotentialEngine.route(). Extends AnalysisInput with opportunities. */
export interface RoutingInput extends AnalysisInput {
  opportunities: Opportunity[];
}

// ─── Knowledge Graph Source ───────────────────────────────────────────────────

/**
 * KnowledgeGraphSource — abstraction over a real Knowledge Graph data store.
 *
 * Implementations:
 *   • InMemoryKnowledgeGraphSource — tests / local dev (zero external deps).
 *   • PgKnowledgeGraphSource        — PostgreSQL-backed production store.
 *
 * Tenant isolation invariant:
 *   fetchSignals() MUST only return signals whose tenantId matches the query.
 */
export interface KnowledgeGraphSource {
  /** Fetch KnowledgeSignals for a specific user within a tenant. */
  fetchSignals(userId: string, tenantId: string): Promise<KnowledgeSignal[]>;
}

// ─── Engine result ────────────────────────────────────────────────────────────

import type { AuditId } from "../orchestrator/types";
import type { ActionPassport } from "../passport/types";

/**
 * PotentialEngineResult<R> — outcome of PotentialEngine.analyze() / route().
 *
 * Extends OrchestrationResult with an optional passport on the ok=true branch.
 * The passport is present when a Signer is wired into the engine (auto-issuance).
 * When no signer is configured, `passport` is absent (backward compat).
 *
 * Both branches always carry `auditId` for cross-referencing the audit chain.
 */
export type PotentialEngineResult<R> =
  | { ok: true; result: R; auditId: AuditId; passport?: ActionPassport }
  | { ok: false; reason: string; auditId: AuditId };
