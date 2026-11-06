# saos-architect-supervisor — מפקח-העורקים-הריבוני (MASTER DIRECTIVE §1 · מחזור 31)

הדיימון-הילידי שמטמיע את סמכות-ראש-הארכיטקטורה **בתוך-הקוד** — כדי-שהצי ימשיך
לבנות, לסחור ולמדוד גם-אחרי-יציאת-כל-הסוכנים-החיצוניים.

## הלולאה (כל-120ש׳ ברירת-מחדל · single-flight)
```
observe (עיניים)  →  decide (מוח, טהור-ודטרמיניסטי)  →  act (ידיים, תחומות)  →  receipt (SAOS-ARCHITECT/1)
```

### observe — קריאה-בלבד
- דפיקות: דקס :3010 · issue-forge :3046 · כלכלה :3016 · edge :3000 · gateway :3140
- גילאי-קומיט אחרון ב-4 הריפואים הקנוניים · טריות-grid-beat ב-saos-dex
- ריצות-וורקפלו-ענן אחרונות (dex-grid / external-profit-publish / curate)
- **פסק-קלי** מ-`saos-dex/grids/state/kelly-sizing.json` (SAOS-KELLY/1)

### decide — מטריצה-דטרמיניסטית
1. מנוע-דקס מת → הקמת-מפקח saos-dex-node (ריפוי-עצמי-מהגיט, מסרב-כפילות)
2. issue-forge מת → הקמה; מחזור-ישן-מעל-15דק׳ → POST /cycle
3. grid-beat ישן-מעל-40דק׳ → dispatch-ענן + **שומר-קלי**: NO-EDGE ⇒ הגדלת-נפח
   נמנעת-מפורשות (עשיית-שוק-נמשכת-בקצב-מדיניות; אסור-להכפיל-שוליים-שליליים)
4. מדידה-חוץ ישנה-מעל-6ש׳ / קיורציה-מעל-8ש׳ → dispatch
5. נתיבים-של-אחרים (gateway/mesh/economy-resurrection) — **תצפית-בלבד, איסור-מגע**

### act — ידיים-תחומות
הפעלות-מנותקות (spawn detached) · POST /cycle · GitHub-REST-dispatch (טוקן-מ-vault-נתיב,
לעולם-לא-בקוד/בלוג). כל-מחזור = קבלה אחת בשרשרת-חשיש `prev→hash` (חוק-הצי).

## API (loopback)
- `GET /health` — חיות, מחזורים, קבלות
- `GET /state` — תצפית-אחרונה + פעולות
- `POST /cycle[?dry=1]` — מחזור-תחום-אחד (dry = החלטות-בלי-ביצוע)

## הוכחות
- `bun run selftest.mjs` — אופליין דטרמיניסטי: מטריצת-החלטות מלאה, שרשרת-קבלות
  (prev-link + recompute), תוכניות-הפעלה, תחומים. אדום=exitCode 1.
- פנקס-חי: `state/architect-ledger.jsonl` (append-only, gitignored-state)

## גבולות-כנים
- הדיימון אינו-סוחר-בעצמו — הוא מפקח ומעיר את-העורקים שכן (מנוע-הדקס, הגריד, issue-forge)
- אכיפת-קלי בשלב-observe: המלצה-מתועדת; המעבר-ל-enforce דורש-דבר-בעלים (דוקטרינת-מעבר-מדורג)
