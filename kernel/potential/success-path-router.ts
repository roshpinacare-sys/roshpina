/**
 * lib/potential/success-path-router.ts — SuccessPathRouter.
 *
 * Computes an ordered learning path (SuccessPath) that moves a user from
 * their current StrengthProfile toward the requirements of a target opportunity.
 *
 * Unlike OpportunityRouter (which finds opportunities that already match),
 * SuccessPathRouter answers: "what steps would get me there?"
 *
 * Algorithm:
 *   1. Validate tenantId isolation — target opportunity must be same tenant.
 *   2. Compute current fitScore for the target opportunity.
 *   3. For each gap (category where userScore < minScore):
 *      a. Generate a LearningStep with expectedGain = min(gap, 30).
 *         (Realistic: no single step closes a huge gap.)
 *      b. Difficulty is proportional to gap size: gap ≥ 60 → 5, ≥ 40 → 4, etc.
 *      c. estimatedHours ∝ gap × difficulty.
 *   4. Sort steps: largest gap first (highest-leverage work first).
 *   5. Simulate projected score after all steps → projectedFitScore.
 *   6. Return SuccessPath.
 *
 * If the user already meets all requirements (no gaps), returns a SuccessPath
 * with empty steps and projectedFitScore = currentFitScore = 100 (or actual).
 *
 * Zero external dependencies.
 */

import { randomUUID } from "node:crypto";
import type { StrengthProfile, Opportunity, StrengthCategory } from "./types";
import type {
  SuccessPath,
  SuccessPathInput,
  LearningStep,
} from "./personality-types";

export class SuccessPathRouter {
  /**
   * Plan a learning path toward a target opportunity.
   *
   * @throws {Error} If targetOpportunityId is not found in the catalog.
   * @throws {Error} If the opportunity belongs to a different tenant.
   */
  plan(input: SuccessPathInput, catalog: Opportunity[]): SuccessPath {
    const { userId, tenantId, profile, targetOpportunityId, gaps } = input;

    // Find the target opportunity
    const target = catalog.find((o) => o.id === targetOpportunityId);
    if (!target) {
      throw new Error(`Opportunity not found: ${targetOpportunityId}`);
    }

    // Tenant isolation — hard boundary
    if (target.tenantId !== tenantId) {
      throw new Error(
        `Tenant isolation violation: opportunity ${targetOpportunityId} belongs to tenant ${target.tenantId}, not ${tenantId}`,
      );
    }

    // Build strength lookup
    const strengthMap = new Map<StrengthCategory, number>(
      profile.strengths.map((s) => [s.category, s.score]),
    );

    // Compute current fitScore
    const currentFitScore = this.computeFitScore(target, strengthMap);

    // Build learning steps from gaps (sorted: largest gap first)
    const sortedGaps = [...gaps].sort((a, b) => b.gap - a.gap);
    const steps: LearningStep[] = sortedGaps.map((g) =>
      this.buildStep(g.category, g.gap),
    );

    // Project scores after completing all steps
    const projectedMap = new Map(strengthMap);
    for (const step of steps) {
      const current = projectedMap.get(step.targetCategory) ?? 0;
      projectedMap.set(
        step.targetCategory,
        Math.min(100, current + step.expectedGain),
      );
    }
    const projectedFitScore = this.computeFitScore(target, projectedMap);

    const totalHours = steps.reduce((sum, s) => sum + s.estimatedHours, 0);

    return {
      id: randomUUID(),
      userId,
      tenantId,
      targetOpportunityId,
      currentFitScore,
      projectedFitScore,
      steps,
      totalHours,
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private computeFitScore(
    opp: Opportunity,
    strengthMap: Map<StrengthCategory, number>,
  ): number {
    if (opp.requiredStrengths.length === 0) return 100;

    const ratios = opp.requiredStrengths.map((req) => {
      const userScore = strengthMap.get(req.category) ?? 0;
      return req.minScore > 0 ? Math.min(1, userScore / req.minScore) : 1;
    });

    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return Math.round(avg * 100);
  }

  private buildStep(category: StrengthCategory, gap: number): LearningStep {
    // Difficulty: proportional to gap
    const difficulty = this.gapToDifficulty(gap);

    // expectedGain: realistic cap per step (max 30 points in one step)
    const expectedGain = Math.min(gap, 30);

    // estimatedHours: roughly 2h per gap point, scaled by difficulty
    const estimatedHours = Math.round((gap / 10) * difficulty * 2);

    return {
      id: randomUUID(),
      title: this.stepTitle(category, gap),
      description: this.stepDescription(category, gap, expectedGain),
      targetCategory: category,
      expectedGain,
      estimatedHours: Math.max(1, estimatedHours),
      difficulty,
    };
  }

  private gapToDifficulty(gap: number): 1 | 2 | 3 | 4 | 5 {
    if (gap >= 60) return 5;
    if (gap >= 40) return 4;
    if (gap >= 25) return 3;
    if (gap >= 10) return 2;
    return 1;
  }

  private stepTitle(category: string, gap: number): string {
    const intensity = gap >= 40 ? "Deep" : gap >= 20 ? "Focused" : "Light";
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    return `${intensity} ${label} Development`;
  }

  private stepDescription(
    category: string,
    gap: number,
    expectedGain: number,
  ): string {
    return (
      `Strengthen your ${category} skills to close a ${gap}-point gap. ` +
      `Completing this step is expected to improve your ${category} score by ~${expectedGain} points.`
    );
  }
}
