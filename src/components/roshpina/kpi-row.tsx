"use client";

/**
 * kpi-row.tsx — שורת-המדדים: ערך-נעול, עמלות-שנלכדו (רווח), יתרת-אוצר,
 * דרכונים, שלמות-ביקורת ופערי-ארביטראז'.
 */

import { usePolling } from "@/hooks/use-polling";
import type { HealthResponse } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Lock, Coins, Landmark, Stamp, ShieldCheck, TrendingUp } from "lucide-react";

function Kpi({
  label,
  value,
  hint,
  icon,
  tone = "gold",
}: {
  label: string;
  value: string | null;
  hint?: string;
  icon: React.ReactNode;
  tone?: "gold" | "verified" | "broken" | "plain";
}) {
  const toneCls =
    tone === "verified" ? "text-verified" : tone === "broken" ? "text-broken" : tone === "plain" ? "text-foreground" : "text-gold";
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] md:text-xs text-ink-2">{label}</span>
        <span className={cn("opacity-80", toneCls)}>{icon}</span>
      </div>
      {value === null ? (
        <Skeleton className="mt-2 h-7 w-24 bg-muted" />
      ) : (
        <div className={cn("mt-1 font-display text-xl md:text-2xl font-bold metric-value", toneCls)}>{value}</div>
      )}
      {hint ? <div className="mt-1 text-[10px] md:text-[11px] text-ink-2 truncate">{hint}</div> : null}
    </div>
  );
}

export function KpiRow() {
  const { data } = usePolling<HealthResponse>("/api/health", 10000);

  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full bg-muted" />
        ))}
      </div>
    );
  }

  const c = data.counts;
  return (
    <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-6" aria-label="מדדי-הפלטפורמה">
      <Kpi
        label="ערך נעול בהצבות"
        value={data.escrow.totalValueLocked.display}
        hint={`מומנה+מחלוקת · ${data.escrow.byState.funded ?? 0}+${data.escrow.byState.disputed ?? 0} הסכמים`}
        icon={<Lock className="h-4 w-4" />}
      />
      <Kpi
        label="עמלות שנלכדו (רווח)"
        value={data.escrow.feesCaptured.display}
        hint={`${data.escrow.feeCount} שחרורים · 500bps`}
        icon={<Coins className="h-4 w-4" />}
      />
      <Kpi
        label="יתרת האוצר"
        value={data.treasuryBalance?.display ?? "—"}
        hint={`${c.accounts} חשבונות · ${c.financialOps} פעולות-כסף`}
        icon={<Landmark className="h-4 w-4" />}
      />
      <Kpi
        label="דרכונים שהונפקו"
        value={String(c.passports)}
        hint={`kid ${data.kid.slice(0, 8)}`}
        icon={<Stamp className="h-4 w-4" />}
      />
      <Kpi
        label="שלמות הביקורת"
        value={c.audit.integrity ? "תקינה" : "שבורה"}
        hint={`${c.audit.length} רשומות · ראש ${c.audit.headHash ? c.audit.headHash.slice(0, 8) : "—"}…`}
        tone={c.audit.integrity ? "verified" : "broken"}
        icon={<ShieldCheck className="h-4 w-4" />}
      />
      <Kpi
        label="פערי-ארביטראז' נצפים"
        value={data.arbitrage.totalSpread.display}
        hint={`${data.arbitrage.opportunitiesWithQuotes} הזדמנויות עם ציטוטים`}
        tone="plain"
        icon={<TrendingUp className="h-4 w-4" />}
      />
    </div>
  );
}
