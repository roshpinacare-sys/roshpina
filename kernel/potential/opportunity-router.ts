/**
 * lib/potential/opportunity-router.ts — OpportunityRouter.
 *
 * Matches a StrengthProfile against a catalog of Opportunities and returns
 * ranked OpportunityMatches.
 *
 * Algorithm:
 *   For each opportunity in the same tenant as the profile:
 *   1. If no required strengths → fitScore = 100 (open to everyone).
 *   2. For each required strength, compute ratio = userScore / minScore (capped at 1).
 *   3. fitScore = round(average of all ratios × 100), 0–100.
 *   4. matchedStrengths = categories where userScore >= minScore.
 *   5. missingStrengths = categories where userScore < minScore, with gap.
 *
 * Matches are sorted by fitScore descending (best fit first).
 * Tenant isolation: opportunities whose tenantId ≠ profile.tenantId are skipped.
 *
 * Zero external dependencies.
 */

import type {
  Opportunity,
  OpportunityMatch,
  StrengthProfile,
  StrengthCategory,
} from "./types";

export class OpportunityRouter {
  /**
   * Route a StrengthProfile against an opportunity catalog.
   *
   * Only opportunities whose tenantId matches profile.tenantId are considered.
   * Returns all matched entries sorted by fitScore descending.
   */
  route(profile: StrengthProfile, opportunities: Opportunity[]): OpportunityMatch[] {
    const strengthMap = new Map<StrengthCategory, number>(
      profile.strengths.map((s) => [s.category, s.score]),
    );

    const matches: OpportunityMatch[] = [];

    for (const opp of opportunities) {
      // Tenant isolation boundary
      if (opp.tenantId !== profile.tenantId) continue;

      if (opp.requiredStrengths.length === 0) {
        // No requirements — open to everyone, perfect fit
        matches.push({
          opportunity: opp,
          fitScore: 100,
          matchedStrengths: [],
          missingStrengths: [],
        });
        continue;
      }

      const matchedStrengths: StrengthCategory[] = [];
      const missingStrengths: Array<{ category: StrengthCategory; gap: number }> = [];
      const ratios: number[] = [];

      for (const req of opp.requiredStrengths) {
        const userScore = strengthMap.get(req.category) ?? 0;
        const ratio = req.minScore > 0 ? Math.min(1, userScore / req.minScore) : 1;
        ratios.push(ratio);

        if (userScore >= req.minScore) {
          matchedStrengths.push(req.category);
        } else {
          missingStrengths.push({
            category: req.category,
            gap: Math.round(req.minScore - userScore),
          });
        }
      }

      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const fitScore = Math.round(avgRatio * 100);

      matches.push({
        opportunity: opp,
        fitScore,
        matchedStrengths,
        missingStrengths,
      });
    }

    // Best fit first
    matches.sort((a, b) => b.fitScore - a.fitScore);
    return matches;
  }
}
