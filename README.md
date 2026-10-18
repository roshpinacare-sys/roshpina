# roshpina-sealed-vault — הכספת-האטומה של הרשת הריבונית

ענף-כספת (orphan, snapshot-semantics): מכיל **רק את מה שאטום** — אפס-סודות בגלוי.

## מה כאן
- `vault-sealed/*.enc` — blobs מוצפנים (AES-256-CBC + PBKDF2, 200k איטרציות)
- `vault-sealed/vault.manifest.json` — מטא-דאטה: שמות, sha256, גדלים, תאריכים (ללא-סודות)
- `scripts/vault-seal.sh` — איטום (מריץ מול עץ-הבקרה ב-/home/z/my-project)
- `scripts/vault-unseal.sh` — פתיחה אוטונומית (זהו צעד-השחזור אחרי מחיקת-סנדבוקס)
- `scripts/start-nodes.sh` — מנוע-השחזור העצמי (כולל צעד 3.5: unseal ב-boot)

## תוכן-הכספת (רשום במניפסט)
| שם | מטרה | צרכן |
|---|---|---|
| nim-api.env | מפתח NVIDIA NIM + תצורת-מודלים | ai-sentinel preset ב-runner |

## חוקי-הכספת
1. סוד בגלוי אף-פעם לא נכנס לגיט — רק blobs מוצפנים.
2. סיסמת-הכספת חיה מקומית בלבד: upload/vault.passphrase (gitignored) — בבעלות-המפעיל בלבד.
3. פתיחה = רק דרך vault-unseal.sh (מאמת sha256 מול המניפסט לפני-כתיבה).
4. אובדן-סיסמה → המפעיל מספק-מחדש את הסוד עצמו ואוטם שוב (ההחלטה שלו, לא שלנו).

## שחזור-אוטונומי אחרי מחיקת-סנדבוקס
start-nodes.sh מריץ ב-boot: clone מהגיט → שחזור-מצב מקפסולה → unseal (אם הסיסמה זמינה מקומית) → צמתים למעלה כולל יכולת-AI.

## איטום-מחדש / עדכון-סוד
```bash
cd /home/z/my-project
bash mini-services/fleet-runner/scripts/vault-seal.sh mini-services/fleet-runner/data/vault/nim-api.env nim-api.env
# ואז דחיפה דו-אזורית של הענף הזה (branch + archive tag)
```
