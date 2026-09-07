/**
 * POST /api/passports/verify — אימות כנה של דרכון-פעולה.
 * מריץ את ה-verifier של הקרנל (מבנה → hash קנוני → חתימת Ed25519 דרך KeyRing)
 * ומחזיר ok + רשימת-בדיקות מפורטת. לעולם לא זורק — תשובה כנה גם בכשל.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getKernel } from "@/lib/kernel";
import { verifyActionPassport } from "@kernel/passport/passport-verifier";
import type { PassportVerifyResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Schema = z.object({
  passport: z.record(z.string(), z.unknown()),
});

export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false as const, error: "קלט לא-חוקי", reason: "נדרש { passport: {...} }" },
      { status: 400 },
    );
  }

  const k = getKernel();
  let result: PassportVerifyResponse;
  try {
    const verified = verifyActionPassport(parsed.data.passport, {
      keyRing: k.keyRing,
      publicKey: k.publicKeyPem,
      // אותו-זוג מפתחות חותם גם רשומות-ביקורת — מאפשר אימות-מלא במקום skip.
      auditPublicKey: k.publicKeyPem,
    });
    result = { ok: verified.ok, checks: verified.checks };
  } catch (err) {
    result = {
      ok: false,
      checks: [
        {
          name: "verification",
          status: "fail",
          message: err instanceof Error ? err.message : "אימות נכשל",
        },
      ],
    };
  }

  return NextResponse.json(result);
}
