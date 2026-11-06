# R33 evidence kit — R11-containment (Task 33, 2026-10-19)

כלי-הראיה של משימה 33: הכלה של תבנית-R11 (סיסמה לצד מעטפת) ב-recovery-meta.json של steem.

- `seal-r33.ts` — יצירת סוד-Actions `VAULT_PASSES_R33` על steem (sealed-box; הערכים מעולם לא נדפסו ולא נשמרו בדיסק).
- `redact-r33.ts` — הסרת שלושת שדות-ה-`pass` המוטבעים + חוק-משמורת + assertion-אפס-דליפה.
- `probe3.mjs` — פרובת חוק-הפענול: בלי-env → VAULT-PASS-CUSTODY; עם-env מההיסטוריה → roundtrip מלא (pins אומתו, אפס-הדפסות).

הסודות עצמם לא כאן ולא בשום-ריפו: Actions secrets בלבד (write-only).
קומיטים ב-steem (ענף saos-cockpit): 3877205 (הסרה) · 7dcaebc (חוק-writer-custody).
