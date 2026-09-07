/**
 * lib/potential/collaboration-matcher.ts — CollaborationMatcher.
 *
 * Finds the best collaboration partners for a user by comparing StrengthProfiles.
 *
 * The core insight: the best collaborators are NOT those who are strongest overall —
 * they are those whose strengths fill your gaps and vice versa. Two people who are
 * both strong in "technical" but weak in "leadership" don't complement each other.
 *
 * Algorithm:
 *   1. Enforce tenant isolation — only candidates in the same tenantId are considered.
 *   2. For each candidate:
 *      a. Identify complementary strengths: categories where the delta between
 *         one user's score and the other's is ≥ COMPLEMENT_THRESHOLD (default: 20).
 *         Strong user = score ≥ 50. Weak user = score < 50 (or simply lower by threshold).
 *      b. Identify shared strengths: categories where BOTH score ≥ SHARED_THRESHOLD (50).
 *      c. compatibilityScore = (complementScore × 0.7 + sharedScore × 0.3), 0–100.
 *         - complementScore: avg delta of complementary pairs, normalized 0–100.
 *         - sharedScore: (sharedCount / totalCategories) × 100.
 *      d. Build synergyReason from top complementary pair.
 *   3. Filter by minCompatibility (default: 40).
 *   4. Sort descending by compatibilityScore.
 *
 * Tenant isolation is a hard boundary: passing candidates from a different tenantId
 * will throw an error (fail-closed, not silent discard — the caller should never
 * mix tenants in the candidate list).
 *
 * Zero external dependencies.
 */

import type { StrengthProfile, StrengthCategory } from "./types";
import type {
  CollaborationMatch,
  CollaborationInput,
} from "./personality-types";

const COMPLEMENT_THRESHOLD = 20; // min delta to count as complementary
const SHARED_THRESHOLD = 50;     // min score for "shared strength"

export class CollaborationMatcher {
  /**
   * Find collaboration matches for a user within their tenant.
   *
   * @throws {Error} If any candidate belongs to a different tenantId.
   */
  match(input: CollaborationInput): CollaborationMatch[] {
    const { tenantId, userId, userProfile, candidates, minCompatibility = 40 } = input;

    // Validate tenant isolation for all candidates up-front
    for (const c of candidates) {
      if (c.profile.tenantId !== tenantId) {
        throw new Error(
          `Tenant isolation violation: candidate ${c.userId} belongs to tenant ` +
          `${c.profile.tenantId}, not ${tenantId}`,
        );
      }
    }

    const results: CollaborationMatch[] = [];

    for (const candidate of candidates) {
      // Skip self-match
      if (candidate.userId === userId) continue;

      const match = this.computeMatch(
        userId,
        userProfile,
        candidate.userId,
        candidate.profile,
        tenantId,
      );

      if (match.compatibilityScore >= minCompatibility) {
        results.push(match);
      }
    }

    // Best compatibility first
    results.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
    return results;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private computeMatch(
    userAId: string,
    profileA: StrengthProfile,
    userBId: string,
    profileB: StrengthProfile,
    tenantId: string,
  ): CollaborationMatch {
    const mapA = new Map<StrengthCategory, number>(
      profileA.strengths.map((s) => [s.category, s.score]),
    );
    const mapB = new Map<StrengthCategory, number>(
      profileB.strengths.map((s) => [s.category, s.score]),
    );

    // All categories from both profiles
    const allCategories = new Set([...mapA.keys(), ...mapB.keys()]);

    const complementaryStrengths: CollaborationMatch["complementaryStrengths"] = [];
    const sharedStrengths: StrengthCategory[] = [];
    const deltas: number[] = [];

    for (const cat of allCategories) {
      const scoreA = mapA.get(cat) ?? 0;
      const scoreB = mapB.get(cat) ?? 0;
      const delta = Math.abs(scoreA - scoreB);

      // Shared strength: both score ≥ threshold
      if (scoreA >= SHARED_THRESHOLD && scoreB >= SHARED_THRESHOLD) {
        sharedStrengths.push(cat);
      }

      // Complementary: one is meaningfully stronger than the other
      if (delta >= COMPLEMENT_THRESHOLD) {
        const strongUser = scoreA >= scoreB ? userAId : userBId;
        const weakUser   = scoreA >= scoreB ? userBId : userAId;
        complementaryStrengths.push({ category: cat, strongUser, weakUser, delta });
        deltas.push(delta);
      }
    }

    // compatibilityScore:
    //   70% from complementarity (avg delta, normalized to 0-100)
    //   30% from shared strengths (fraction of categories)
    const avgDelta = deltas.length > 0
      ? deltas.reduce((a, b) => a + b, 0) / deltas.length
      : 0;
    const complementScore = Math.min(100, avgDelta); // delta is already 0–100
    const sharedScore = allCategories.size > 0
      ? (sharedStrengths.length / allCategories.size) * 100
      : 0;
    const compatibilityScore = Math.round(complementScore * 0.7 + sharedScore * 0.3);

    const synergyReason = this.buildSynergyReason(
      userAId,
      userBId,
      complementaryStrengths,
      sharedStrengths,
    );

    return {
      userA: userAId,
      userB: userBId,
      tenantId,
      compatibilityScore,
      complementaryStrengths,
      sharedStrengths,
      synergyReason,
      matchedAt: new Date().toISOString(),
    };
  }

  private buildSynergyReason(
    userA: string,
    userB: string,
    complementary: CollaborationMatch["complementaryStrengths"],
    shared: StrengthCategory[],
  ): string {
    if (complementary.length === 0 && shared.length === 0) {
      return "Profiles have limited overlap — low complementarity.";
    }

    const parts: string[] = [];

    // Top complementary pair — single-pass max-find (no array copy, no sort).
    // Keeps the first-encountered entry on a delta tie, matching the prior
    // stable-sort-then-take-first behavior.
    let topComp: CollaborationMatch["complementaryStrengths"][number] | undefined;
    for (const c of complementary) {
      if (topComp === undefined || c.delta > topComp.delta) {
        topComp = c;
      }
    }
    if (topComp) {
      parts.push(
        `${topComp.strongUser}'s ${topComp.category} strength (Δ${topComp.delta}) fills ${topComp.weakUser}'s gap`,
      );
    }

    // Shared strengths
    if (shared.length > 0) {
      const sharedLabel = shared.slice(0, 2).join(" and ");
      parts.push(`both strong in ${sharedLabel}`);
    }

    return parts.join("; ") + ".";
  }
}
