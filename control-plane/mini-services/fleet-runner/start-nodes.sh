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

# ── 7) giant ensure (canonical trunk — added after the 5th wipe, 2026-10-27) ──
# The architect chain's CODE and the fleet's canonical copy live here; every
# reset kills /home/z/repos clones that are not roshpina/domain. Clone shallow
# (depth 20 — enough to land receipts on top of main without full history).
GIANT="/home/z/repos/giant"
if [ ! -d "$GIANT/.git" ]; then
  log "giant missing — cloning (shallow) from GitHub"
  TOKEN=""
  [ -f "$TOKEN_FILE" ] && TOKEN=$(grep -oE '(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+' "$TOKEN_FILE" | head -n1)
  if [ -z "$TOKEN" ]; then
    log "no usable token — giant stays missing (fail-closed; architect §8 will skip honestly)"
  else
    mkdir -p "$(dirname "$GIANT")"
    OUT=$(git clone --depth 20 --single-branch --branch main --quiet \
      "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/giant.git" "$GIANT" 2>&1)
    RC=$?
    [ -n "$OUT" ] && sanitize "$TOKEN" "$OUT" >> "$LOGS/start-nodes.log"
    if [ $RC -eq 0 ]; then
      git -C "$GIANT" remote set-url origin "https://github.com/roshpinacare-sys/giant.git"
      log "giant cloned OK (clean remote URL, token not stored)"
    else
      log "giant clone failed (rc=$RC) — honest gap, architect chain stays down"
    fi
  fi
fi

# ── 8) architect chain (daemon :3051 + supervisor :3047) ─────────────────────
# Code canonically lives in giant mini-services; the live copies are the local
# mini-services (the reset slimmed them away). Copy-if-missing, boot-if-down —
# same launch discipline as §6 (setsid --fork, no inherited lock fd, logs).
ARCH_SRC="$GIANT/mini-services"
ARCH_LIVE="/home/z/my-project/mini-services"
ARCH_UP=no
if [ -d "$ARCH_SRC/saos-architect-daemon" ] && [ -f "$ARCH_SRC/saos-architect-daemon/index.ts" ]; then
  for d in lib saos-architect-daemon saos-architect-supervisor; do
    if [ ! -f "$ARCH_LIVE/$d/index.ts" ] && [ ! -f "$ARCH_LIVE/$d/vault-auth.ts" ]; then
      if [ -d "$ARCH_SRC/$d" ]; then
        cp -r "$ARCH_SRC/$d" "$ARCH_LIVE/$d" && log "architect component restored: $d"
      fi
    fi
  done
  if ! up http://127.0.0.1:3051/health; then
    if [ -f "$ARCH_LIVE/saos-architect-daemon/index.ts" ]; then
      (cd "$ARCH_LIVE/saos-architect-daemon" && setsid --fork nohup bun --hot index.ts \
        >> /tmp/saos-architect-daemon.log 2>&1 < /dev/null 9>&- &)
      echo "  architect-daemon :3051 starting (log: /tmp/saos-architect-daemon.log)"
    fi
  else
    echo "  architect-daemon :3051 already up — no-op"
  fi
  if ! up http://127.0.0.1:3047/health; then
    if [ -f "$ARCH_LIVE/saos-architect-supervisor/index.ts" ]; then
      (cd "$ARCH_LIVE/saos-architect-supervisor" && setsid --fork nohup bun --hot index.ts \
        >> /tmp/saos-architect-supervisor.log 2>&1 < /dev/null 9>&- &)
      echo "  architect-supervisor :3047 starting (log: /tmp/saos-architect-supervisor.log)"
    fi
  else
    echo "  architect-supervisor :3047 already up — no-op"
  fi
  sleep 3
  up http://127.0.0.1:3051/health && up http://127.0.0.1:3047/health && ARCH_UP=yes
  echo "result: architect=$ARCH_UP"
else
  echo "  architect chain skipped — giant code absent (honest; §7 clone failed or was refused)"
fi

# ── 9) pages-root ensure (the PUBLIC root-site surface, roshpinacare-sys.github.io) ──
# execution-ledger-renew publishes the execution ledger here; without the clone
# it degrades to root-clone-absent (measured gap of the 4th/5th resets).
PAGES_ROOT="/home/z/repos/pages-root"
if [ ! -d "$PAGES_ROOT/.git" ]; then
  log "pages-root missing — cloning (shallow) from GitHub"
  TOKEN=""
  [ -f "$TOKEN_FILE" ] && TOKEN=$(grep -oE '(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+' "$TOKEN_FILE" | head -n1)
  if [ -z "$TOKEN" ]; then
    log "no usable token — pages-root stays missing (fail-closed; renew reports root-clone-absent honestly)"
  else
    OUT=$(git clone --depth 5 --single-branch --quiet \
      "https://x-access-token:${TOKEN}@github.com/roshpinacare-sys/roshpinacare-sys.github.io.git" "$PAGES_ROOT" 2>&1)
    RC=$?
    [ -n "$OUT" ] && sanitize "$TOKEN" "$OUT" >> "$LOGS/start-nodes.log"
    if [ $RC -eq 0 ]; then
      git -C "$PAGES_ROOT" remote set-url origin "https://github.com/roshpinacare-sys/roshpinacare-sys.github.io.git"
      log "pages-root cloned OK (clean remote URL, token not stored)"
    else
      log "pages-root clone failed (rc=$RC) — honest gap"
    fi
  fi
fi

# ── 10) fixedfloat vault seal (the 4th reset killed it; unseal law like §3) ──
if [ ! -s "$RUNNER_DIR/data/vault/fixedfloat.env" ] && [ -s /home/z/my-project/upload/fffixedflot.txt ]; then
  (cd "$RUNNER_DIR" && bun scripts/fixedfloat-seal.ts >>"$LOGS/start-nodes.log" 2>&1) \
    && log "fixedfloat vault sealed from operator paste" \
    || log "fixedfloat seal FAILED — quote lane stays fail-closed (honest)"
fi

# ── 11) runner cure ensure (the golden-copy law, 5th-wipe lesson) ────────────
# The reset restores OLD my-project snapshots — the money-path cures (fuel
# decimal law, era-lost key ensure/re-license, saos-0004 in CORE) died with
# wipe #5, and the OLD preset catalog then BURNED the schedules whose presets
# it forgot (index.ts loadSchedules law: unknown preset → schedule dropped).
# upload/golden/ survives every reset; restore the live copies whenever the
# cure markers are missing. No-op when already cured.
ER_SCRIPT="$RUNNER_DIR/scripts/economy-run.ts"
ER_GOLDEN="/home/z/my-project/upload/golden/economy-run.ts"
if [ -f "$ER_SCRIPT" ] && [ -f "$ER_GOLDEN" ]; then
  if ! grep -q "usdsDec" "$ER_SCRIPT" || ! grep -q "ensureKeys(a)" "$ER_SCRIPT" || ! grep -q '"saos-0004"\] as const' "$ER_SCRIPT"; then
    log "economy-run lost the money-path cures (wipe class) — restoring from golden copy"
    cp "$ER_GOLDEN" "$ER_SCRIPT" && log "economy-run cured from golden (fuel decimal + key ensure/re-license + saos-0004 core)"
  else
    log "economy-run cure markers present — no-op"
  fi
  # keep the golden current when the live copy is NEWER (a lane legitimately
  # evolved the script): sync by mtime, never overwrite a newer golden.
  if [ "$ER_SCRIPT" -nt "$ER_GOLDEN" ] && grep -q "usdsDec" "$ER_SCRIPT" && grep -q "ensureKeys(a)" "$ER_SCRIPT"; then
    cp "$ER_SCRIPT" "$ER_GOLDEN" && log "golden copy refreshed from live (live was newer and cured)"
  fi
fi
# preset catalog: the burn-law eats schedules when the catalog forgets them
IR_INDEX="$RUNNER_DIR/index.ts"
IR_GOLDEN="/home/z/my-project/upload/golden/index.ts"
if [ -f "$IR_INDEX" ] && [ -f "$IR_GOLDEN" ]; then
  if ! grep -q '"execution-ledger-renew"' "$IR_INDEX" || ! grep -q '"fixedfloat-quote"' "$IR_INDEX"; then
    log "preset catalog lost the directive-42/54 presets — restoring from golden copy"
    cp "$IR_GOLDEN" "$IR_INDEX" && log "preset catalog cured from golden (execution-ledger-renew + fixedfloat-quote live again)"
  else
    log "preset catalog cure markers present — no-op"
  fi
fi
# start-nodes itself: the healer must survive the wipe that kills its cures
SN_GOLDEN="/home/z/my-project/upload/golden/start-nodes.sh"
if [ -f "$SN_GOLDEN" ] && ! grep -q "golden-copy law" "$RUNNER_DIR/start-nodes.sh" 2>/dev/null; then
  cp "$SN_GOLDEN" "$RUNNER_DIR/start-nodes.sh" && log "start-nodes restored from golden (§7-11 heal sections were wiped)"
fi

# release the singleton lock explicitly: even if THIS bash somehow lingers
# (do_wait regression), it must never again gate future self-heals.
exec 9>&-
[ "$LEDGER" = "UP" ] && [ "$MARKET" = "UP" ]
