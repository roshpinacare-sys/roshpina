"use client";

/**
 * ledger-panel.tsx — הספר: טבלת-חשבונות, טופס-העברה וטופס-הנפקה.
 * כל-כסף נקלט בטפסים ב-₪ ונשלח ל-API כמחרוזת-ספרות של µ¢.
 * שגיאות-הקרנל (סירוב-guard, יתרה-חסרה) מוצגות בכנות כ-טוסטים.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, Landmark, Loader2, PlusCircle } from "lucide-react";
import { usePolling } from "@/hooks/use-polling";
import { Panel, Money, EmptyState, ListSkeleton, ErrorNote } from "./bits";
import { parseNisToMc, formatNis } from "@/lib/format";
import type { AccountView } from "@/lib/api-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<string, string> = {
  treasury: "אוצר",
  worker: "עובד",
  client: "לקוח",
  platform: "פלטפורמה",
  other: "אחר",
};

function AccountSelect({
  value,
  onChange,
  accounts,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  accounts: AccountView[];
  placeholder: string;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full bg-input/40">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name} · {ROLE_LABELS[a.role] ?? a.role} · {a.balance.display}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; reason?: string; detail?: string; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function MoneyField({
  nis,
  onNis,
  id,
}: {
  nis: string;
  onNis: (v: string) => void;
  id?: string;
}) {
  const mc = parseNisToMc(nis);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>סכום (₪)</Label>
      <Input
        id={id}
        inputMode="decimal"
        placeholder="למשל 250.00"
        value={nis}
        onChange={(e) => onNis(e.target.value)}
        className="bg-input/40"
        dir="ltr"
      />
      <p className="text-[11px] text-ink-2">
        {mc !== null ? `${formatNis(mc)} = ${mc.toString()} µ¢` : "µ¢: סכום ב-₪ עד 6 ספרות-עשרוניות"}
      </p>
    </div>
  );
}

export function LedgerPanel() {
  const accountsApi = usePolling<{ accounts: AccountView[] }>("/api/ledger/accounts", 10000);
  const accounts = accountsApi.data?.accounts ?? [];
  const selectable = useMemo(() => accounts.filter((a) => a.role !== "platform"), [accounts]);

  // טופס-העברה
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [txAmount, setTxAmount] = useState("");
  const [txMemo, setTxMemo] = useState("");
  const [sending, setSending] = useState(false);

  // טופס-הנפקה
  const [mintTo, setMintTo] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [mintMemo, setMintMemo] = useState("");
  const [minting, setMinting] = useState(false);

  const submitTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const mc = parseNisToMc(txAmount);
    if (!from || !to) return toast.error("בחרו חשבון-מקור וחשבון-יעד");
    if (from === to) return toast.error("העברה לאותו-חשבון אסורה");
    if (mc === null || mc <= 0n) return toast.error("סכום לא-חוקי");
    if (!txMemo.trim()) return toast.error("מטרת-ההעברה נדרשת");
    setSending(true);
    try {
      const r = await postJson("/api/ledger/transfer", {
        fromAccountId: from, toAccountId: to, amount: mc.toString(), memo: txMemo.trim(),
      });
      if (r.ok) {
        toast.success("ההעברה בוצעה", { description: r.detail });
        setTxAmount(""); setTxMemo("");
        accountsApi.refresh();
      } else {
        toast.error("ההעברה נדחתה", { description: r.reason ?? r.error });
      }
    } catch {
      toast.error("שגיאת-רשת");
    } finally {
      setSending(false);
    }
  };

  const submitMint = async (e: React.FormEvent) => {
    e.preventDefault();
    const mc = parseNisToMc(mintAmount);
    if (!mintTo) return toast.error("בחרו חשבון-יעד להנפקה");
    if (mc === null || mc <= 0n) return toast.error("סכום לא-חוקי");
    if (!mintMemo.trim()) return toast.error("מטרת-ההנפקה נדרשת");
    setMinting(true);
    try {
      const r = await postJson("/api/ledger/mint", {
        accountId: mintTo, amount: mc.toString(), memo: mintMemo.trim(),
      });
      if (r.ok) {
        toast.success("אשראי חדש הונפק", { description: r.detail });
        setMintAmount(""); setMintMemo("");
        accountsApi.refresh();
      } else {
        toast.error("ההנפקה נדחתה", { description: r.reason ?? r.error });
      }
    } catch {
      toast.error("שגיאת-רשת");
    } finally {
      setMinting(false);
    }
  };

  return (
    <Panel
      title="הספר"
      subtitle="ספר כפול-כניסה · BigInt µ¢ · כל-פעולה עוברת guard→audit→passport"
      icon={<Landmark className="h-5 w-5" />}
      actions={<Badge variant="outline" className="border-gold/40 text-gold">{accounts.length} חשבונות</Badge>}
    >
      {accountsApi.error ? <ErrorNote error={accountsApi.error} /> : null}

      {accountsApi.loading && accounts.length === 0 ? (
        <ListSkeleton rows={4} />
      ) : accounts.length === 0 ? (
        <EmptyState text="עדיין אין חשבונות — הקרנל מזריע." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-right text-xs text-ink-2">
                <th className="px-3 py-2 font-medium">חשבון</th>
                <th className="px-3 py-2 font-medium">תפקיד</th>
                <th className="px-3 py-2 font-medium">סוג</th>
                <th className="px-3 py-2 font-medium">יתרה</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">µ¢</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{a.name}</div>
                    <div className="hash text-[10px] text-ink-2">{a.id.slice(0, 12)}…</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge
                      variant="outline"
                      className={cn(
                        a.role === "treasury" && "border-gold/40 text-gold",
                        a.role === "worker" && "border-verified/40 text-verified",
                        a.role === "client" && "border-border text-foreground",
                        a.role === "platform" && "border-gold/30 text-gold/80",
                      )}
                    >
                      {ROLE_LABELS[a.role] ?? a.role}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-2">{a.type}</td>
                  <td className="px-3 py-2.5"><Money>{a.balance.display}</Money></td>
                  <td className="hash hidden px-3 py-2.5 text-[11px] text-ink-2 md:table-cell">{a.balanceMc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <form onSubmit={submitTransfer} className="panel p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
            <ArrowLeftRight className="h-4 w-4 text-gold" /> העברה בין-חשבונות
          </h3>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label>מקור</Label>
              <AccountSelect value={from} onChange={setFrom} accounts={selectable} placeholder="בחר חשבון-מקור" />
            </div>
            <div className="space-y-1.5">
              <Label>יעד</Label>
              <AccountSelect value={to} onChange={setTo} accounts={selectable} placeholder="בחר חשבון-יעד" />
            </div>
            <MoneyField nis={txAmount} onNis={setTxAmount} id="tx-amount" />
            <div className="space-y-1.5">
              <Label htmlFor="tx-memo">מטרה</Label>
              <Input id="tx-memo" value={txMemo} onChange={(e) => setTxMemo(e.target.value)} placeholder="למשל תשלום עבור פיתוח" className="bg-input/40" />
            </div>
            <Button type="submit" disabled={sending} className="bg-gold text-[#1a1206] hover:bg-gold/90">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} העבר
            </Button>
          </div>
        </form>

        <form onSubmit={submitMint} className="panel p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
            <PlusCircle className="h-4 w-4 text-gold" /> הנפקת-אשראי (guardMint)
          </h3>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label>יעד</Label>
              <AccountSelect value={mintTo} onChange={setMintTo} accounts={selectable} placeholder="בחר חשבון-יעד" />
            </div>
            <MoneyField nis={mintAmount} onNis={setMintAmount} id="mint-amount" />
            <div className="space-y-1.5">
              <Label htmlFor="mint-memo">מטרה</Label>
              <Input id="mint-memo" value={mintMemo} onChange={(e) => setMintMemo(e.target.value)} placeholder="למשל הונא-פתיחה" className="bg-input/40" />
            </div>
            <Button type="submit" disabled={minting} variant="outline" className="border-gold/40 text-gold hover:bg-gold/10">
              {minting ? <Loader2 className="h-4 w-4 animate-spin" /> : null} הנפק
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
