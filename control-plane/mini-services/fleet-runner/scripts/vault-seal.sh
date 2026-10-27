#!/usr/bin/env bash
# vault-seal.sh — אוטם סוד מקומי לתוך vault-sealed/ (AES-256-CBC + PBKDF2, 200k איטרציות).
#
# החוק: סוד בגלוי אף-פעם לא נכנס לגיט. הכספת בגיט היא אטומה — מי שאין לו
# את סיסמת-הכספת (upload/vault.passphrase, מקומית בלבד, בבעלות-המפעיל) לא רואה כלום.
#
# שימוש: bash scripts/vault-seal.sh <secret-file> [name]
#   <secret-file>  קובץ-סוד מקומי (למשל data/vault/nim-api.env)
#   [name]         שם-היעד ב-vault-sealed/ (ברירת-מחדל: basename של הקובץ)
#
# fail-closed: חסר-קובץ/סיסמה → exit 1 לפני כל כתיבה.

set -euo pipefail

SECRET_FILE="${1:?usage: vault-seal.sh <secret-file> [name]}"
NAME="${2:-$(basename "$SECRET_FILE")}"

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CP="$(cd "$RUNNER_DIR/../.." && pwd)"
SEALED_DIR="$CP/vault-sealed"
PASS_FILE="$CP/upload/vault.passphrase"

[ -f "$SECRET_FILE" ] || { echo "VAULT-SEAL-FAIL: secret file missing: $SECRET_FILE"; exit 1; }
[ -s "$PASS_FILE" ]   || { echo "VAULT-SEAL-FAIL: passphrase missing/empty: $PASS_FILE"; exit 1; }

SIZE="$(wc -c < "$SECRET_FILE" | tr -d ' ')"
if [ "$SIZE" -eq 0 ]; then echo "VAULT-SEAL-FAIL: secret file is empty"; exit 1; fi
# גרדיאן: לא לאטום מפתחות-פרטיים במקרה (למרות שהתבנית מותרת) — הסוד חייב להיות env טקסט
case "$SECRET_FILE" in *.pem|*.key|*.priv.*) echo "VAULT-SEAL-FAIL: refusing private key material — env secrets only"; exit 1;; esac

mkdir -p "$SEALED_DIR"
OUT="$SEALED_DIR/$NAME.enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$SECRET_FILE" -out "$OUT" -pass "file:$PASS_FILE"

SHA="$(sha256sum "$SECRET_FILE" | cut -d' ' -f1)"
SEALED_SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"

# מניפסט — מטא-דאטה בלבד, אפס-סודות
MANIFEST="$SEALED_DIR/vault.manifest.json"
TMP="$MANIFEST.tmp"
if [ -f "$MANIFEST" ]; then
  # עדכון-רשומה קיימת (jq-free; דורש node/bun — קיים בסביבה)
  bun -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const e = { name: process.argv[2], algorithm: "aes-256-cbc+pbkdf2(200k)", sha256: process.argv[3], sealedSha256: process.argv[4], sizeBytes: Number(process.argv[5]), sealedAt: new Date().toISOString() };
    const i = m.entries.findIndex((x) => x.name === e.name);
    if (i >= 0) m.entries[i] = e; else m.entries.push(e);
    m.updatedAt = e.sealedAt;
    fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
  ' "$MANIFEST" "$NAME" "$SHA" "$SEALED_SHA" "$SIZE"
else
  bun -e '
    const fs = require("fs");
    const now = new Date().toISOString();
    const m = { vault: "roshpina-sealed-vault", version: 1, algorithm: "aes-256-cbc+pbkdf2(200k)", passphraseHolder: "operator — upload/vault.passphrase (local-only, gitignored)", createdAt: now, updatedAt: now, entries: [{ name: process.argv[2], algorithm: "aes-256-cbc+pbkdf2(200k)", sha256: process.argv[3], sealedSha256: process.argv[4], sizeBytes: Number(process.argv[5]), sealedAt: now }] };
    fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
  ' "$MANIFEST" "$NAME" "$SHA" "$SEALED_SHA" "$SIZE"
fi

echo "VAULT-SEAL-OK: $NAME → vault-sealed/$NAME.enc (plaintext sha256=${SHA:0:16}…, $SIZE bytes)"
