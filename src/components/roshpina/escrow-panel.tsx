"use client";

/**
 * escrow-panel.tsx — ההצבה: הסכמים לפי-מצב + פעולות מחזור-חיים + יצירת-הסכם.
 * מכונת-המצבים קפדנית: created→funded→released/refunded/disputed (וחזרה ממחלוקת).
 * הכסף זז רק דרך שער-האורקסטרטור; שגיאות-מדינה מוצגות בכנות.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Handshake, Loader2, Unlock, Ban, RotateCcw, CheckCircle2, Send } from "lucide-react";
import { usePolling } from "@/hooks/use-polling";
import { Panel, Money, StateBadge, EmptyState, ListSkeleton, ErrorNote } from "./bits";
import { parseNisToMc, formatNis, shortHash } from "@/lib/format";
import type { AccountView, EscrowAgreementView, MarketplaceOpportunityView } from "@/lib/api-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

async function postJson<T>(url: string, body: unknown): Promise<T & { ok: boolean; reason?: string; detail?: string; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function EscrowPanel() {
  const escrowApi = usePolling<{ agreements: EscrowAgreementView[]; feeStats: { totalFeeCaptured: { display: string }; feeCount: number } }>("/api/escrow", 10000);
  const accountsApi = usePolling<{ accounts: AccountView[] }>("/api/ledger/accounts", 10000);
  const marketApi = usePolling<{ opportunities: MarketplaceOpportunityView[] }>("/api/marketplace", 15000);

  const accounts = accountsApi.data?.accounts ?? [];
  const accountName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);
  const nameOf = (id: string) => accountName.get(id) ?? `${id.slice(0, 8)}…`;

  const agreements = escrowApi.data?.agreements ?? [];
  const opportunities = marketApi.data?.opportunities ?? [];

  // יצירת-הסכם
  const [oppId, setOppId] = useState("");
  const [payer, setPayer] = useState("");
  const [worker, setWorker] = useState("");
  const [amountNis, setAmountNis] = useState("");
  const [creating, setCreating] = useState(false);

  // סיבת-מחלוקת אופציונלית לפעולות
  const [disputeReason, setDisputeReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const clients = accounts.filter((a) => a.role === "client");
  const workers = accounts.filter((a) => a.role === "worker");

  const act = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    setBusyId(`${id}:${action}`);
    try {
      const r = await postJson("/api/escrow/action", { action, id, ...extra });
      if (r.ok) {
        toast.success(r.detail ?? "הפעולה בוצעה");
        escrowApi.refresh();
        accountsApi.refresh();
      } else {
        toast.error("הפעולה נדחתה", { description: r.reason ?? r.error });
      }
    } catch {
      toast.error("שגיאת-רשת");
    } finally {
      setBusyId(null);
    }
  };

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const mc = parseNisToMc(amountNis);
    if (!oppId) return toast.error("בחרו הזדמנות");
    if (!payer || !worker) return toast.error("בחרו משלם ועובד");
    if (payer === worker) return toast.error("משלם ועובד חייבים להיות שונים");
    if (mc === null || mc <= 0n) return toast.error("סכום לא-חוקי");
    setCreating(true);
    try {
      const r = await postJson("/api/escrow/action", {
        action: "create", opportunityId: oppId, payerAccountId: payer, workerAccountId: worker, amount: mc.toString(),
      });
      if (r.ok) {
        toast.success(r.detail ?? "ההצבה נפתחה");
        setAmountNis("");
        escrowApi.refresh();
        accountsApi.refresh();
      } else {
        toast.error("יצירת-ההצבה נכשלה", { description: r.reason ?? r.error });
      }
    } catch {
      toast.error("שגיאת-רשת");
    } finally {
      setCreating(false);
    }
  };

  const actionButtons = (a: EscrowAgreementView) => {
    const busy = (act: string) => busyId === `${a.id}:${act}`;
    const btn = "h-8 px-2.5 text-xs";
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {a.state === "created" ? (
          <Button size="sm" variant="outline" className={`${btn} border-gold/40 text-gold hover:bg-gold/10`} disabled={!!busyId} onClick={() => act(a.id, "fund")}>
            {busy("fund") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} הטבה
          </Button>
        ) : null}
        {a.state === "funded" ? (
          <>
            <Button size="sm" className={`${btn} bg-verified text-[#04120c] hover:bg-verified/90`} disabled={!!busyId} onClick={() => act(a.id, "release")}>
              {busy("release") ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} שחרור
            </Button>
            <Button size="sm" variant="outline" className={`${btn} border-border text-foreground hover:bg-muted`} disabled={!!busyId} onClick={() => act(a.id, "refund")}>
              {busy("refund") ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} החזר
            </Button>
            <Button size="sm" variant="outline" className={`${btn} border-broken/40 text-broken hover:bg-broken/10`} disabled={!!busyId} onClick={() => act(a.id, "dispute", { reason: disputeReason.trim() || undefined })}>
              {busy("dispute") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} מחלוקת
            </Button>
          </>
        ) : null}
        {a.state === "disputed" ? (
          <Button size="sm" variant="outline" className={`${btn} border-gold/40 text-gold hover:bg-gold/10`} disabled={!!busyId} onClick={() => act(a.id, "undispute")}>
            {busy("undispute") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />} ביטול-מחלוקת
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <Panel
      title="ההצבה"
      subtitle="תשלום-בטוח עד-השלמה · דמי-תיאום 5% נלכדים בשחרור — מנוע-הרווח של הפלטפורמה"
      icon={<Handshake className="h-5 w-5" />}
      actions={
        <Badge variant="outline" className="border-verified/40 text-verified">
          עמלות שנלכדו: {escrowApi.data?.feeStats.totalFeeCaptured.display ?? "—"}
        </Badge>
      }
    >
      {escrowApi.error ? <ErrorNote error={escrowApi.error} /> : null}

      <form onSubmit={submitCreate} className="panel mb-5 p-4">
        <h3 className="mb-3 text-sm font-bold">הצבה חדשה</h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5 lg:col-span-2">
            <Label>הזדמנות</Label>
            <Select value={oppId} onValueChange={setOppId}>
              <SelectTrigger className="w-full bg-input/40"><SelectValue placeholder="בחר הזדמנות מהשוק" /></SelectTrigger>
              <SelectContent>
                {opportunities.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.title}{o.budget ? ` · ${o.budget.display}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>משלם</Label>
            <Select value={payer} onValueChange={setPayer}>
              <SelectTrigger className="w-full bg-input/40"><SelectValue placeholder="לקוח" /></SelectTrigger>
              <SelectContent>
                {clients.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>עובד</Label>
            <Select value={worker} onValueChange={setWorker}>
              <SelectTrigger className="w-full bg-input/40"><SelectValue placeholder="עובד" /></SelectTrigger>
              <SelectContent>
                {workers.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="esc-amount">סכום (₪)</Label>
            <Input id="esc-amount" dir="ltr" inputMode="decimal" value={amountNis} onChange={(e) => setAmountNis(e.target.value)} placeholder="5000.00" className="bg-input/40" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={creating} className="bg-gold text-[#1a1206] hover:bg-gold/90">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null} פתח הצבה
          </Button>
          <div className="flex-1 min-w-56">
            <Input value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} placeholder="סיבת-מחלוקת (אופציונלי, לשימוש כפתור מחלוקת)" className="bg-input/40 text-xs" />
          </div>
          {amountNis && parseNisToMc(amountNis) !== null ? (
            <span className="text-[11px] text-ink-2">{formatNis(parseNisToMc(amountNis)!)} · עמלה צפויה {formatNis((parseNisToMc(amountNis)! * 500n) / 10000n)}</span>
          ) : null}
        </div>
      </form>

      {escrowApi.loading && agreements.length === 0 ? (
        <ListSkeleton rows={4} />
      ) : agreements.length === 0 ? (
        <EmptyState text="אין עדיין הסכמי-הצבה — פתחו הצבה חדשה." />
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {agreements.map((a) => (
            <li key={a.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StateBadge state={a.state} />
                  <span className="text-sm font-semibold">{a.opportunityId}</span>
                </div>
                <Money className="text-base">{a.amount.display}</Money>
              </div>
              <div className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-2 sm:grid-cols-2">
                <span>משלם: <span className="text-foreground">{nameOf(a.payerAccountId)}</span></span>
                <span>עובד: <span className="text-foreground">{nameOf(a.workerAccountId)}</span></span>
                {a.fundedBy ? <span>הטבה על-ידי: <span className="text-foreground">{a.fundedBy}</span></span> : null}
                <span className="hash">id {shortHash(a.id, 8, 4)}</span>
              </div>
              {a.feeAmount ? (
                <div className="mt-2 text-xs text-gold">עמלת-תיאום {a.feeAmount.display} · {((a.feeBasisPoints ?? 0) / 100).toFixed(1)}%</div>
              ) : null}
              {a.disputeReason ? (
                <div className="mt-2 rounded border border-broken/30 bg-broken/10 px-2.5 py-1.5 text-xs text-broken">מחלוקת: {a.disputeReason}</div>
              ) : null}
              <div className="mt-3">{actionButtons(a)}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
