"use client";

/**
 * audit-panel.tsx — הביקורת: סייר-שרשרת hash-linked עם צ'יפ-שלמות, ראש,
 * ועיגון-ראש-השרשרת אל SAOS דרך תפר-הגשר.
 */

import { toast } from "sonner";
import { ScrollText, Anchor } from "lucide-react";
import { usePolling } from "@/hooks/use-polling";
import { Panel, EmptyState, ListSkeleton, ErrorNote, OutcomeBadge, HashSpan } from "./bits";
import { shortTime, ACTION_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AuditResponse, BridgeAnchorResponse } from "@/lib/api-types";

export function AuditPanel() {
  const { data, error, loading, refresh } = usePolling<AuditResponse>("/api/audit", 12000);

  const anchor = async () => {
    try {
      const res = await fetch("/api/bridge/saos", { method: "POST" });
      const r = (await res.json()) as BridgeAnchorResponse & { reason?: string; error?: string };
      if (res.ok && r.ok) {
        toast.success("ראש-השרשרת נעגן אל SAOS", {
          description: `height ${r.payload.height} · head ${r.payload.headHash.slice(0, 12)}… · ממתינים: ${r.pendingAnchors}`,
        });
      } else {
        toast.error("העיגון נכשל", { description: r.reason ?? r.error ?? `HTTP ${res.status}` });
      }
    } catch {
      toast.error("שגיאת-רשת בעיגון");
    }
  };

  const integrity = data?.integrity ?? false;
  const records = data?.records ?? [];
  const height = data?.height ?? 0;

  return (
    <Panel
      title="הביקורת"
      subtitle="שרשרת hash-linked חתומה — כל-החלטה נרשמת: אושר, נדחה או שגיאה"
      icon={<ScrollText className="h-5 w-5" />}
      actions={
        <Button size="sm" variant="outline" className="border-gold/40 text-gold hover:bg-gold/10" onClick={anchor} disabled={!data || records.length === 0}>
          <Anchor className="h-3.5 w-3.5" /> עגן ל-SAOS
        </Button>
      }
    >
      {error ? <ErrorNote error={error} /> : null}

      {data ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={integrity ? "border-verified/40 bg-verified/10 text-verified" : "border-broken/40 bg-broken/10 text-broken"}
          >
            {integrity ? "שרשרת שלמה" : `שרשרת פגומה${data.brokenAt !== null ? ` באינדקס ${data.brokenAt}` : ""}`}
          </Badge>
          <Badge variant="outline" className="border-border text-ink-2">גובה {data.height}</Badge>
          {data.headHash ? (
            <span className="text-xs text-ink-2">ראש: <HashSpan hash={data.headHash} className="text-gold" /></span>
          ) : null}
        </div>
      ) : null}

      {loading && records.length === 0 ? (
        <ListSkeleton rows={5} />
      ) : records.length === 0 ? (
        <EmptyState text="השרשרת ריקה — בצעו פעולה כלשהי." />
      ) : (
        <ol className="max-h-96 space-y-1.5 overflow-y-auto pl-1" dir="rtl">
          {[...records].reverse().map((r, i) => (
            <li key={r.id} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <OutcomeBadge outcome={r.outcome} />
                  <span className="font-medium text-foreground">{ACTION_LABELS[r.actionType] ?? r.actionType}</span>
                  <span className="text-ink-2">על-ידי {r.source}</span>
                  {r.signed ? <span className="text-[10px] text-gold">חתום Ed25519</span> : null}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-ink-2">
                  <span className="hash">#{height - i}</span>
                  <span>{shortTime(r.occurredAt)}</span>
                </div>
              </div>
              {r.reason ? (
                <p className="mt-1 line-clamp-1 text-[11px] text-ink-2" title={r.reason}>{r.reason}</p>
              ) : null}
              <div className="mt-1 flex items-center gap-3 text-[10px] text-ink-2">
                <span>hash <HashSpan hash={r.hash} /></span>
                <span>prev <HashSpan hash={r.prevHash} /></span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {error ? null : (
        <button onClick={refresh} className="mt-3 text-[11px] text-ink-2 underline-offset-4 hover:text-gold hover:underline">
          רענון-ידני
        </button>
      )}
    </Panel>
  );
}
