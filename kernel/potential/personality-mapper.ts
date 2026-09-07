/**
 * lib/potential/personality-mapper.ts — PersonalityMapper.
 *
 * Extracts deep personality traits from KnowledgeSignals + AnalyticsSignals
 * and produces a PersonalityProfile.
 *
 * The five traits (extroversion, focus, collaboration, creativity, leadership)
 * are computed from a configurable signal→trait mapping table. Each signal
 * source (nodeType / eventType) maps to one or more traits with a weight.
 *
 * Algorithm:
 *   1. Filter signals by (userId, tenantId) — strict tenant isolation.
 *   2. For each signal, look up its source in the trait map.
 *      If the source is not in the map, a default weight of 0.2 is applied
 *      to the "closest" trait inferred from the signal's category label
 *      (loose heuristic — see inferTraitFromCategory).
 *   3. Accumulate: totalContribution[trait] += weight × 100.
 *   4. score[trait] = avg(contributions), capped 0–100.
 *   5. confidence[trait] = min(1, signalCount[trait] / 5).
 *
 * The default trait map covers common TFA signal types.
 * Pass a custom traitMap to override for your domain.
 *
 * Zero external dependencies.
 */

import type { KnowledgeSignal, AnalyticsSignal, AnalysisInput } from "./types";
import type {
  PersonalityTraits,
  PersonalityProfile,
  TraitEvidence,
} from "./personality-types";

/** Maps a signal source label to one or more (trait, weight) pairs. */
export type TraitMapping = Record<
  string,
  Array<{ trait: keyof PersonalityTraits; weight: number }>
>;

/**
 * Default trait map for TFA signal types.
 * Covers common KG nodeTypes and analytics eventTypes.
 */
export const DEFAULT_TRAIT_MAP: TraitMapping = {
  // KG nodeTypes
  "skill":            [{ trait: "focus", weight: 0.6 }, { trait: "creativity", weight: 0.3 }],
  "achievement":      [{ trait: "focus", weight: 0.7 }, { trait: "leadership", weight: 0.4 }],
  "project":          [{ trait: "collaboration", weight: 0.5 }, { trait: "leadership", weight: 0.4 }],
  "connection":       [{ trait: "extroversion", weight: 0.7 }, { trait: "collaboration", weight: 0.6 }],
  "mentorship":       [{ trait: "leadership", weight: 0.8 }, { trait: "extroversion", weight: 0.4 }],
  "publication":      [{ trait: "creativity", weight: 0.7 }, { trait: "focus", weight: 0.5 }],
  "certification":    [{ trait: "focus", weight: 0.8 }],
  "talk":             [{ trait: "extroversion", weight: 0.8 }, { trait: "leadership", weight: 0.5 }],
  "contribution":     [{ trait: "collaboration", weight: 0.6 }, { trait: "creativity", weight: 0.4 }],
  "review":           [{ trait: "collaboration", weight: 0.5 }, { trait: "focus", weight: 0.4 }],

  // Analytics eventTypes
  "task.completed":         [{ trait: "focus", weight: 0.6 }],
  "workflow.run":           [{ trait: "focus", weight: 0.5 }, { trait: "creativity", weight: 0.3 }],
  "collaboration.joined":   [{ trait: "collaboration", weight: 0.7 }, { trait: "extroversion", weight: 0.5 }],
  "presentation.delivered": [{ trait: "extroversion", weight: 0.8 }, { trait: "leadership", weight: 0.6 }],
  "idea.submitted":         [{ trait: "creativity", weight: 0.8 }],
  "team.led":               [{ trait: "leadership", weight: 0.9 }, { trait: "extroversion", weight: 0.4 }],
  "feedback.given":         [{ trait: "collaboration", weight: 0.6 }, { trait: "leadership", weight: 0.3 }],
  "deep.work.session":      [{ trait: "focus", weight: 0.9 }],
  "pair.programming":       [{ trait: "collaboration", weight: 0.7 }, { trait: "extroversion", weight: 0.3 }],
  "incident.resolved":      [{ trait: "focus", weight: 0.7 }, { trait: "leadership", weight: 0.5 }],
};

// ─── Trait inference heuristic ────────────────────────────────────────────────

const CATEGORY_TRAIT_HINTS: Array<[RegExp, keyof PersonalityTraits]> = [
  [/lead|manag|direct|exec/i,     "leadership"],
  [/collab|team|social|partner/i, "collaboration"],
  [/creat|innov|design|art/i,     "creativity"],
  [/focus|deep|special|expert/i,  "focus"],
  [/public|speak|present|extern/i,"extroversion"],
];

function inferTraitFromCategory(category: string): keyof PersonalityTraits {
  for (const [re, trait] of CATEGORY_TRAIT_HINTS) {
    if (re.test(category)) return trait;
  }
  return "focus"; // safe default
}

// ─── Accumulator ──────────────────────────────────────────────────────────────

interface TraitAcc {
  totalContribution: number;
  count: number;
}

type TraitAccMap = Record<keyof PersonalityTraits, TraitAcc>;

function emptyAccMap(): TraitAccMap {
  return {
    extroversion:  { totalContribution: 0, count: 0 },
    focus:         { totalContribution: 0, count: 0 },
    collaboration: { totalContribution: 0, count: 0 },
    creativity:    { totalContribution: 0, count: 0 },
    leadership:    { totalContribution: 0, count: 0 },
  };
}

// ─── PersonalityMapper ────────────────────────────────────────────────────────

export class PersonalityMapper {
  private readonly traitMap: TraitMapping;

  constructor(traitMap: TraitMapping = DEFAULT_TRAIT_MAP) {
    this.traitMap = traitMap;
  }

  /**
   * Map raw signals to a PersonalityProfile.
   *
   * Signals not matching (userId, tenantId) are silently discarded.
   * Unknown signal sources are handled via inferTraitFromCategory.
   */
  map(input: AnalysisInput): PersonalityProfile {
    const { userId, tenantId } = input;
    const acc = emptyAccMap();
    const evidenceList: TraitEvidence[] = [];

    // Process KG signals
    for (const sig of input.knowledgeSignals) {
      if (sig.userId !== userId || sig.tenantId !== tenantId) continue;
      this.applySignal(acc, evidenceList, sig.nodeType, sig.category, Math.max(0, Math.min(1, sig.weight)));
    }

    // Process analytics signals
    for (const sig of input.analyticsSignals) {
      if (sig.userId !== userId || sig.tenantId !== tenantId) continue;
      this.applySignal(acc, evidenceList, sig.eventType, sig.category, Math.max(0, Math.min(1, sig.value)));
    }

    // Build traits and confidence
    const traits: PersonalityTraits = {
      extroversion:  this.score(acc.extroversion),
      focus:         this.score(acc.focus),
      collaboration: this.score(acc.collaboration),
      creativity:    this.score(acc.creativity),
      leadership:    this.score(acc.leadership),
    };

    const confidence: Record<keyof PersonalityTraits, number> = {
      extroversion:  Math.min(1, acc.extroversion.count / 5),
      focus:         Math.min(1, acc.focus.count / 5),
      collaboration: Math.min(1, acc.collaboration.count / 5),
      creativity:    Math.min(1, acc.creativity.count / 5),
      leadership:    Math.min(1, acc.leadership.count / 5),
    };

    return {
      userId,
      tenantId,
      traits,
      evidence: evidenceList,
      confidence,
      analyzedAt: new Date().toISOString(),
    };
  }

  private applySignal(
    acc: TraitAccMap,
    evidenceList: TraitEvidence[],
    source: string,
    category: string,
    normalizedStrength: number, // 0–1
  ): void {
    const mappings = this.traitMap[source];

    if (mappings && mappings.length > 0) {
      for (const { trait, weight } of mappings) {
        const contribution = normalizedStrength * weight * 100;
        acc[trait].totalContribution += contribution;
        acc[trait].count++;
        evidenceList.push({ source, trait, contribution: Math.round(contribution) });
      }
    } else {
      // Unknown source: infer from category, apply default weight
      const trait = inferTraitFromCategory(category);
      const contribution = normalizedStrength * 0.2 * 100;
      acc[trait].totalContribution += contribution;
      acc[trait].count++;
      evidenceList.push({ source, trait, contribution: Math.round(contribution) });
    }
  }

  private score(a: TraitAcc): number {
    if (a.count === 0) return 0;
    return Math.min(100, Math.round(a.totalContribution / a.count));
  }
}
