/**
 * GET /api/escrow — הסכמי-ההצבה + סטטיסטיקות-עמלות (מדד-הרווח של הפלטפורמה).
 */

import { NextResponse } from "next/server";
import { getKernel, TENANT } from "@/lib/kernel";
import { serializeAgreement, money } from "@/lib/serialize";
import type { EscrowResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const k = getKernel();
  const agreements = await k.escrowStore.list(TENANT);
  agreements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const byState: Record<string, number> = {};
  let totalFees = 0n;
  let feeCount = 0;
  for (const a of agreements) {
    byState[a.state] = (byState[a.state] ?? 0) + 1;
    if (a.feeAmount !== undefined) {
      totalFees += a.feeAmount;
      feeCount++;
    }
  }

  const body: EscrowResponse = {
    agreements: agreements.map(serializeAgreement),
    feeStats: {
      totalFeeCaptured: money(totalFees),
      feeCount,
      byState,
    },
  };
  return NextResponse.json(body);
}
