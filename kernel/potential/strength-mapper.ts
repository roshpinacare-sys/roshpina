/**
 * lib/potential/strength-mapper.ts — StrengthMapper.
 *
 * Computes a StrengthProfile from raw KnowledgeSignals and AnalyticsSignals.
 *
 * Algorithm:
 *   1. Filter signals: only include entries matching (userId, tenantId) of input.
 *      This enforces tenant isolation — no cross-tenant leakage.
 *   2. Group by category.
 *   3. For each category:
 *      - score = average of all signal contributions (weight|value × 100), 0–100.
 *      - confidence = min(1, signalCount / 5). Five signals = full confidence.
 *      - evidence = unique signal source labels (nodeType / eventType).
 *
 * Zero external dependencies.
 */

import type {
  AnalysisInput,
  KnowledgeSignal,
  AnalyticsSignal,
  StrengthCategory,
  StrengthProfile,
  UserStrength,
} from "./types";

interface CategoryAccumulator {
  totalContribution: number;
  count: number;
  evidence: Set<string>;
}

export class StrengthMapper {
  /**
   * Map raw signals to a StrengthProfile for the given user and tenant.
   *
   * Signals that do not match (input.userId, input.tenantId) are silently
   * discarded — this is the tenant isolation boundary.
   */
  map(input: AnalysisInput): StrengthProfile {
    const { userId, tenantId } = input;
    const byCategory = new Map<StrengthCategory, CategoryAccumulator>();

    const accFor = (cat: StrengthCategory): CategoryAccumulator => {
      if (!byCategory.has(cat)) {
        byCategory.set(cat, { totalContribution: 0, count: 0, evidence: new Set() });
      }
      return byCategory.get(cat)!;
    };

    // Knowledge Graph signals
    for (const sig of input.knowledgeSignals) {
      if (!this.matchesTenant(sig, userId, tenantId)) continue;
      const acc = accFor(sig.category);
      // weight is 0–1; contribution to 0–100 score scale
      acc.totalContribution += Math.max(0, Math.min(1, sig.weight)) * 100;
      acc.count++;
      acc.evidence.add(sig.nodeType);
    }

    // Analytics signals
    for (const sig of input.analyticsSignals) {
      if (!this.matchesTenant(sig, userId, tenantId)) continue;
      const acc = accFor(sig.category);
      // value is 0–1; contribution to 0–100 score scale
      acc.totalContribution += Math.max(0, Math.min(1, sig.value)) * 100;
      acc.count++;
      acc.evidence.add(sig.eventType);
    }

    // Build strengths from accumulators
    const strengths: UserStrength[] = [];
    for (const [category, acc] of byCategory) {
      const score = acc.count > 0
        ? Math.round(acc.totalContribution / acc.count)
        : 0;
      const confidence = Math.min(1, acc.count / 5);
      strengths.push({
        category,
        score: Math.min(100, score),
        confidence,
        evidence: Array.from(acc.evidence),
      });
    }

    return {
      userId,
      tenantId,
      strengths,
      analyzedAt: new Date().toISOString(),
    };
  }

  private matchesTenant(
    sig: KnowledgeSignal | AnalyticsSignal,
    userId: string,
    tenantId: string,
  ): boolean {
    return sig.userId === userId && sig.tenantId === tenantId;
  }
}
