/**
 * instrumentation.ts — רישום-השרת של רושפינה.
 * Next.js מריץ register() פעם-אחת בעליית-התהליך — כאן מזריעים את העולם
 * כך ש-GET routes יישארו טהורים (קריאה בלבד, לעולם לא מוטציה).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureSeed } = await import("@/lib/seed");
    await ensureSeed();
  } catch (err) {
    // כשל-זריעה חייב להיות גלוי — הפלטפורמה לא משקרת על מצבה.
    console.error("[roshpina] seed failed:", err instanceof Error ? err.message : err);
  }
}
