/**
 * GET /api/audit — סייר-שרשרת-הביקורת של הטננט (קריאה-בלבד).
 * מחזיר: רשומות השרשרת, ראש (headHash + height), ותוצאת-שלמות
 * (verifyChain של הקרנל + אבחון אינדקס-שבירה ראשון כשהשרשרת פגומה).
 */

import { NextResponse } from "next/server";
import { getKernel, TENANT } from "@/lib/kernel";
import type { AuditResponse, AuditRecordView } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECORD_LIMIT = 300;

export async function GET() {
  const k = getKernel();
  const T = TENANT;
  const chain = k.audit.getChain(T);
  const integrity = k.audit.verifyChain(T);
  const head = chain.length > 0 ? chain[chain.length - 1] : null;

  // אבחון-שבירה: הליכה על קישורי-prevHash + אימות-חתימה לכל-רשומה.
  // (verifyChain מחשב-מחדש גם את-ה-hash הקנוני; כאן מאבחנים איפה נשבר.)
  let brokenAt: number | null = null;
  if (!integrity) {
    for (let i = 0; i < chain.length; i++) {
      const rec = chain[i];
      const expectedPrev = i === 0 ? "genesis" : chain[i - 1].hash;
      if (rec.prevHash !== expectedPrev) {
        brokenAt = i;
        break;
      }
      if (rec.signature !== undefined && !k.signer.verify(rec.hash, rec.signature)) {
        brokenAt = i;
        break;
      }
    }
  }

  const records: AuditRecordView[] = chain.slice(-RECORD_LIMIT).map((r) => ({
    id: r.id,
    actionType: r.actionType,
    source: r.source,
    outcome: r.outcome,
    reason: r.reason ?? null,
    occurredAt: r.occurredAt,
    prevHash: r.prevHash,
    hash: r.hash,
    signed: r.signature !== undefined,
  }));

  const body: AuditResponse = {
    tenantId: T,
    records,
    headHash: head?.hash ?? null,
    height: chain.length,
    integrity,
    brokenAt,
  };
  return NextResponse.json(body);
}
