"use client";

/**
 * passports-panel.tsx — הדרכונים: הוכחות-פעולה חתומות Ed25519.
 * כפתור-אימות שולח את הדרכון המלא חזרה ל-/api/passports/verify ומציג
 * תוצאה כנה (כולל רשימת-הבדיקות) — גם-כשל הוא תשובה לגיטימית.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Fingerprint, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import { usePolling } from "@/hooks/use-polling";
import { Panel, Money, EmptyState, ListSkeleton, ErrorNote, OutcomeBadge } from "./bits";
import { shortHash, shortTime, ACTION_LABELS } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PassportView, PassportVerifyResponse } from "@/lib/api-types";

type PassportRow = PassportView & { proof: unknown };

export function PassportsPanel() {
  const { data, error, loading } = usePolling<{ passports: PassportRow[]; total: number }>("/api/passports", 12000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean | undefined>>({});

  const passports = data?.passports ?? [];

  const verify = async (p: PassportRow) => {
    setBusyId(p.passportId);
    try {
      const res = await fetch("/api/passports/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passport: p.proof }),
      });
      const r = (await res.json()) as PassportVerifyResponse;
      setVerified((v) => ({ ...v, [p.passportId]: r.ok }));
      if (r.ok) {
        toast.success("הדרכון אומת — חתימה תקפה", {
          description: `${p.passportId.slice(0, 8)}… · ${r.checks.length} בדיקות עברו`,
        });
      } else {
        const failed = r.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.message ?? ""}`).join(" · ");
        toast.error("הדרכון נכשל באימות", { description: failed || "אימות לא עבר" });
      }
    } catch {
      toast.error("שגיאת-רשת באימות");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Panel
      title="הדרכונים"
      subtitle="הוכחה ניידת לכל-פעולה: hash קנוני + חתימת Ed25519 + אזכור-ביקורת"
      icon={<Fingerprint className="h-5 w-5" />}
      actions={data ? <Badge variant="outline" className="border-gold/40 text-gold">{data.total} שהונפקו</Badge> : null}
    >
      {error ? <ErrorNote error={error} /> : null}

      {loading && passports.length === 0 ? (
        <ListSkeleton rows={4} />
      ) : passports.length === 0 ? (
        <EmptyState text="טרם הונפקו דרכונים — כל-פעולה פיננסית מצליחה מנפיקה דרכון." />
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {passports.map((p) => {
            const v = verified[p.passportId];
            return (
              <li key={p.passportId} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                    <OutcomeBadge outcome={p.outcome} />
                    <span className="font-medium text-foreground">{ACTION_LABELS[p.actionType] ?? p.actionType}</span>
                    <span className="hash text-[10px] text-ink-2">kid {p.kid ? shortHash(p.kid, 8, 4) : "—"}</span>
                    {p.ledger ? (
                      <span className="text-ink-2">
                        {p.ledger.kind} <Money className="text-xs text-gold">{p.ledger.amount.display}</Money>
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-ink-2">{shortTime(p.issuedAt)}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(
                        "h-7 px-2.5 text-[11px]",
                        v === true && "border-verified/50 text-verified",
                        v === false && "border-broken/50 text-broken",
                      )}
                      disabled={busyId === p.passportId}
                      onClick={() => verify(p)}
                    >
                      {busyId === p.passportId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : v === true ? (
                        <ShieldCheck className="h-3 w-3" />
                      ) : v === false ? (
                        <ShieldX className="h-3 w-3" />
                      ) : null}
                      אימות
                    </Button>
                  </div>
                </div>
                <div className="hash mt-1 text-[10px] text-ink-2">
                  {p.passportId.slice(0, 12)}… · audit {shortHash(p.auditId, 8, 4)} · {p.source}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
