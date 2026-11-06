#!/usr/bin/env bash
# keeper.sh — השומר החיצוני: השכבה-שמעל המתזמן.
#
# למה: ה-watchdog והמתזמן חיים בתוך fleet-runner (bun --hot index.ts). אם התהליך
# הזה מת — השומר הפנימי מת איתו, ואין מי שיקים את מי. זה בדיוק חוק-מות-הבונים
# של הבעלים: הסוכנים מתים, המערכת חייבת לחיות בלעדיהם — ולכן השומר-על-השומר
# חייב להיות תהליך-חוץ פשוט (bash+curl בלבד), שלא תלוי בשום דבר חי.
#
# תפקידים (כל 60שנ'):
#   :3031 נפל  → מקים fleet-runner (bun --hot index.ts, detached)
#   :3032/:3033 נפלו → start-nodes.sh (idempotent, נעול-flock, מחלים גם state)
#   :3000 נפל  → מקים את שרת-הפיתוח רק אם אין תהליך-next חי (אף-פעם לא כפילות)
#
# שימוש:
#   bash keeper.sh daemon   — לולאת-שמירה (singleton ב-pidfile)
#   bash keeper.sh ensure   — מקים את ה-daemon detached אם הוא לא רץ (לא נחסם)
#   bash keeper.sh once     — סריקה אחת (לבדיקה ידנית)
#
# fail-safe: pidfile מונע כפילויות; לוג מעוגל (500 שורות); אפס-סודות בלוג.
set -u

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$RUNNER_DIR/logs/keeper.log"
PIDFILE="/tmp/roshpina-keeper.pid"
INTERVAL="${KEEPER_INTERVAL:-60}"

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }
up() { curl -fsS -m 4 "$1" >/dev/null 2>&1; }

round_log() {
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
    tail -500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi
}

start_fleet() {
  log "fleet-runner :3031 down → relaunching (bun --hot index.ts, detached)"
  (cd "$RUNNER_DIR" && setsid --fork nohup bun --hot index.ts >> logs/fleet.log 2>&1 < /dev/null 9>&- &)
}

start_money() {
  log "money node(s) down → start-nodes.sh (idempotent self-heal)"
  (cd "$RUNNER_DIR" && bash start-nodes.sh >> logs/keeper-startnodes.log 2>&1) \
    || log "start-nodes.sh returned non-zero — see logs/keeper-startnodes.log"
}

ensure_next() {
  if up http://127.0.0.1:3000/; then return 0; fi
  if pgrep -f 'next dev' >/dev/null 2>&1; then
    log ":3000 down but a next-dev process exists — honest no-op (never double-start)"
    return 0
  fi
  log ":3000 down and no next process → autonomous restart (bun run dev)"
  (cd /home/z/my-project && setsid --fork nohup bun run dev >> dev.log 2>&1 < /dev/null 9>&- &)
}

sweep() {
  up http://127.0.0.1:3031/health || start_fleet
  local L M
  L=$(up http://127.0.0.1:3032/health && echo up || echo down)
  M=$(up http://127.0.0.1:3033/health && echo up || echo down)
  if [ "$L" = "down" ] || [ "$M" = "down" ]; then start_money; fi
  ensure_next
}

cmd_daemon() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "keeper already running (pid $(cat "$PIDFILE")) — skip"
    exit 0
  fi
  echo $$ > "$PIDFILE"
  round_log
  log "keeper daemon started (pid $$, interval ${INTERVAL}s) — the layer above the scheduler"
  while true; do
    sweep
    sleep "$INTERVAL"
  done
}

cmd_ensure() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "keeper ensured (already running, pid $(cat "$PIDFILE"))"
    exit 0
  fi
  (cd "$RUNNER_DIR" && setsid --fork nohup bash keeper.sh daemon >/dev/null 2>&1 < /dev/null 9>&- &)
  echo "keeper ensured (detached daemon launched)"
}

cmd_once() { sweep; echo "keeper: single sweep done (see $LOG)"; }

case "${1:-daemon}" in
  daemon) cmd_daemon ;;
  ensure) cmd_ensure ;;
  once)   cmd_once ;;
  *) echo "usage: keeper.sh [daemon|ensure|once]"; exit 1 ;;
esac
