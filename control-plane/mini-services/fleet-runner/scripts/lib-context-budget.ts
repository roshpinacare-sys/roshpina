/**
 * lib-context-budget.ts — תרופת context-mode שלנו (task 59, מיזוג mksglu/context-mode):
 * נתונים-גולמיים נשארים מחוץ לחלון-ההקשר — המודל מקבל סעיפים-מדורגי-עדיפות בתקציב-קבוע.
 * priority 1 = חיים/כסף (צמתים, שימור, כישלונות-חיים) · 2 = יומן/אנומליות · 3 = נוחות.
 * dropped[] נרשם בגלוי (לא שקט); avoided[] = החיסכון-נמדד מול-ההתנהגות-הקודמת.
 * טהור — אפס IO.
 */

export type BudgetSection = { name: string; priority: 1 | 2 | 3; text: string };
export type BudgetResult = { context: string; usedBytes: number; budgetBytes: number; dropped: string[]; avoidedBytes: number };

export const BUDGET_BYTES = 4600;

/** סעיף-החוק Think-in-Code — מתווסף ל-SYSTEM (המודל מתכנת את-הניתוח, לא קורא נתונים-גולמיים). */
export const THINK_IN_CODE_RULE = `חוק-חשיבה-בקוד: אסור לבקש עוד נתונים-גולמיים להקשר. אם הניתוח דורש חישוב על-נתונים גדולים — תכנן משימת code/insight ל-code-executor שמבצעת את-החישוב בקוד ומחזירה רק-את-התוצאה. ההקשר שלך יקר ומתוקצב.`;

/** גיבוש-ההקשר לפי-עדיפות: 1 נכנס תמיד, אחר-כך 2, אחר-כך 3 — עד-התקציב. */
export function budgetContext(sections: BudgetSection[], budgetBytes = BUDGET_BYTES): BudgetResult {
  const dropped: string[] = [];
  const kept: string[] = [];
  let used = 0;
  const order = [...sections].sort((a, b) => a.priority - b.priority);
  for (const s of order) {
    const cost = Buffer.byteLength(s.text, "utf8") + 1;
    if (used + cost <= budgetBytes) {
      kept.push(s.text);
      used += cost;
    } else {
      dropped.push(`${s.name}(p${s.priority},${cost}B)`);
    }
  }
  // avoided = מה-שהיה-נכנס בהתנהגות-הקודמת (הכל) מול-מה-שנכנס עכשיו
  const total = sections.reduce((n, s) => n + Buffer.byteLength(s.text, "utf8") + 1, 0);
  return { context: kept.join("\n"), usedBytes: used, budgetBytes, dropped, avoidedBytes: Math.max(0, total - used) };
}
