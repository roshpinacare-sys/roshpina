#!/usr/bin/env bash
# night-heartbeat.sh — פעימות-לב חיצוניות למתזמן.
#
# למה: המתזמן רץ lazy (tick בכל-בקשה-נכנסת) + טיימר-גיבוי. בלילה אין-מבקרים —
# אם הטיימר מת (hot-reload משליך setInterval-ים), התזמונים עומדים בשקט.
# הפעימה-החיצונית הזאת מבטיחה tick כל-30 שניות גם-באפס-מבקרים, ומתעדת חיות.
#
# fail-safe: pidfile מונע כפילויות; לוג מתאים עגול (1000 שורות אחרונות).
# שימוש: bash night-heartbeat.sh &   (start-nodes.sh מפעיל אוטומטית)

set -u
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_URL="${RUNNER_URL:-http://127.0.0.1:3031/health}"
LOG="${RUNNER_DIR}/logs/heartbeat.log"
PIDFILE="/tmp/fleet-heartbeat.pid"

mkdir -p "${RUNNER_DIR}/logs"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "heartbeat already running (pid $(cat "$PIDFILE")) — skip"
  exit 0
fi
echo $$ > "$PIDFILE"

# round the log: keep the tail only
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

echo "[$(date -u +%FT%TZ)] heartbeat started (pid $$)" >> "$LOG"
while true; do
  TS="$(date -u +%FT%TZ)"
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "$RUNNER_URL" 2>/dev/null || echo 000)"
  echo "$TS $CODE" >> "$LOG"
  sleep 30
done
