/**
 * /api/bridge/saos — נתיב-הגשר לשרשרת-הריבונית SAOS (מערכת-חוץ).
 *
 * GET  — מצב-הגשר: ראש-שרשרת-הביקורת { tenantId, headHash, height }, שלמות,
 *        ומונה-העיגונים הממתינים ב-.bridge/pending-anchors.jsonl.
 * POST — בניית מטען saos:anchor/v1 על ראש-השרשרת הנוכחי וצירופו (append-only)
 *        לקובץ-העיגונים הממתינים. זהו התפר: שרשרת SAOS החוצה קוטפת את הקובץ.
 *        כאן לא משדרים כלום — ההפצה באחריות-השרשרת החוצה.
 */

import { NextResponse } from "next/server";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getKernel, TENANT } from "@/lib/kernel";
import { ensureSeed } from "@/lib/seed";
import type { BridgeAnchorPayload, BridgeStatusResponse, BridgeAnchorResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** קובץ-התפר אליו SAOS מסתכל (יחסי ל-cwd של השרת = /home/z/roshpina). */
const BRIDGE_DIR = ".bridge";
const PENDING_FILE = "pending-anchors.jsonl";

function pendingFilePath(): string {
  return join(process.cwd(), BRIDGE_DIR, PENDING_FILE);
}

async function readPending(): Promise<BridgeAnchorPayload[]> {
  try {
    const raw = await readFile(pendingFilePath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const out: BridgeAnchorPayload[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as BridgeAnchorPayload);
      } catch {
        // שורה-פגומה — מדלגים, הקובץ append-only ואין לנו עסק לתקן היסטוריה.
      }
    }
    return out;
  } catch {
    return []; // ENOENT — עדיין לא נעגן כלום, מצב לגיטימי.
  }
}

function auditHead(k: ReturnType<typeof getKernel>) {
  const chain = k.audit.getChain(TENANT);
  if (chain.length === 0) return null;
  return { tenantId: TENANT, headHash: chain[chain.length - 1].hash, height: chain.length };
}

export async function GET() {
  const k = getKernel();
  const pending = await readPending();
  const body: BridgeStatusResponse = {
    seam: `${BRIDGE_DIR}/${PENDING_FILE}`,
    head: auditHead(k),
    integrity: k.audit.verifyChain(TENANT),
    pendingAnchors: pending.length,
    lastPending: pending.length > 0 ? pending[pending.length - 1] : null,
    lastAnchoredAt: pending.length > 0 ? pending[pending.length - 1].at : null,
  };
  return NextResponse.json(body);
}

export async function POST() {
  await ensureSeed();
  const k = getKernel();
  const head = auditHead(k);
  if (!head) {
    return NextResponse.json(
      { ok: false as const, error: "no_chain", reason: "אין עדיין שרשרת-ביקורת לעגינה" },
      { status: 409 },
    );
  }

  const payload: BridgeAnchorPayload = {
    protocol: "saos:anchor/v1",
    action: "roshpina-anchor",
    tenantId: head.tenantId,
    headHash: head.headHash,
    height: head.height,
    at: new Date().toISOString(),
  };

  try {
    await mkdir(join(process.cwd(), BRIDGE_DIR), { recursive: true });
    await appendFile(pendingFilePath(), JSON.stringify(payload) + "\n", "utf8");
  } catch (err) {
    return NextResponse.json(
      {
        ok: false as const,
        error: "seam_write_failed",
        reason: err instanceof Error ? err.message : "כתיבת-תפר העיגון נכשלה",
      },
      { status: 500 },
    );
  }

  const pending = await readPending();
  const body: BridgeAnchorResponse = {
    ok: true,
    payload,
    pendingAnchors: pending.length,
  };
  return NextResponse.json(body);
}
