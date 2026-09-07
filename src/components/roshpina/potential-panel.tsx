"use client";

/**
 * potential-panel.tsx — הפוטנציאל: חוזקות לכל-עובד, הזדמנויות מדורגות,
 * והצעת-הצבה אוטומטית (קריאה-בלבד מתוך גרף-הידע בזיכרון).
 */

import { usePolling } from "@/hooks/use-polling";
import { Panel, Money, EmptyState, ListSkeleton, ErrorNote } from "./bits";
import { Sparkles, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PotentialResponse } from "@/lib/api-types";

function StrengthBar({ category, score, confidence }: { category: string; score: number; confidence: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-foreground">{category}</span>
        <span className="hash text-ink-2">{score} · ביטחון {Math.round(confidence * 100)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-l from-gold-dim to-gold"
          style={{ width: `${Math.min(100, score)}%` }}
        />
      </div>
    </div>
  );
}

export function PotentialPanel() {
  const { data, error, loading } = usePolling<PotentialResponse>("/api/potential", 20000);
  const workers = data?.workers ?? [];

  return (
    <Panel
      title="הפוטנציאל"
      subtitle="אותות-ידע → פרופיל-חוזקות → הזדמנויות מדורגות → הצעת-הצבה"
      icon={<Sparkles className="h-5 w-5" />}
    >
      {error ? <ErrorNote error={error} /> : null}

      {loading && workers.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : workers.length === 0 ? (
        <EmptyState text="טרם נותח פוטנציאל — הניתוח רץ בזריעה דרך האורקסטרטור." />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-3">
          {workers.map((w) => (
            <li key={w.userId} className="panel p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold">{w.displayName}</h3>
                <span className="hash text-[10px] text-ink-2">{w.userId}</span>
              </div>

              <div className="mt-3 space-y-2.5">
                {w.strengths.map((s) => (
                  <StrengthBar key={s.category} category={s.category} score={s.score} confidence={s.confidence} />
                ))}
              </div>

              <h4 className="mt-4 text-xs font-bold text-ink-2">הזדמנויות מדורגות</h4>
              <ul className="mt-2 space-y-1.5">
                {w.matches.slice(0, 4).map((m) => (
                  <li key={m.opportunityId} className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-xs">
                    <span className="truncate">{m.title}</span>
                    <span className="flex items-center gap-1.5">
                      {m.budget ? <span className="text-[10px] text-gold">{m.budget.display}</span> : null}
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          m.fitScore >= 80 ? "border-verified/40 text-verified" : m.fitScore >= 50 ? "border-gold/40 text-gold" : "border-border text-ink-2",
                        )}
                      >
                        התאמה {m.fitScore}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>

              {w.escrowSuggestion ? (
                <div className="mt-3 rounded-lg border border-verified/40 bg-verified/10 px-3 py-2.5 text-xs text-verified">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Zap className="h-3.5 w-3.5" /> הצעת-הצבה אוטומטית
                  </div>
                  <p className="mt-1 text-foreground">
                    {w.escrowSuggestion.title} · התאמה {w.escrowSuggestion.fitScore} ·{" "}
                    <Money className="text-xs text-verified">{w.escrowSuggestion.budget.display}</Money>
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-[11px] text-ink-2">אין כרגע הזדמנות-ממונה בהתאמה גבוהה.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
