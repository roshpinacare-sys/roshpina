/**
 * format.ts — פורמט-כסף אחיד לכל-הפלטפורמה.
 *
 * כל-הכסף בקרנל הוא BigInt µ¢ (מיקרו-סנט).
 * חוקי-התצוגה (דטרמיניסטיים, ללא float, ללא Intl):
 *   • חוצץ דטרמיניסטי: 1 ₪ = 1_000_000 µ¢  (MC_PER_UNIT — סימון-מפורש לפורמט µ¢)
 *   • formatNis(mc)  → "₪1,234.56"   (חיתוך-רצפה ל-2 ספרות)
 *   • formatMc(mc)   → "1,234,567,890 µ¢" (המספר הגולמי, להצגת-דיוק)
 *   • parseNisToMc("12.34") → 12_340_000n  (מתמטיקת-מחרוזות בלבד)
 * פונקציות אלו טהורות — אותה-קלט, אותה-פלט, בשרת ובלקוח.
 */

/** החוצץ הדטרמיניסטי של פורמט µ¢ — אין לשנות ללא-תיאום כל-הפלטפורמה. */
export const MC_PER_UNIT = 1_000_000n;

function groupDigits(digits: string): string {
  let out = "";
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    out = digits[i] + out;
    count++;
    if (count % 3 === 0 && i > 0) out = "," + out;
  }
  return out;
}

/** µ¢ → "₪1,234.56" — רצפה דטרמיניסטית, תמיכה בשלילי (מאזן-שמורה). */
export function formatNis(mc: bigint, decimals = 2): string {
  const negative = mc < 0n;
  const abs = negative ? -mc : mc;
  const whole = abs / MC_PER_UNIT;
  const frac = abs % MC_PER_UNIT;
  const scale = 10n ** BigInt(decimals);
  const fracScaled = (frac * scale) / MC_PER_UNIT;
  const fracStr = decimals > 0 ? "." + fracScaled.toString().padStart(decimals, "0") : "";
  return `${negative ? "−" : ""}₪${groupDigits(whole.toString())}${fracStr}`;
}

/** µ¢ גולמי עם הפרדת-אלפים — לתצוגת-דיוק מלאה. */
export function formatMc(mc: bigint): string {
  const negative = mc < 0n;
  const abs = negative ? -mc : mc;
  return `${negative ? "−" : ""}${groupDigits(abs.toString())} µ¢`;
}

/** קלט-משתמש ב-₪ → µ¢ (BigInt). מחזיר null על קלט-לא-חוקי. */
export function parseNisToMc(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
  const [whole, fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "000000").slice(0, 6);
  return BigInt(whole) * MC_PER_UNIT + BigInt(frac);
}

/** קיצור-האש לתצוגה (מונו, LTR ב-CSS). */
export function shortHash(hash: string, head = 10, tail = 4): string {
  if (!hash) return "";
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** תווית-זמן קצרה (שעה:דקה:שנייה) — מוצגת בלקוח בלבד, לאחר-קבלת-נתונים. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** תוויות-עברית לסוגי-פעולה של הקרנל. */
export const ACTION_LABELS: Record<string, string> = {
  "ledger.mint": "הנפקת-אשראי",
  "ledger.withdraw": "משיכה",
  "ledger.transfer": "העברה",
  "ledger.solvency_check": "הוכחת יכולת-פירעון",
  "potential.analyze": "ניתוח-פוטנציאל",
  "potential.route": "ניתוב-להזדמנות",
  "marketplace.create": "פתיחת-הזדמנות",
};

/** תוויות-עברית למצבי-הצבה. */
export const ESCROW_STATE_LABELS: Record<string, string> = {
  created: "נוצרה",
  funded: "מומנה",
  released: "שוחררה",
  refunded: "הוחזרה",
  disputed: "במחלוקת",
};
