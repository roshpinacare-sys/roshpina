/**
 * POST /api/ledger/mint — הנפקת-אשראי דרך שער-האורקסטרטור (guard→execute→audit→passport).
 * קלט: { accountId, amount: מחרוזת-ספרות µ¢, memo }.
 * כשל-guard/ביצוע → 409 עם סיבת-הקרנל האמיתית.
 * K5 (C-2, v147): הבקשה חייבת חתימת-Ed25519 של מפעיל (route-gate) — בלי-אימות
 * לא נולד אפילו סנט אחד; סירוב-השער → 401/503 עם קוד-יציב.
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

const MintSchema = z.object({
  accountId: z.string().min(8, "מזהה-חשבון חסר"),
  amount: z.string().regex(/^\d{1,18}$/, "amount חייב להיות מחרוזת-ספרות של µ¢"),
  memo: z.string().min(1, "מטרה נדרשת").max(200),
});

export async function POST(req: Request) {
  const gate = await gateStateRoute(req);
  if (!gate.ok) {
    return NextResponse.json({ ok: false as const, error: gate.code, reason: gate.detail }, { status: gate.status });
  }
  await ensureSeed();
  const parsed = MintSchema.safeParse(parseJsonOrNull(gate.rawBody));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false as const, error: "קלט לא-חוקי", reason: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const k = getKernel();
  const amount = BigInt(parsed.data.amount);
  const res = await k.ledgerOrch.mint(
    TENANT, parsed.data.accountId, amount, parsed.data.memo, "console-operator",
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
    detail: `הונפקו ${formatMc(res.value.amount)}`,
  });
}
