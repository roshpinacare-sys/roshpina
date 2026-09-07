/**
 * lib/potential/personality-types.ts — Types for PersonalityMapping subsystem.
 *
 * Extends the Potential Engine with deep personality trait extraction,
 * success path routing (learning paths), and collaboration matching.
 *
 * Design principles:
 *   • Tenant + user isolation enforced at every boundary.
 *   • Zero external dependencies — pure computation.
 *   • All types are immutable (readonly) by default.
 *   • Scores: 0–100. Confidence: 0–1. Compatibility: 0–100.
 */

import type { StrengthProfile, StrengthCategory, ISOTimestamp } from "./types";

// ─── Personality Traits ───────────────────────────────────────────────────────

/**
 * The five core personality dimensions extracted from KG signals.
 * Each dimension is a score 0–100.
 *
 *   extroversion  — prefers collaboration and visible roles vs. solo deep-work.
 *   focus         — ability to sustain concentrated effort on a single problem.
 *   collaboration — comfort working in groups, sharing credit, co-creating.
 *   creativity    — tendency toward novel approaches, ideation, divergent thinking.
 *   leadership    — drive to guide others, take initiative, accept responsibility.
 */
export interface PersonalityTraits {
  extroversion: number;   // 0–100
  focus: number;          // 0–100
  collaboration: number;  // 0–100
  creativity: number;     // 0–100
  leadership: number;     // 0–100
}

/**
 * A single piece of evidence that contributed to a trait score.
 * Records which KG nodeType or analytics eventType drove the score and by how much.
 */
export interface TraitEvidence {
  source: string;   // nodeType or eventType
  trait: keyof PersonalityTraits;
  contribution: number;  // 0–100 (the delta this source added)
}

/**
 * The full personality profile for a user within a tenant.
 * Output of PersonalityMapper.map().
 */
export interface PersonalityProfile {
  userId: string;
  tenantId: string;
  traits: PersonalityTraits;
  /** Evidence breakdown per trait — useful for explainability. */
  evidence: TraitEvidence[];
  /** Confidence per trait: 0–1, min(1, signalCount/5) per trait. */
  confidence: Record<keyof PersonalityTraits, number>;
  analyzedAt: ISOTimestamp;
}

/**
 * An enriched StrengthProfile that also carries personality traits.
 * Produced when PersonalityMapper enriches a base StrengthProfile.
 */
export interface EnrichedProfile extends StrengthProfile {
  personality: PersonalityProfile;
}

// ─── Success Path (Learning Path) ─────────────────────────────────────────────

/**
 * A single learning step that helps close a strength gap.
 *
 * estimatedHours is intentionally a rough estimate — the system is honest
 * about uncertainty. difficulty: 1 (easy) → 5 (hard).
 */
export interface LearningStep {
  id: string;
  title: string;
  description: string;
  targetCategory: StrengthCategory;
  /** Expected score increase after completing this step, 0–100. */
  expectedGain: number;
  /** Rough effort estimate in hours. */
  estimatedHours: number;
  /** 1 = easy, 5 = very hard. */
  difficulty: 1 | 2 | 3 | 4 | 5;
}

/**
 * A complete success path: an ordered sequence of learning steps that
 * moves a user from their current StrengthProfile toward a target opportunity.
 *
 * Steps are ordered: complete step[0] before step[1], etc.
 * totalHours = sum of estimatedHours across all steps.
 * projectedFitScore: estimated fitScore against the target opportunity
 *   after completing all steps (capped at 100).
 */
export interface SuccessPath {
  id: string;
  userId: string;
  tenantId: string;
  /** The opportunity this path is designed to reach. */
  targetOpportunityId: string;
  /** Current fitScore before any learning. */
  currentFitScore: number;
  /** Projected fitScore after completing all steps. */
  projectedFitScore: number;
  steps: LearningStep[];
  totalHours: number;
  createdAt: ISOTimestamp;
}

/** Input to SuccessPathRouter.plan(). */
export interface SuccessPathInput {
  userId: string;
  tenantId: string;
  profile: StrengthProfile;
  /** The target opportunity the user wants to reach. Must be same tenantId. */
  targetOpportunityId: string;
  /** Current gaps: categories where the user is below required score. */
  gaps: Array<{ category: StrengthCategory; gap: number }>;
}

// ─── Collaboration Matching ───────────────────────────────────────────────────

/**
 * A collaboration match between two users in the same tenant.
 *
 * compatibilityScore: 0–100. Higher = better complementarity.
 * complementaryStrengths: categories where userA is weak and userB is strong (and vice versa).
 * sharedStrengths: categories where both users score high (≥50).
 * synergyReason: human-readable explanation of why this pairing works.
 */
export interface CollaborationMatch {
  userA: string;
  userB: string;
  tenantId: string;
  /** 0–100. Based on how well strengths complement each other. */
  compatibilityScore: number;
  /** Categories where one user's strength fills the other's gap. */
  complementaryStrengths: Array<{
    category: StrengthCategory;
    strongUser: string;
    weakUser: string;
    /** How much the strong user's score exceeds the weak user's. */
    delta: number;
  }>;
  /** Categories where both users score ≥ 50. */
  sharedStrengths: StrengthCategory[];
  synergyReason: string;
  matchedAt: ISOTimestamp;
}

/** Input to CollaborationMatcher.match(). */
export interface CollaborationInput {
  tenantId: string;
  /** The user looking for collaborators. */
  userId: string;
  userProfile: StrengthProfile;
  /** Pool of candidate collaborators (must be same tenantId). */
  candidates: Array<{ userId: string; profile: StrengthProfile }>;
  /** Minimum compatibility score to include in results. Default: 40. */
  minCompatibility?: number;
}
