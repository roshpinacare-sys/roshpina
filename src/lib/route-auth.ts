/**
 * route-auth.ts — K5 שער-אימות-נתיבים (v147, C-2): החוק-הטהור של דלת-הכניסה לנתיבי-הכסף.
 *
 * הפער-שנמדד (C-2): ה-KeyRing חי בקרנל (src/lib/kernel.ts:157) ומכיל את מפתח-הקרנל עצמו —
 * אבל אף-נתיב לא קרא אף-כותרת-אימות: POST ל-/api/ledger/mint, /api/ledger/transfer ו-
 * /api/escrow/action פעל כ-"console-operator" לכל-קורא אנונימי. המכונה-קיימת, השער-לא-היה
 * מחובר — אותה-מחלה של H-3 (קוד-חוק-מת), ואותה-תרופה כמו K2: השער-קודם-למשטח.
 *
 * החוק (מילה-במילה — פורמט=חוק, שיעור-D3):
 *   1. rawBody נקרא פעם-אחת (השער מחזיר אותו — הנתיב לא קורא את הזרם בשנית).
 *   2. שלוש-כותרות חובה: x-roshpina-kid · x-roshpina-timestamp · x-roshpina-signature.
 *      אחת-חסרה/ריקה → 401 missing_headers (הפרטים קוננים אילו-חסרו).
 *   3. kid לא-מוכר → 401 unknown_kid · kid שנשלל → 401 key_revoked (תמיד — חוק-KeyRing) ·
 *      "retiring" עדיין מאמת (חלון-חפיפת-הרוטציה — חוק-KeyRing נשמר).
 *   4. timestamp חייב ISO-8601 UTC מילולי (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) — אפוק-מספרי,
 *      אזייה-לא-UTC או תאריך-בלתי-אפשרי → 401 bad_timestamp. פורמט=חוק.
 *   5. |עכשיו − timestamp| > ROUTE_AUTH_REPLAY_WINDOW_MS (5 דקות, שני-הכיוונים) →
 *      401 stale_timestamp (חלון-ההגנה-משחזור; עתיד-מעבר-לחלון נתפס גם-הוא).
 *   6. replay: חתימה-מנצחת אחת שורפת-עצמה — tuple זהה בשנית → 401 replay_detected
 *      (בלי-זה שחזור-תוך-החלון = הנפקה-כפולה. המטמון בזיכרון-התהליך — Known-limit
 *      מתועד: פריסה-מרובת-מופעים צריכה מטמון-משותף).
 *   7. חתימה: Ed25519 מעל המחרוזת-הקנונית-בת-חמש-השורות (kid נכרך-לתוך-הבייטים):
 *
 *        kid
 *        METHOD
 *        /pathname
 *        timestamp
 *        sha256hex(rawBody)
 *
 *      כל-שינוי-בייט (גוף, נתיב, שיטה, זמן, מפתח) = חתימה-שקרית → 401 bad_signature.
 *
 * אספקת-עוגני-האמון (provisionOperatorKeys): מפתחות-המפעיל הם מפתחות-ציבור (SPKI PEM)
 * בסביבת-הפריסה — ROSHPINA_OPERATOR_PUBLIC_KEY או ROSHPINA_OPERATOR_PUBLIC_KEY_<סיומת>.
 * הקנייה מנורמלת (CRLF→LF + קיצוץ-קצוות — רעש-סביבה לא מפצל-kid) וה-kid תמיד מחושב
 * (computeKid מהחומר — יציב-בין-פריסות). המפתח-הפרטי
 * לעולם-לא-נוגע-בתהליך (חוק-CDP של K3): מי-שחותם חותם-בחוץ; התהליך מחזיק רק-אמת-ציבורית.
 *
 * אפס-מתג-כיבוי: אין-עוגנים → כל-הקריאות נדחות 503 operator_not_provisioned; PEM שבור →
 * 503 operator_key_invalid. השער לא משתיק, לא מדלג, לא סולח — fail-closed מהכותרת-הראשונה.
 *
 * Known-limits (כנים): נתיבי-קריאה נשארים פתוחים (נמדד: GET-ים + passports/verify
 * שהוא-אימות-טהור); bridge/saos POST (כותב-תפר-העיגון שהקונסולה קוראת-לו) עדיין פתוח —
 * מועמד-C-2b; רישום-ה-scopes (kernel/rbac/require-scope) עדיין לא-מחובר — C-2 כאן הוא
 * שכבת-מפתח, לא שכבת-הרשאות.
 */

import { createHash, createPublicKey } from "node:crypto";
import { computeKid, type KeyRing } from "@kernel/passport/key-ring";

/** חלון-ההגנה-משחזור — 5 דקות, שני-הכיוונים (מדיד ומחודד: הוובהוק 15-דקות-קירור, הרייל 60-שניות). */
export const ROUTE_AUTH_REPLAY_WINDOW_MS = 5 * 60_000;

/** תבנית-הזמן: ISO-8601 UTC מילולי בלבד — פורמט=חוק (שיעור-D3). */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** כותרות-האימות הנדרשות — שמות-החוק המילוליים. */
export const ROUTE_AUTH_HEADERS = ["x-roshpina-kid", "x-roshpina-timestamp", "x-roshpina-signature"] as const;

/** סירוב: קוד-יציב + פירוט-צועק. לעולם לא שקט. */
export interface RouteAuthDenial {
  readonly ok: false;
  readonly status: 401 | 503;
  readonly code:
    | "missing_headers"
    | "unknown_kid"
    | "key_revoked"
    | "bad_timestamp"
    | "stale_timestamp"
    | "replay_detected"
    | "bad_signature"
    | "operator_not_provisioned"
    | "operator_key_invalid";
  readonly detail: string;
}

/** עבירה: הבקשה עברה-את-השער; rawBody מוענק לנתיב (הזרם לא נקרא פעמיים). */
export interface RouteAuthPass {
  readonly ok: true;
  readonly rawBody: string;
}

export type RouteAuthResult = RouteAuthPass | RouteAuthDenial;

/**
 * מטמון-השחזור: tuple-חתימה-מנצחת אחד-אחד נשרף.
 * זיכרון-חסום: פסילת-פקיעות (מעבר-לחלון) על-כל-add + תקרת-אחסון קשיח.
 */
export interface ReplayCache {
  has(key: string): boolean;
  add(key: string, at: number): void;
}

export class InMemoryReplayCache implements ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly cap = 4096) {}
  has(key: string): boolean {
    return this.seen.has(key);
  }
  add(key: string, at: number): void {
    // פסילת-פקיעות: מה שכבר-מעבר-לחלון לא-יכול לשחזר-בהצלחה — נשכח מיד (זיכרון-חסום).
    const horizon = at - ROUTE_AUTH_REPLAY_WINDOW_MS;
    for (const [k, t] of this.seen) {
      if (t < horizon) this.seen.delete(k);
      else break; // סדר-הכנסה ≈ סדר-זמן — הראשון-החי מסמן את-השאר
    }
    if (!this.seen.has(key)) this.seen.set(key, at);
    while (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/** sha256-hex של מחרוזת (utf8). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** המחרוזת-הקנונית — חמש-שורות, סדר-מילולי: kid, METHOD, pathname, timestamp, bodyHash. */
export function canonicalRoutePayload(kid: string, method: string, pathname: string, timestamp: string, bodyHashHex: string): string {
  return [kid, method.toUpperCase(), pathname, timestamp, bodyHashHex].join("\n");
}

/**
 * אספקת-עוגני-אמון: כל ROSHPINA_OPERATOR_PUBLIC_KEY* בסביבה נרשם לטבעת.
 * הקנייה מנורמלת (CRLF→LF + קיצוץ-קצוות) לפני-כל-שאר — רעש-סביבה (שורה-סופית
 * שנקצצה-או-נוספה בשינוע) לא יכול לפצל את ה-kid; החומר-הרשום = החומר-המנורמל.
 * ה-kid תמיד מחושב מהחומר (computeKid) — יציב-בין-פריסות, אין-KID-להתאים.
 * PEM שבור = שגיאה-קוננית (לא-זריקה) — המתקשר הופך אותה ל-503 צועק-קבוע.
 */
export function provisionOperatorKeys(ring: KeyRing, env: Record<string, string | undefined>): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];
  for (const [name, pem] of Object.entries(env)) {
    if (!name.startsWith("ROSHPINA_OPERATOR_PUBLIC_KEY")) continue;
    if (typeof pem !== "string" || pem.trim().length === 0) {
      errors.push(`${name}: ריק`);
      continue;
    }
    const norm = pem.replace(/\r\n/g, "\n").trim();
    try {
      createPublicKey(norm); // פורמט=חוק: PEM בלתי-תקין נדחה כאן, בקול
    } catch (err) {
      errors.push(`${name}: PEM בלתי-תקין (${err instanceof Error ? err.message : "שגיאה"})`);
      continue;
    }
    const kid = computeKid("ed25519", norm);
    ring.register({
      kid,
      algorithm: "ed25519",
      publicKey: norm,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    registered.push(kid);
  }
  return { registered, errors };
}

/**
 * החוק: בקשה אחת מול טבעת-אחת. אפס-מצב-גלובלי (המטמון ניתן-מבחוץ — החוק מחייב אותו,
 * לא בורר-ברירת-מחדל-שקטה); `now` ניתן-מבחוץ (השעות-הן-של-הנותנים — שיעור-השובר).
 */
export async function requireOperatorSignature(
  req: Request,
  ring: KeyRing,
  replay: ReplayCache,
  opts?: { now?: number },
): Promise<RouteAuthResult> {
  const now = opts?.now ?? Date.now();
  const rawBody = await req.text();

  // (1) שלוש-כותרות חובה
  const missing: string[] = [];
  const kid = req.headers.get("x-roshpina-kid")?.trim() ?? "";
  const timestamp = req.headers.get("x-roshpina-timestamp")?.trim() ?? "";
  const signature = req.headers.get("x-roshpina-signature")?.trim() ?? "";
  if (!kid) missing.push("x-roshpina-kid");
  if (!timestamp) missing.push("x-roshpina-timestamp");
  if (!signature) missing.push("x-roshpina-signature");
  if (missing.length > 0) {
    return { ok: false, status: 401, code: "missing_headers", detail: `כותרות-אימות חסרות: ${missing.join(", ")}` };
  }

  // (2) ה-kid חי בטבעת, ואינו שלול (retiring עדיין מאמת — חפיפת-רוטציה)
  const entry = ring.resolve(kid);
  if (!entry) {
    return { ok: false, status: 401, code: "unknown_kid", detail: `kid לא-מוכר בטבעת: ${kid}` };
  }
  if (entry.status === "revoked") {
    return { ok: false, status: 401, code: "key_revoked", detail: `המפתח ${kid} נשלל — חתימותיו נדחות תמיד` };
  }

  // (3) פורמט=חוק: ISO-8601 UTC מילולי בלבד
  if (!ISO_UTC_RE.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    return { ok: false, status: 401, code: "bad_timestamp", detail: "x-roshpina-timestamp חייב ISO-8601 UTC מילולי (YYYY-MM-DDTHH:MM:SS[.mmm]Z)" };
  }

  // (4) חלון-השחזור — שני-הכיוונים
  const age = Math.abs(now - Date.parse(timestamp));
  if (age > ROUTE_AUTH_REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, code: "stale_timestamp", detail: `הזמן מחוץ-לחלון (${Math.round(ROUTE_AUTH_REPLAY_WINDOW_MS / 1000)} שניות) — סטייה ${Math.round(age / 1000)} שניות` };
  }

  // (5) המחרוזת-הקנונית + שחזור
  const pathname = new URL(req.url).pathname;
  const bodyHash = sha256Hex(rawBody);
  const payload = canonicalRoutePayload(kid, req.method, pathname, timestamp, bodyHash);
  const replayKey = sha256Hex(signature);
  if (replay.has(replayKey)) {
    return { ok: false, status: 401, code: "replay_detected", detail: "החתימה הזאת כבר-שימשה בקשה-שעברה — tuple שרוף אינו עובר בשנית" };
  }

  // (6) החתימה עצמה — Ed25519 על הבייטים הקנוניים
  if (!ring.verify(payload, signature, kid)) {
    return { ok: false, status: 401, code: "bad_signature", detail: "החתימה אינה מאמתת על המחרוזת-הקנונית (kid|method|path|timestamp|bodyHash)" };
  }

  // (7) רק-חתימה-מנצחת שורפת-עצמה
  replay.add(replayKey, now);
  return { ok: true, rawBody };
}
