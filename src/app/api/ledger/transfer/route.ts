/**
 * POST /api/ledger/transfer — העברה בין-חשבונות דרך שער-האורקסטרטור.
 * כשל-guard (fail-closed) או יתרה-בלתי-מספקת → 409 עם סיבת-הקרנל האמיתית.
 * K5 (C-2, v147): הבקשה חייבת חתימת-Ed25519 של מפעיל (route-gate) — בלי-אימות
 * לא זז שקל; סירוב-השער → 401/503 עם קוד-יציב.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getKernel, TENANT } from "@/lib/kernel";
import { gateStateRoute, parseJsonOrNull } from "@/lib/route-gate";
import { money } from "@/lib/serialize";
import { formatMc } from "@/lib/format";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TransferSchema = z.object({
  fromAccountId: z.string().min(8, "חשבון-מקור חסר"),
  toAccountId: z.string().min(8, "חשבון-יעד חסר"),
  amount: z.string().regex(/^\d{1,18}$/, "amount חייב להיות מחרוזת-ספרות של µ¢"),
  memo: z.string().min(1, "מטרה נדרשת").max(200),
});

export async function POST(req: Request) {
  const gate = await gateStateRoute(req);
  if (!gate.ok) {
    return NextResponse.json({ ok: false as const, error: gate.code, reason: gate.detail }, { status: gate.status });
  }
  await ensureSeed();
  const parsed = TransferSchema.safeParse(parseJsonOrNull(gate.rawBody));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false as const, error: "קלט לא-חוקי", reason: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const { fromAccountId, toAccountId, amount: amountStr, memo } = parsed.data;
  if (fromAccountId === toAccountId) {
    return NextResponse.json(
      { ok: false as const, error: "קלט לא-חוקי", reason: "העברה לאותו-חשבון אסורה" },
      { status: 400 },
    );
  }

  const k = getKernel();
  const amount = BigInt(amountStr);
  const res = await k.ledgerOrch.transfer(
    TENANT, fromAccountId, toAccountId, amount, memo, "console-operator",
  );

  if (!res.ok) {
    return NextResponse.json({ ok: false as const, reason: res.reason, auditId: res.auditId }, { status: 409 });
  }

  return NextResponse.json({
    ok: true as const,
    tx: {
      id: res.value.id,
      kind: res.value.kind,
      amount: money(res.value.amount),
      memo: res.value.memo,
      initiatedBy: res.value.initiatedBy,
      createdAt: res.value.createdAt,
    },
    auditId: res.auditId,
    passportKid: res.passport?.kid ?? null,
    detail: `הועברו ${formatMc(res.value.amount)}`,
  });
}
