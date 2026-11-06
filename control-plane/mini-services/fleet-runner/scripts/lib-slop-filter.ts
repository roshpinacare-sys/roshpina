/**
 * lib-slop-filter.ts — מסנן-ה-slop המכונתי (מיזוג anti-slop R-02/R-16/R-17/R-18/R-36)
 * + חוזה-האתר המשותף sitePayloadInvalidReason (כותב-אחד: המפיק והצרכן מייבאים מכאן).
 *
 * שתי-קומות-כנות: tier1 = הייפ/טענות-מומצאות → נחתך במקור (SLOP);
 * tier2 = ראיה-בלבד — נספר ומתועד, לעולם לא הורג.
 * חוק-הכנות: מספרים מדודים-חיים של הצי (−53%, 4/6, seq 1445) אף-פעם לא נענשים —
 * הנתונים-החיים שלנו הם מקור-האמת, לא סלוגן.
 * טהור — אפס IO; רץ ב-bun ובדפדפן כאחד.
 */

export type SlopTier = 1 | 2;
export type SlopHit = { rule: string; tier: SlopTier; label: string; count: number; sample?: string };
export type SlopScanResult = {
  verdict: "CLEAN" | "SLOP";
  tier1: number;
  tier2: number;
  hits: SlopHit[];
  scannedBytes: number;
};

type SlopRule = { id: string; tier: SlopTier; label: string; rx: RegExp };

// Hebrew hype forms are prefix-matched so all declensions catch (מהפכני/מהפכנית/מהפכניים).
const RULES: SlopRule[] = [
  // ── tier 1: קטלני — הייפ וטענות-מומצאות ──
  { id: "R-16", tier: 1, label: "הייפ-עברית (מהפכני/פורץ-דרך/ברמה-עולמית/מוביל-בתעשייה/שינוי-משחק/עידן-חדש)", rx: /מהפכנ|פורץ[- ]דרך|ברמה[- ]עולמית|מוביל[- ]בתעשייה|שינוי[- ]משחק|עידן[- ]חדש/g },
  { id: "R-17", tier: 1, label: "מספר-קסם (%,מוקבץ בפסיקים — 10,000% ודומיו)", rx: /\b\d{1,3}(?:,\d{3})+\s?%/g },
  { id: "R-17", tier: 1, label: "טענת-ROI מומצאת (ROI + מספר-שרירותי)", rx: /\bROI\b[^.]{0,24}\d+\s?%/gi },
  { id: "R-18", tier: 1, label: "הוכחה-חברתית מזויפת (trusted by thousands/אלפי לקוחות מרוצים)", rx: /trusted by (thousands|millions)|millions of (users|customers)|אלפי לקוחות מרוצים|מאות אלפי משתמשים|#1 rated/gi },
  { id: "R-36", tier: 1, label: "קוספליי-רגולציה (SOC 2 / ISO 27001 ״מאושר״ בלי תעודה)", rx: /(SOC\s?-?2|ISO\s?-?27001)[^.\n]{0,40}(certified|compliant|מאושר|מוסמך)/gi },
  // ── tier 2: ראיה-בלבד ──
  { id: "R-02", tier: 2, label: "מקף-אמנותי (—)", rx: /—/g },
  { id: "R-16", tier: 2, label: "אוצר-מילים-ריק (unlock/elevate/empower/delve/seamless/…)", rx: /\b(unlock|elevate|empower|delve|seamless(ly)?|leverage|game-?changer|cutting-?edge|revolutionize|foster|testament|robust)\b/gi },
  { id: "R-36", tier: 2, label: "אימוג'י-בשיווק", rx: /[\u{1F300}-\u{1FAFF}\u{2728}\u{274C}\u{2705}\u{2B50}]/gu },
  { id: "R-36", tier: 2, label: "סגירת-צ'אטבוט (chat with our bot/צ'אטבוט)", rx: /(chat with our|our chatbot|הצ'אטבוט שלנו|בוט-השיחה שלנו)/gi },
];

/** סריקת-טקסט גנרית — tier1>0 ⇒ SLOP (הכרעה קטלנית), tier2 נספר לראיה בלבד. */
export function slopScan(text: string): SlopScanResult {
  const hits: SlopHit[] = [];
  let tier1 = 0;
  let tier2 = 0;
  for (const r of RULES) {
    const m = text.match(r.rx);
    if (!m || m.length === 0) continue;
    hits.push({ rule: r.id, tier: r.tier, label: r.label, count: m.length, sample: m[0].slice(0, 24) });
    if (r.tier === 1) tier1 += m.length;
    else tier2 += m.length;
  }
  return { verdict: tier1 > 0 ? "SLOP" : "CLEAN", tier1, tier2, hits, scannedBytes: text.length };
}

// ── חוזה-האתר: כותב-אחד לכל-הצדדים (מיזוג task-62 — סוף-לשני-כותבים-זהים) ──

export type SiteItem = { id: string; title: string; body: string; kind: string; createdAt: string };
export type SiteNetPayload = { items: SiteItem[] };
export type SiteItemScan = { items: { id: string; title: string; body: string }[]; slopIds: string[]; allClean: boolean };

/**
 * הסיבה המדויקת שה-payload פסול — או null אם תקין. שדה-שדה, עם אינדקס וערך-נמדד.
 * המפיק (ai-architect) והצרכן (code-executor) מייבאים מכאן — תקן-אחד, אבחנה-שדה-רמה.
 */
export function sitePayloadInvalidReason(raw: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return `broken JSON: ${String(e).slice(0, 120)}`;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return `root must be an object — got ${Array.isArray(v) ? "array" : typeof v}`;
  const items = (v as Record<string, unknown>).items;
  if (!Array.isArray(items)) return `items[] missing — got ${items === undefined ? "undefined" : typeof items}`;
  if (items.length < 1) return "items[] empty — a broadcast needs at least 1 item";
  if (items.length > 20) return `items[] too long: ${items.length} > 20`;
  const kinds = new Set(["broadcast", "note", "milestone", "commitment"]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Record<string, unknown>;
    const id = String(it?.id ?? "");
    if (!id || id.length > 40) return `items[${i}].id must be 1..40 chars — got ${id.length}`;
    const title = String(it?.title ?? "");
    if (title.length < 5 || title.length > 160) return `items[${i}].title must be 5..160 chars — got ${title.length}`;
    const body = String(it?.body ?? "");
    if (body.length < 50) return `items[${i}].body must be ≥50 chars — got ${body.length}`;
    if (body.length > 4000) return `items[${i}].body must be ≤4000 chars — got ${body.length}`;
    if (!kinds.has(String(it?.kind))) return `items[${i}].kind must be broadcast|note|milestone|commitment — got "${String(it?.kind).slice(0, 24)}"`;
    if (Number.isNaN(Date.parse(String(it?.createdAt ?? "")))) return `items[${i}].createdAt not ISO-parseable — got "${String(it?.createdAt).slice(0, 32)}"`;
  }
  return null;
}

/**
 * נרמול-ייצוג במקור (task-62): המודל מחזיר content כאובייקט-JSON (לא מחרוזת) —
 * String(obj)='[object Object]' הוא הרוצח-הנמדד; כאן זה נהיה JSON תקין. ללא-שינוי-חוזה.
 */
export function normalizeSitePayloadContent(t: { action?: string; path?: string; content?: unknown }): { action?: string; path?: string; content?: string } {
  if (t.action !== "code" || t.path !== "site-data://sovereign-net.json") return t as { content?: string };
  if (typeof t.content === "string") return t as { content: string };
  try {
    return { ...t, content: JSON.stringify(t.content) };
  } catch {
    return { ...t, content: undefined };
  }
}

/**
 * סריקת-slop לפריטי-האתר (task-60): מפרק JSON, סורק title+body לכל-פריט,
 * מבודד פריטים-פגומים (slopIds) — פריט-נקי לא נוגע. JSON שבור ⇒ allClean:true
 * (השער-המבני יקריס אותו בעצמו — לא כפילות-שערים).
 */
export function slopScanSiteItems(raw: string): SiteItemScan {
  try {
    const v = JSON.parse(raw) as { items?: { id?: string; title?: string; body?: string }[] };
    const items = Array.isArray(v.items) ? v.items : [];
    const slopIds: string[] = [];
    for (const it of items) {
      const scan = slopScan(`${it?.title ?? ""}\n${it?.body ?? ""}`);
      if (scan.verdict === "SLOP") slopIds.push(String(it?.id ?? "?"));
    }
    return { items: items.map((it) => ({ id: String(it?.id ?? ""), title: String(it?.title ?? ""), body: String(it?.body ?? "") })), slopIds, allClean: slopIds.length === 0 };
  } catch {
    return { items: [], slopIds: [], allClean: true };
  }
}

/** חסימת-SYSTEM (מנע-במקור) — מוזרק ל-SYSTEM של שני-הסוכנים (task-60). */
export const SLOP_PROMPT_RULES = `איסור-סלופ אבסולוטי (הטקסט שלך נסרק מכונתית ונחתך במקור): אסור הייפ — מהפכני, פורץ-דרך, ברמה-עולמית, מוביל-בתעשייה, שינוי-משחק, עידן-חדש; אסורות טענות-אחוז מומצאות (למשל 10,000%, ROI-X%) וכל-מספר שאינו מהנתונים החיים שלפניך; אסורה הוכחה-חברתית מזויפת ("אלפי לקוחות מרוצים"); אסור להצהיר SOC 2 / ISO 27001 ״מאושר״. כתוב רק עובדות מדודות מהנתונים החיים. מקפים-אמנותיים (—) ומילות-בזבז (unlock/elevate/seamless) נספרים כראיה — הפחת אותם. טקסט שייכשל בסריקה ייחתך במקור או יירשם כ-slop — לא יפורסם.`;
