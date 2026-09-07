/**
 * GET /api/passports — דרכוני-פעולה אחרונים.
 * כל-דרכון הוא הוכחה ניידת: כל-שדותיו ציבוריים (חתימה ו-hash אינם סוד),
 * אין כאן שום חומר-מפתח פרטי. `proof` הוא הדרכון המלא להחזרה ל-verify.
 */

import { NextResponse } from "next/server";
import { getKernel } from "@/lib/kernel";
import { money } from "@/lib/serialize";
import type { PassportView, PassportsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_LIMIT = 40;

export async function GET() {
  const k = getKernel();
  const recent = [...k.passports].reverse().slice(0, RECENT_LIMIT);

  const views: Array<PassportView & { proof: unknown }> = recent.map((p) => ({
    passportId: p.passportId,
    kid: p.kid ?? null,
    algorithm: p.algorithm,
    issuedAt: p.issuedAt,
    actionType: p.audit.actionType,
    outcome: p.policyDecision.outcome,
    auditId: p.audit.id,
    source: p.audit.source,
    ledger: p.ledgerEffect
      ? {
          kind: p.ledgerEffect.kind,
          amount: money(BigInt(p.ledgerEffect.amount)),
          memo: p.ledgerEffect.memo,
        }
      : null,
    proof: p,
  }));

  const body: PassportsResponse = {
    passports: views,
    total: k.passports.length,
  };
  return NextResponse.json(body);
}
