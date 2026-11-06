/**
 * lib-model-ladder.ts — סולם-מודלים אדפטיבי (task 61): זיכרון-קטן של
 * lastGood/lastBad (+סוג, +זמן) בחלון 30ד׳. מודל-ראשי שמת-טרייה (503/404/timeout)
 * בתוך-החלון ⇒ מתחילים ישירות מה-last-good (ה-fallback) — בלי לשרוף דקות על
 * בטוח-מת. הסדר-הסטטי נשאר החוק; הזיכרון רק מדלג על-הבטוח-מת.
 * IO מינימלי: קובץ-state אחד (data/ai/model-ladder.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

const FRESH_MS = 30 * 60 * 1000; // חלון 30 דקות
export type LadderState = { lastGood?: { model: string; at: string }; lastBad?: { model: string; kind: string; at: string } };

export function readLadderState(path: string): LadderState {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LadderState) : {};
  } catch {
    return {};
  }
}

export function writeLadderState(path: string, s: LadderState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  } catch { /* ראיה לא מפילה ריצה */ }
}

const fresh = (iso?: string): boolean => typeof iso === "string" && Date.now() - Date.parse(iso) < FRESH_MS;

/**
 * הצעת-סדר: אם הראשי רשום בדיוק-עכשיו כמת-טרייה וה-fallback חי-מוכח — מתחילים
 * מה-fallback (ראיה נספרת ב-note). אחרת הסדר-הסטטי המלא.
 */
export function ladderOrder(primary: string, fallback: string, st: LadderState): { order: string[]; note: string } {
  const bad = st.lastBad;
  if (bad && bad.model === primary && fresh(bad.at) && st.lastGood?.model === fallback) {
    return { order: [fallback, primary], note: `ladder: ${primary} fresh-dead (${bad.kind} @${bad.at.slice(11, 19)}Z) → fallback-first` };
  }
  return { order: [primary, fallback], note: "ladder: static order" };
}

/** רישום-כנה אחרי-כל-ניסיון. */
export function recordLadder(path: string, model: string, ok: boolean, kind?: string): void {
  const st = readLadderState(path);
  if (ok) {
    st.lastGood = { model, at: new Date().toISOString() };
    if (st.lastBad?.model === model) delete st.lastBad;
  } else {
    st.lastBad = { model, kind: kind ?? "fail", at: new Date().toISOString() };
    if (st.lastGood?.model === model) delete st.lastGood;
  }
  writeLadderState(path, st);
}
