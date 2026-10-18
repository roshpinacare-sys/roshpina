// agent-lab/economy-run-improver.ts
// טהור: אין fetch, spawn, eval, או סודות. מוגבל ל-24KB.
export interface RetryOptions {
  /** מספר ניסיונות מקסימלי (כולל הניסיון הראשון) */
  maxAttempts?: number;
  /** עיכוב בסיסי ב-ms לפני retry ראשון */
  baseDelayMs?: number;
  /** גורם הכפלה לכל ניסיון (ברירת מחדל 2) */
  factor?: number;
  /** עיכוב מקסימלי ב-ms */
  maxDelayMs?: number;
}

/**
 * מריץ פונקציה שמחזירה Promise עם מנגנון retry ואקספוננציאלי backoff.
 * אם כל הניסיונות נכשלים, זורק את השגיאה האחרונה.
 */
export async function runWithRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 100, factor = 2, maxDelayMs = 5000 } = options;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) {
        // אין יותר ניסיונות – זרוק את השגיאה האחרונה
        throw err;
      }
      // חישוב עיכוב עם קאפ
      const delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
      // לוג בסיסי (מותר בסביבת פיתוח)
      console.log(`[economy-run-improver] attempt ${attempt} failed, retrying in ${delay}ms`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}
// ייצוא ברירת מחדל לנוחות (אינו חובה)
export default { runWithRetry };
