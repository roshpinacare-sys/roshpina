#!/usr/bin/env bash
# vault-unseal.sh — פותח כספת אטומה מ-vault-sealed/ (גיט) אל תוך תיקיית-הריצה של ה-runner.
#
# זהו צעד-השחזור האוטונומי: אחרי מחיקת-סנדבוקס, הרשת משחזרת את עצמה מהגיט
# (start-nodes.sh) ואז פותחת את הכספת — היכולת-האינטליגנטית חוזרת לבד.
#
# שימוש: bash scripts/vault-unseal.sh [name]        (ברירת-מחדל: nim-api.env)
#   — idempotent: מדלג אם הקובץ-ביעד כבר קיים עם אותו sha256.
#   — fail-closed: חסר-blob/סיסמה → exit 1 עם הודעה ברורה (ה-runner ממשיך fail-closed בלי-AI).

set -euo pipefail

NAME="${1:-nim-api.env}"

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CP="$(cd "$RUNNER_DIR/../.." && pwd)"
SEALED="$CP/vault-sealed/$NAME.enc"
PASS_FILE="$CP/upload/vault.passphrase"
OUT_DIR="$RUNNER_DIR/data/vault"
OUT="$OUT_DIR/$NAME"

[ -f "$SEALED" ]     || { echo "VAULT-UNSEAL-FAIL: sealed blob missing: $SEALED"; exit 1; }
[ -s "$PASS_FILE" ]  || { echo "VAULT-UNSEAL-FAIL: passphrase missing/empty: $PASS_FILE (holder: operator)"; exit 1; }

mkdir -p "$OUT_DIR" && chmod 700 "$OUT_DIR" 2>/dev/null || true

WANT_SHA=""
if [ -f "$CP/vault-sealed/vault.manifest.json" ]; then
  WANT_SHA="$(bun -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const e=(m.entries||[]).find((x)=>x.name===process.argv[2]); console.log(e?e.sha256:"")' "$CP/vault-sealed/vault.manifest.json" "$NAME")"
fi

if [ -f "$OUT" ]; then
  HAVE_SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
  if [ -n "$WANT_SHA" ] && [ "$HAVE_SHA" = "$WANT_SHA" ]; then
    echo "VAULT-UNSEAL-SKIP: $NAME already unsealed and up-to-date (sha ${HAVE_SHA:0:16}…)"
    exit 0
  fi
fi

TMP="$OUT.unsealing"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$SEALED" -out "$TMP" -pass "file:$PASS_FILE" 2>/dev/null; then
  rm -f "$TMP"
  echo "VAULT-UNSEAL-FAIL: decryption failed (wrong passphrase or corrupted blob)"
  exit 1
fi

GOT_SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
if [ -n "$WANT_SHA" ] && [ "$GOT_SHA" != "$WANT_SHA" ]; then
  rm -f "$TMP"
  echo "VAULT-UNSEAL-FAIL: integrity mismatch (manifest ${WANT_SHA:0:16}… vs decrypted ${GOT_SHA:0:16}…)"
  exit 1
fi

chmod 600 "$TMP" && mv "$TMP" "$OUT"
echo "VAULT-UNSEAL-OK: $NAME → data/vault/$NAME (sha ${GOT_SHA:0:16}…, $(wc -c < "$OUT" | tr -d ' ') bytes)"
