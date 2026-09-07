"use client";

/**
 * bridge-panel.tsx — הגשר: תפר-העיגון אל שרשרת-ה-SAOS הריבונית (מערכת-חוץ).
 * כאן נבנה מטען saos:anchor/v1 על ראש-שרשרת-הביקורת ונצבר בקובץ-המתנה;
 * שרשרת-החוץ קוטפת ומשדרת — בקונסולה לא משדרים כלום.
 */

import { toast } from "sonner";
import { RadioTower, Anchor, Loader2, Inbox } from "lucide-react";
import { usePolling } from "@/hooks/use-polling";
import { Panel, EmptyState, ListSkeleton, ErrorNote, HashSpan } from "./bits";
import { shortTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BridgeAnchorResponse, BridgeStatusResponse } from "@/lib/api-types";

export function BridgePanel() {
  const { data, error, loading, refresh } = usePolling<BridgeStatusResponse>("/api/bridge/saos", 15000);

  const anchor = async () => {
    try {
      const res = await fetch("/api/bridge/saos", { method: "POST" });
      const r = (await res.json()) as BridgeAnchorResponse & { reason?: string; error?: string };
      if (res.ok && r.ok) {
        toast.success("מטען-עיגון נבנה ונצבר בתפר", {
          description: `saos:anchor/v1 · height ${r.payload.height} · head ${r.payload.headHash.slice(0, 12)}…`,
        });
        refresh();
      } else {
        toast.error("בניית-העיגון נכשלה", { description: r.reason ?? r.error ?? `HTTP ${res.status}` });
      }
    } catch {
      toast.error("שגיאת-רשת");
    }
  };

  return (
    <Panel
      title="הגשר"
      subtitle="עיגון ראש-הביקורת אל השרשרת-הריבונית SAOS · תפר append-only, ללא-שידור מקומי"
      icon={<RadioTower className="h-5 w-5" />}
      actions={
        <Button size="sm" variant="outline" className="border-gold/40 text-gold hover:bg-gold/10" onClick={anchor} disabled={loading || !data?.head}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Anchor className="h-3.5 w-3.5" />} בנה עיגון
        </Button>
      }
    >
      {error ? <ErrorNote error={error} /> : null}

      {loading && !data ? (
        <ListSkeleton rows={3} />
      ) : !data ? (
        <EmptyState text="אין מצב-גשר." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="panel p-4">
            <h3 className="text-sm font-bold">ראש-השרשרת לעיגון</h3>
            {data.head ? (
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">טננט</span>
                  <span className="hash">{data.head.tenantId}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">גובה</span>
                  <span className="hash text-gold">{data.head.height}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">headHash</span>
                  <HashSpan hash={data.head.headHash} className="text-gold" />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">שלמות-מקומית</span>
                  <Badge variant="outline" className={data.integrity ? "border-verified/40 text-verified" : "border-broken/40 text-broken"}>
                    {data.integrity ? "תקינה" : "פגומה"}
                  </Badge>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-2">השרשרת ריקה — אין מה לעגן.</p>
            )}
          </div>

          <div className="panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <Inbox className="h-4 w-4 text-gold" /> עיגונים ממתינים
              <Badge variant="outline" className="border-gold/40 text-gold">{data.pendingAnchors}</Badge>
            </h3>
            <p className="hash mt-2 text-[11px] text-ink-2">{data.seam}</p>
            {data.lastPending ? (
              <div className="mt-3 rounded-md border border-border bg-muted/20 p-2.5 text-[11px]" dir="ltr">
                <div className="hash text-gold">{data.lastPending.protocol}</div>
                <div className="hash mt-1 text-ink-2">head {data.lastPending.headHash.slice(0, 18)}…</div>
                <div className="hash text-ink-2">height {data.lastPending.height} · {shortTime(data.lastPending.at)}</div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-2">טרם נבנו עיגונים.</p>
            )}
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs leading-6 text-ink-2">
              <span className="font-semibold text-foreground">איך התפר עובד:</span> לחיצה על ״בנה עיגון״ מקפיאה את ראש-שרשרת-הביקורת
              (headHash + גובה) לתוך מטען <span className="hash">saos:anchor/v1</span> ומצרפת אותו לקובץ המתנה append-only.
              שרשרת-ה-SAOS החוצה (מערכת נפרדת) סורקת את הקובץ, שולחת את העיגון לרשת-הציבורית ומחזירה אישור-קבלה.
              הקונסולה לא משדרת לשום-רשת — היא רק מפיקה הוכחות; ההפצה ריבונית וחוצה.
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
