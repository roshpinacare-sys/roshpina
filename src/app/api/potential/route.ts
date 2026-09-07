/**
 * GET /api/potential — תמונת-מצב של מנוע-הפוטנציאל (קריאה-בלבד).
 * חוזקות → הזדמנויות מדורגות → הצעת-הצבה אוטומטית לכל-עובד.
 * הניתוח עצמו רץ פעם-אחת בזריעה (הרצה דרך האורקסטרטור כותבת ביקורת —
 * לכן GET לא מריץ אותו שוב, אלא מגיש את התמונה החתומה מהזריעה).
 */

import { NextResponse } from "next/server";
import { getKernel } from "@/lib/kernel";
import { money } from "@/lib/serialize";
import type { PotentialResponse, PotentialWorkerView } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUGGESTION_FIT_THRESHOLD = 55;

export async function GET() {
  const k = getKernel();
  const snapshot = k.potentialSnapshot;

  if (!snapshot) {
    // כנות לפני-הזריעה: אין נתונים — לא להמציא.
    return NextResponse.json({ generatedAt: null, workers: [] } satisfies PotentialResponse);
  }

  const workers: PotentialWorkerView[] = snapshot.workers.map((w) => {
    const bestBudgeted = w.matches
      .filter((m) => m.budgetMc !== null && m.fitScore >= SUGGESTION_FIT_THRESHOLD)
      .sort((a, b) => b.fitScore - a.fitScore)[0];

    return {
      userId: w.userId,
      displayName: w.displayName,
      strengths: w.strengths,
      matches: w.matches.map((m) => ({
        opportunityId: m.opportunityId,
        title: m.title,
        fitScore: m.fitScore,
        matchedStrengths: m.matchedStrengths,
        missingStrengths: m.missingStrengths,
        budget: m.budgetMc !== null ? money(m.budgetMc) : null,
      })),
      escrowSuggestion:
        bestBudgeted && bestBudgeted.budgetMc !== null
          ? {
              opportunityId: bestBudgeted.opportunityId,
              title: bestBudgeted.title,
              fitScore: bestBudgeted.fitScore,
              budget: money(bestBudgeted.budgetMc),
            }
          : null,
    };
  });

  const body: PotentialResponse = { generatedAt: snapshot.generatedAt, workers };
  return NextResponse.json(body);
}
