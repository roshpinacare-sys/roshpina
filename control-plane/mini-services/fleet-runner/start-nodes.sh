#!/usr/bin/env bash
# start-nodes.sh v2 — self-healing starter for the execution network's money nodes.
#
# Heals, in order, exactly what the last sandbox wipe broke:
#   1. missing repo      → clone from GitHub (the source of truth) via FLEET_TOKEN_FILE
#   2. wrong ref         → checkout agent4/p2-sovereign-market (where serve.ts/market-serve.ts live)
#   3. sealed vault      → unseal AI capability first (fast local decrypt; before heavy restore)
#   4. missing state     → restore latest state-backup snapshot (if both data dirs are empty)
#   5. missing dev keys  → provision fresh local dev keys (gitignored; never vaults, never PAT rotation)
#   6. down nodes        → start only what's not listening
#
# Idempotent. Touches nothing else. Token is never printed — every output is sanitized.
set -u

# ── 0) singleton lock: concurrent invocations raced at the 06:06 reboot ──────
# (two watchdog-driven start-nodes.sh ran at once; the `up` checks saved us by
# luck). flock serializes: a second invocation exits immediately as a no-op.
#
# live bug 2026-10-19 (5th recurrence, root-caused to TWO defects):
#  (a) plain `setsid` does NOT detach — util-linux setsid only forks when the
#      caller is already a process-group leader; the daemon stayed a direct
#      child of this bash and the launch subshell blocked in do_wait forever
#      while holding the lock (3.5h stall at 00:42).
#  (b) `exec 9>"$LOCK"` fd 9 has no CLOEXEC and was INHERITED by the daemons,
#      so bun itself held the singleton flock after bash died — every future
#      self-heal no-op'd behind a dead market.
# Fix: `setsid --fork` (explicit detach, daemon reparents to PID 1) and
#      `9>&-` at every launch site (daemons never inherit the lock fd).
LOCK=/tmp/start-nodes.lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "start-nodes: another start-nodes.sh holds the lock — exiting (idempotent no-op)"
  exit 0
fi

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$RUNNER_DIR/logs"
mkdir -p "$LOGS"
REPO="/home/z/repos/roshpina"
SNAP_DIR="/home/z/my-project/state-snapshots"
BRANCH="agent4/p2-sovereign-market"
TOKEN_FILE="${FLEET_TOKEN_FILE:-/home/z/my-project/upload/pat.env}"
KEYS="$RUNNER_DIR/data/keys"

log() { echo "start-nodes: $*"; }
up() { curl -fsS -m 2 "$1" >/dev/null 2>&1; }
sanitize() { # usage: sanitize "$TOKEN" "$text"
  local t="$1" s="$2"
  [ -n "$t" ] && printf '%s' "$s" | sed "s|${t}|***|g" || printf '%s' "$s"
}

echo "start-nodes: self-healing check at $(date -Is)"

# ── 1) repo ensure ────────────────────────────────────────────────────────────
if [ ! -d "$REPO/.git" ]; then
  log "repo missing at $REPO — cloning from GitHub (working by git, not by sandbox)"
  TOKEN=""
  [ -f "$TOKEN_FILE" ] && TOKEN=$(grep -oE '(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+' "$TOKEN_FILE" | head -n1)
  if [ -z "$TOKEN" ]; then
    log "no usable token at $TOKEN_FILE — cannot clone; aborting (fail-closed, nothing touched)"
    exit 1
  fi
  mkdir -p "$(dirname "$REPO")"
  OUT=$(git clone --quiet "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/roshpina.git" "$REPO" 2>&1)
  RC=$?
  [ -n "$OUT" ] && sanitize "$TOKEN" "$OUT" >> "$LOGS/start-nodes.log"
  if [ $RC -ne 0 ]; then log "clone failed (rc=$RC) — see logs/start-nodes.log; aborting"; exit 1; fi
  git -C "$REPO" remote set-url origin "https://github.com/roshpinacare-sys/roshpina.git"
  log "cloned OK (clean remote URL, token not stored in .git/config)"
fi

# ── 2) ref ensure ─────────────────────────────────────────────────────────────
# Resilience: branches can be deleted/archived by other fleet streams — if the
# branch fetch fails, fall back to the archive tag (refs/tags/archive/agent4/*)
# and rebuild the local working branch from it. Dual-ref pushes keep both alive.
TAGREF="refs/tags/archive/agent4/p2-sovereign-market"
if [ ! -f "$REPO/serve.ts" ] || [ ! -f "$REPO/market-serve.ts" ]; then
  log "serving code missing on current ref — fetching + switching to $BRANCH"
  TOKEN=""
  [ -f "$TOKEN_FILE" ] && TOKEN=$(grep -oE '(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+' "$TOKEN_FILE" | head -n1)
  FETCHED=""
  if [ -n "$TOKEN" ]; then
    OUT=$(git -C "$REPO" fetch --quiet "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/roshpina.git" "$BRANCH:$BRANCH" 2>&1) \
      && sanitize "$TOKEN" "$OUT" >> "$LOGS/start-nodes.log" && FETCHED="branch"
  else
    git -C "$REPO" fetch --quiet origin "$BRANCH" 2>>"$LOGS/start-nodes.log" && FETCHED="branch" || true
  fi
  if [ "$FETCHED" != "branch" ]; then
    log "branch fetch failed — falling back to archive tag $TAGREF"
    if [ -n "$TOKEN" ]; then
      OUT=$(git -C "$REPO" fetch --quiet "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/roshpina.git" "$TAGREF:$TAGREF" 2>&1) \
        && sanitize "$TOKEN" "$OUT" >> "$LOGS/start-nodes.log" && FETCHED="tag"
    else
      git -C "$REPO" fetch --quiet origin "$TAGREF" 2>>"$LOGS/start-nodes.log" && FETCHED="tag" || true
    fi
    if [ "$FETCHED" = "tag" ]; then
      git -C "$REPO" branch -f "$BRANCH" "$TAGREF" 2>>"$LOGS/start-nodes.log" && log "local branch rebuilt from archive tag"
    fi
  fi
  if ! git -C "$REPO" checkout --quiet "$BRANCH" 2>>"$LOGS/start-nodes.log"; then
    log "checkout $BRANCH failed — aborting (fail-closed)"; exit 1
  fi
  log "now on $BRANCH"
fi

# ── 3) vault unseal FIRST (autonomous intelligence recovery) ────────────────
# Reordered 2026-10-21 from measured rebirth evidence: unseal is a fast local
# decrypt while state restore (tar) is heavy — AI capability must exist before
# the slow restore so post-restore AI tasks never wait on it. Boot-race with
# schedule catch-up is separately fixed by BOOT_CATCHUP_SEC=150 in index.ts.
CP_DIR="/home/z/my-project"
if [ -f "$CP_DIR/vault-sealed/nim-api.env.enc" ] && [ ! -f "$RUNNER_DIR/data/vault/nim-api.env" ]; then
  log "runtime vault missing but sealed blob present — unsealing (autonomous)"
  if [ -s "$CP_DIR/upload/vault.passphrase" ]; then
    (cd "$RUNNER_DIR" && bash scripts/vault-unseal.sh nim-api.env >>"$LOGS/start-nodes.log" 2>&1) \
      && log "vault unsealed — AI capability restored" \
      || log "vault unseal FAILED — AI presets stay fail-closed (honest)"
  else
    log "vault passphrase absent — AI capability stays sealed (fail-closed; operator holds it)"
  fi
fi

# ── 4) state restore (only when BOTH money dirs are empty) ───────────────────
LEDGER_HAS=$([ -d "$REPO/data/ledger-net" ] && [ -n "$(ls -A "$REPO/data/ledger-net" 2>/dev/null)" ] && echo yes || echo no)
MARKET_HAS=$([ -d "$REPO/data/market-net" ] && [ -n "$(ls -A "$REPO/data/market-net" 2>/dev/null)" ] && echo yes || echo no)
if [ "$LEDGER_HAS" = no ] && [ "$MARKET_HAS" = no ]; then
  LATEST=$(ls -1t "$SNAP_DIR"/state-*.tar.gz 2>/dev/null | head -n1 || true)
  if [ -n "${LATEST:-}" ]; then
    log "money state empty — restoring latest snapshot: $(basename "$LATEST")"
    mkdir -p "$REPO/data"
    if tar -xzf "$LATEST" -C "$REPO" 2>>"$LOGS/start-nodes.log"; then
      log "state restored from snapshot"
    else
      log "snapshot restore failed — continuing with fresh genesis (honest boot)"
    fi
  else
    log "money state empty and no snapshot yet — booting fresh genesis"
  fi
fi

# ── 5) dev keys ensure (local-only, gitignored — per operator's approved pattern) ──
if [ ! -f "$KEYS/operator.pub.pem" ]; then
  log "dev keys missing — provisioning fresh local dev keys (gitignored; no vaults, no PAT)"
  (cd "$RUNNER_DIR" && bun scripts/provision-keys.ts >>"$LOGS/start-nodes.log" 2>&1) || log "provision-keys failed — nodes will boot bare (fail-closed)"
fi

# ── 6) boot only what's down ─────────────────────────────────────────────────
if up http://127.0.0.1:3032/health; then
  echo "  ledger  :3032  already up — no-op"
else
  if [ -f "$KEYS/operator.pub.pem" ]; then
    # settlement layer: ledger gets the operator PUBLIC key (dev key, local disk, gitignored)
    # setsid = new session: the daemon can NEVER become a waited-on child of
    # this script (live bug 2026-10-18: bash kept the nohup'd bun as a direct
    # child, the script blocked in do_wait forever while HOLDING the singleton
    # lock — every future self-heal no-op'd behind a dead market for an hour).
    (cd "$REPO" && setsid --fork nohup env ROSHPINA_PORT=3032 ROSHPINA_DATA_DIR=./data/ledger-net \
      ROSHPINA_OPERATOR_PUBLIC_KEY_1="$(cat "$KEYS/operator.pub.pem")" \
      bun serve.ts >> "$LOGS/ledger.log" 2>&1 < /dev/null 9>&- &)
    echo "  ledger  :3032  starting WITH operator public key (settlement enabled; log: logs/ledger.log)"
  else
    (cd "$REPO" && setsid --fork nohup env ROSHPINA_PORT=3032 ROSHPINA_DATA_DIR=./data/ledger-net bun serve.ts >> "$LOGS/ledger.log" 2>&1 < /dev/null 9>&- &)
    echo "  ledger  :3032  starting bare (no operator key — POST fail-closed by design)"
  fi
fi

if up http://127.0.0.1:3033/health; then
  echo "  market  :3033  already up — no-op"
else
  if [ -f "$KEYS/operator.pub.pem" ]; then
    # live economy: the node gets PUBLIC keys only (dev keys, local disk, gitignored)
    (cd "$REPO" && setsid --fork env ROSHPINA_PORT=3033 ROSHPINA_DATA_DIR=./data/market-net \
      ROSHPINA_OPERATOR_PUBLIC_KEY_1="$(cat "$KEYS/operator.pub.pem")" \
      ROSHPINA_AGENT_KEY_ALPHA="$(cat "$KEYS/alpha.pub.pem")" \
      ROSHPINA_AGENT_KEY_BRAVO="$(cat "$KEYS/bravo.pub.pem")" \
      ROSHPINA_AGENT_KEY_GAMMA="$(cat "$KEYS/gamma.pub.pem")" \
      ROSHPINA_AGENT_KEY_DELTA="$(cat "$KEYS/delta.pub.pem")" \
      ROSHPINA_ORACLE_PATH="$RUNNER_DIR/data/oracle/anchors.jsonl" \
      nohup bun market-serve.ts >> "$LOGS/market.log" 2>&1 < /dev/null 9>&- &)
    echo "  market  :3033  starting WITH operator+agent public keys (log: logs/market.log)"
  else
    (cd "$REPO" && setsid --fork nohup env ROSHPINA_PORT=3033 ROSHPINA_DATA_DIR=./data/market-net \
      ROSHPINA_ORACLE_PATH="$RUNNER_DIR/data/oracle/anchors.jsonl" \
      bun market-serve.ts >> "$LOGS/market.log" 2>&1 < /dev/null 9>&- &)
    echo "  market  :3033  starting bare (no keys found — POST stays fail-closed; provision-keys.ts will run on next heal)"
  fi
fi

sleep 2
LEDGER=DOWN; MARKET=DOWN
up http://127.0.0.1:3032/health && LEDGER=UP
up http://127.0.0.1:3033/health && MARKET=UP
echo "result: ledger=$LEDGER market=$MARKET"
# release the singleton lock explicitly: even if THIS bash somehow lingers
# (do_wait regression), it must never again gate future self-heals.
exec 9>&-
[ "$LEDGER" = "UP" ] && [ "$MARKET" = "UP" ]
