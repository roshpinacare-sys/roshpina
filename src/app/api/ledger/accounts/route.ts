/**
 * GET /api/ledger/accounts — רשימת-חשבונות עם יתרות מפורמטות (קריאה-בלבד).
 */

import { NextResponse } from "next/server";
import { getKernel, TENANT } from "@/lib/kernel";
import { serializeAccount } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const k = getKernel();
  const accounts = await k.ledger.listAccounts(TENANT);
  // יציבות-תצוגה: האוצר קודם, ואז לפי-זמן-יצירה.
  const sorted = [...accounts].sort((a, b) => {
    const aT = a.id === k.registry.treasuryId;
    const bT = b.id === k.registry.treasuryId;
    if (aT !== bT) return aT ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return NextResponse.json({ accounts: sorted.map(serializeAccount) });
}
