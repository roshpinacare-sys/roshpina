"use client";

/**
 * marketplace-panel.tsx — השוק: הזדמנויות עם ציטוטי-ספק, מנצח-ארביטראז',
 * spread ודמי-ניתוב אפשריים (10% מהפער — קרן-הרווח של ידיעת-המחיר).
 */

import { usePolling } from "@/hooks/use-polling";
import { Panel, Money, EmptyState, ListSkeleton, ErrorNote } from "./bits";
import { Store, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MarketplaceResponse } from "@/lib/api-types";

export function MarketplacePanel() {
  const { data, error, loading } = usePolling<MarketplaceResponse>("/api/marketplace", 15000);
  const opportunities = data?.opportunities ?? [];

  return (
    <Panel
      title="השוק"
      subtitle="ארביטראז'-עלויות: המנצח הוא הזול ביותר, הפער עד המתחרה-הבא הוא תקרת-דמי-הניתוב"
      icon={<Store className="h-5 w-5" />}
      actions={data ? <Badge variant="outline" className="border-gold/40 text-gold">סה״כ פערים: {data.totalSpread.display}</Badge> : null}
    >
      {error ? <ErrorNote error={error} /> : null}

      {loading && opportunities.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : opportunities.length === 0 ? (
        <EmptyState text="אין הזדמנויות בקטלוג." />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {opportunities.map((o) => (
            <li key={o.id} className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-display text-base font-bold">{o.title}</h3>
                  <p className="mt-0.5 text-xs text-ink-2">{o.description}</p>
                </div>
                {o.budget ? <Money className="text-sm text-gold">{o.budget.display}</Money> : null}
              </div>

              {o.requiredStrengths.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {o.requiredStrengths.map((r) => (
                    <Badge key={r.category} variant="outline" className="border-border text-[10px] text-ink-2">
                      {r.category} ≥ {r.minScore}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {o.quotes.length === 0 ? (
                <p className="mt-3 text-xs text-ink-2">אין ציטוטי-ספק להזדמנות זו.</p>
              ) : (
                <div className="mt-3 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-right text-ink-2">
                        <th className="px-3 py-1.5 font-medium">ספק</th>
                        <th className="px-3 py-1.5 font-medium">עלות-משוערת</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.quotes.map((q) => {
                        const isWinner = q.vendorId === o.winnerVendorId;
                        const isRunnerUp = q.vendorId === o.runnerUpVendorId;
                        return (
                          <tr key={q.vendorId} className={cn("border-b border-border/60 last:border-0", isWinner && "bg-verified/5")}>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex items-center gap-1.5">
                                {isWinner ? <Trophy className="h-3 w-3 text-verified" /> : null}
                                <span className={cn(isWinner ? "font-semibold text-verified" : "", isRunnerUp ? "text-gold-dim" : "")}>{q.vendorId}</span>
                                {isWinner ? <Badge variant="outline" className="border-verified/40 text-verified text-[10px]">זול ביותר</Badge> : null}
                                {isRunnerUp ? <Badge variant="outline" className="border-border text-[10px] text-ink-2">המתחרה-הבא</Badge> : null}
                              </span>
                            </td>
                            <td className="px-3 py-1.5"><Money className="text-xs">{q.cost.display}</Money></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {o.spread && o.routingFee ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline" className="border-gold/40 bg-gold/10 text-gold">spread {o.spread.display}</Badge>
                  <Badge variant="outline" className="border-verified/40 bg-verified/10 text-verified">דמי-ניתוב אפשריים (10%) {o.routingFee.display}</Badge>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
