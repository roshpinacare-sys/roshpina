/* ═══ vault-auth · חוק-הסף-הריבוני (deny-by-default מול-השער-הציבורי) ═════════
 * הנחת-היסוד-הנמדדת (גל-80 · trace 1a173c3929f5d23d §1): ה-Caddyfile של-הסנדבוקס
 * מעביר תעבורה-ציבורית אל כל-פורט-לוקאלי דרך `?XTransformPort=` — כלומר כל
 * איבר-צי שבודק "האם-המתקשר-מלופבק?" (srv.requestIP / peer address) רואה את
 * Caddy עצמו (127.0.0.1) ומאשר תוקף-אנונימי מהאינטרנט-הפומבי. המדידה:
 * reverse_proxy localhost:{port} ⇒ ה-peer של-האיבר הוא-תמיד Caddy.
 *
 * המשטר-החדש (שכבה-נוספת, לא-ביטול-קיים):
 *  · בקשה-שהגיעה-דרך-השער (Caddy מצמיד X-Real-IP / X-Forwarded-For בעצמו —
 *    header_up ב-Caddyfile דורס-ספויוף-של-הלקוח) = מישור-ציבורי.
 *  · מוטציה (POST/PUT/DELETE/PATCH) במישור-הציבורי ← חייבת טוקן-כספת תקף
 *    (X-Vault-Token או Authorization: Bearer). אחרת: 403 fail-closed + לוג-רועש.
 *  · בקשת-לופבק-ישירה (בלי כותרות-שער — הקוראים-הפנימיים-של-הצי) = מישור-האמון-
 *    של-הצי, נשארת-חיה (חוק-הפעלה-ולא-סגירה: לולאות-הפנים לא נשברות).
 *  · הטוקן: env SOVEREIGN_VAULT_TOKEN ← קובץ /home/z/coord-work/vault/operator-token
 *    (0600, המצאה-עצמית בהיעדר — אותו-חוק של saos-dex-node readToken גל-92).
 *    הבעלים (headcorner) יכול להחליף את הקובץ בטוקן-גזור-מהכספת בכל-עת —
 *    המפתח-הקריפטוגרפי נשאר במשמורת-הבעלים; האיברות מאמתות מולו ב-constant-time.
 * אפס-תלויות; node:crypto בלבד; בדיקות: vault-auth.test.ts */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

export const VAULT_TOKEN_FILE_DEFAULT = "/home/z/coord-work/vault/operator-token";

/** נתיב-קובץ-הטוקן נקרא בכל-קריאה — env חי-תמיד. פגם-חי-שנמדד (2026-10-27T12:34Z,
 * suite-vs-isolated 2/8↔8/8): הקבוע-הישן נתפס בזמן-הייבוא, ומבחן-שירות-קודם
 * (quality-gate/organ-commander/audit) מייבא את-המודול בטרם היערכות הסביבה —
 * החוזה "env שולט בנתיב" שיקר תחת מטמון-מודול. קריאה-דינמית = החוזה מחזיק
 * בכל-סדר-ייבוא; אפס-שינוי-התנהגות בראנטיים (ברירת-המחדל זהה). */
export function vaultTokenFile(): string {
  return (process.env.VAULT_TOKEN_FILE || "").trim() || VAULT_TOKEN_FILE_DEFAULT;
}

const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/** האם-הבקשה-הגיעה דרך-השער-הציבורי (Caddy מצמיד כותרות-אמת-מקור בעצמו)? */
export function isGatewayBorne(req: Request): boolean {
  return !!(req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for"));
}

export function isMutation(req: Request): boolean {
  return MUTATION_METHODS.has((req.method || "GET").toUpperCase());
}

/** הטוקן-הנוכחי: env ← קובץ-כספת עמיד; בהיעדר-שניהם — המצאה-עצמית (0600). אף-פעם לא מוחזר לרשת. */
export function vaultToken(): string {
  const env = (process.env.SOVEREIGN_VAULT_TOKEN || "").trim();
  if (env) return env;
  const TOKEN_FILE = vaultTokenFile();
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch { /* אין-קובץ — מטביעים-עכשיו */ }
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
    console.info(`[vault-auth] טוקן-כספת הומצא-עצמית (${TOKEN_FILE} · chmod 600) — הסף-הריבוני חי ללא-מפעיל`);
    return token;
  } catch (e) {
    console.error(`[vault-auth] הטבעה-נכשלה: ${e instanceof Error ? e.message : String(e)} — fail-closed (המוטציות-הציבוריות יידחו)`);
    return "";
  }
}

/** טביעת-אצבע-ציבורית-של-הטוקן (לקבלות-בלי-חשיפת-חומר): sha256 ראשונים-16. */
export function vaultFingerprint(): string {
  const t = vaultToken();
  return t ? createHash("sha256").update(t).digest("hex").slice(0, 16) : "none";
}

/** אימות-קבוע-זמן של X-Vault-Token / Bearer מול-הטוקן-החי. */
export function verifyVaultToken(req: Request): boolean {
  const expected = vaultToken();
  if (!expected) return false; // אין-כספת = דחייה-מוחלטת (fail-closed)
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const given = (req.headers.get("x-vault-token") || bearer || "").trim();
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export interface DenyLog { denyCount: number }

/** השוער-המאוחד: מחזיר תגובת-403 אם-מוטציה-ציבורית-בלי-טוקן; null = המשך-חופשי.
 * שימוש: const deny = denyIfPublic(req, "[fleet-economy]"); if (deny) return deny; */
export function denyIfPublic(req: Request, organ: string, log?: DenyLog): Response | null {
  if (!isMutation(req)) return null;
  if (!isGatewayBorne(req)) return null; // מישור-האמון-הפנימי (לופבק-ישיר)
  if (verifyVaultToken(req)) return null;
  log && log.denyCount++;
  const ip = String(req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "?").slice(0, 45);
  console.warn(`[vault-auth] DENY ${organ} ${req.method} ${new URL(req.url).pathname} from ${ip} — unauthenticated mutation via public gateway (fail-closed, חוק-הסף-הריבוני)`);
  return Response.json({ ok: false, error: "vault-token-required", organ, law: "deny-by-default/1" }, { status: 403 });
}
