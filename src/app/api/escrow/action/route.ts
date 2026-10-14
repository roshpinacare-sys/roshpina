/**
 * POST /api/escrow/action — שליטה מלאה במחזור-חיי-ההצבה.
 *   create | fund | release | refund | dispute | undispute
 * שגיאות-הקרנל נחשפות בכנות: 400 קלט, 404 לא-נמצא, 409 מצב-שגוי/סירוב/הרשאה.
 * K5 (C-2, v147): כל-פעולה חייבת חתימת-Ed25519 של מפעיל (route-gate) — fund/
 * release הם נקודת-הכסף; סירוב-השער → 401/503 עם קוד-יציב, לפני-כל-שאר.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getKernel, TENANT } from "@/lib/kernel";
import { gateStateRoute, parseJsonOrNull } from "@/lib/route-gate";
import { serializeAgreement } from "@/lib/serialize";
import { formatNis } from "@/lib/format";
import { ensureSeed } from "@/lib/seed";
import { EscrowError } from "@kernel/escrow/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MC_REGEX = /^\d{1,18}$/;

const Schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    opportunityId: z.string().min(1, "הזדמנות נדרשת"),
    payerAccountId: z.string().min(8, "חשבון-משלם נדרש"),
    workerAccountId: z.string().min(8, "חשבון-עובד נדרש"),
    amount: z.string().regex(MC_REGEX, "amount חייב להיות מחרוזת-ספרות של µ¢"),
  }),
  z.object({ action: z.literal("fund"), id: z.string().min(8), initiatedBy: z.string().min(1).optional() }),
  z.object({ action: z.literal("release"), id: z.string().min(8), initiatedBy: z.string().min(1).optional() }),
  z.object({ action: z.literal("refund"), id: z.string().min(8), initiatedBy: z.string().min(1).optional() }),
  z.object({ action: z.literal("dispute"), id: z.string().min(8), initiatedBy: z.string().min(1).optional(), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("undispute"), id: z.string().min(8), initiatedBy: z.string().min(1).optional() }),
]);

/** ברירת-מחדל לזהות-הפועל: ה-ownerId של החשבון-הרלוונטי (המשלם / העובד). */
async function defaultIdentity(accountId: string): Promise<string> {
  try {
    const acc = await getKernel().ledger.getAccount(TENANT, accountId);
    return acc.ownerId;
  } catch {
    return "console-operator";
  }
}

function escrowStatus(code: string): number {
  switch (code) {
    case "invalid_input": return 400;
    case "not_found": return 404;
    default: return 409; // wrong_state | ledger_denied | unauthorized | dispute_frozen
  }
}

export async function POST(req: Request) {
  const gate = await gateStateRoute(req);
  if (!gate.ok) {
    return NextResponse.json({ ok: false as const, error: gate.code, reason: gate.detail }, { status: gate.status });
  }
  await ensureSeed();
  const parsed = Schema.safeParse(parseJsonOrNull(gate.rawBody));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false as const, error: "קלט לא-חוקי", reason: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const k = getKernel();
  const T = TENANT;
  const input = parsed.data;

  try {
    switch (input.action) {
      case "create": {
        if (input.payerAccountId === input.workerAccountId) {
          return NextResponse.json(
            { ok: false as const, error: "קלט לא-חוקי", reason: "משלם ועובד חייבים להיות שונים" },
            { status: 400 },
          );
        }
        const agreement = await k.escrow.create({
          tenantId: T,
          opportunityId: input.opportunityId,
          payerAccountId: input.payerAccountId,
          workerAccountId: input.workerAccountId,
          amount: BigInt(input.amount),
        });
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(agreement),
          detail: "הצבה נפתחה — ממתינה להטבה",
        });
      }
      case "fund": {
        const agreement = await k.escrowStore.get(T, input.id);
        if (!agreement) throw new EscrowError("not_found", "הסכם-הצבה לא נמצא");
        const by = input.initiatedBy ?? (await defaultIdentity(agreement.payerAccountId));
        const updated = await k.escrow.fund(T, input.id, by);
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(updated),
          detail: `הוטבה ${formatNis(updated.amount)} לחשבון-ההצבה`,
        });
      }
      case "release": {
        const agreement = await k.escrowStore.get(T, input.id);
        if (!agreement) throw new EscrowError("not_found", "הסכם-הצבה לא נמצא");
        const by = input.initiatedBy ?? (await defaultIdentity(agreement.payerAccountId));
        const updated = await k.escrow.release(T, input.id, by);
        const feePart = updated.feeAmount !== undefined ? ` · עמלת-תיאום ${formatNis(updated.feeAmount)} נלכדה` : "";
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(updated),
          detail: `שוחררה לעובד${feePart}`,
        });
      }
      case "refund": {
        const agreement = await k.escrowStore.get(T, input.id);
        if (!agreement) throw new EscrowError("not_found", "הסכם-הצבה לא נמצא");
        const by = input.initiatedBy ?? (await defaultIdentity(agreement.payerAccountId));
        const updated = await k.escrow.refund(T, input.id, by);
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(updated),
          detail: `הוחזרו ${formatNis(updated.amount)} למשלם`,
        });
      }
      case "dispute": {
        const agreement = await k.escrowStore.get(T, input.id);
        if (!agreement) throw new EscrowError("not_found", "הסכם-הצבה לא נמצא");
        const by = input.initiatedBy ?? (await defaultIdentity(agreement.workerAccountId));
        const updated = await k.escrow.dispute(T, input.id, by, input.reason);
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(updated),
          detail: "ההצבה הוקפאה במחלוקת — הכסף לא זז",
        });
      }
      case "undispute": {
        const agreement = await k.escrowStore.get(T, input.id);
        if (!agreement) throw new EscrowError("not_found", "הסכם-הצבה לא נמצא");
        const by = input.initiatedBy ?? (await defaultIdentity(agreement.payerAccountId));
        const updated = await k.escrow.undispute(T, input.id, by);
        return NextResponse.json({
          ok: true as const,
          agreement: serializeAgreement(updated),
          detail: "המחלוקת בוטלה — ההצבה חזרה למצב מומנה",
        });
      }
    }
  } catch (err) {
    if (err instanceof EscrowError) {
      return NextResponse.json(
        { ok: false as const, error: err.code, reason: err.message },
        { status: escrowStatus(err.code) },
      );
    }
    return NextResponse.json(
      { ok: false as const, error: "internal", reason: err instanceof Error ? err.message : "שגיאה לא-ידועה" },
      { status: 500 },
    );
  }
}
