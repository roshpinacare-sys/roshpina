# saos-architect-daemon — Chief Sovereign Architect (giant trunk executive)

The unified always-on executive demanded by the owner's MASTER DIRECTIVE (§1 + §4,
trace 1a16ecab0c7c5bad): continuous AUDIT → deterministic SELECT → CURE → VERIFY →
LAND → RECEIPT on the giant trunk, with zero human intervention.

## What it does (measured, wave 19.84)

First session of live executive authority — 5 autonomous landed cycles, trunk tsc:

| cycle | cure | effect | commit |
|---|---|---|---|
| 1 | trunk-unit-boundary | tsc 594→4 (adopted tsconfig exclude restored) | 4d5b69be |
| 2 | buntest-file-reference (empire-registry.test.ts) | 6→3 | 3f941764 |
| 3 | capital-liquidity-band (COMPOUND: union + LIQ_HE label) | 3→2 — issue-contract #5 cured | aace9868 |
| 4 | swallow-guard-cli-readonly | 2→1 | 122083f7 |
| 5 | steem-feed-nullable-truth (COMPOUND adopted-truth restore ×4 files) | 1→**0** | 18b50727 |

Honest refusals recorded en route (the verify gate doing its job):
- capital cure v1 aborted 3→3 (exposed downstream exhaustive Record) → cure upgraded to compound
- steem-feed cure v1 aborted 2→11 (exposed 8 un-armed callers — the wipe class had rewound
  the whole adopted set) → cure upgraded to compound per agent-9's adopted receipts

## Laws encoded

- **TDD red-first**: 18 tests / 45 expect() written before the modules they test.
- **Fail-closed verify**: after every cure, full `tsc --noEmit -p .` must strictly
  DECREASE error count; else byte-identical revert + receipt `aborted`.
- **Anchored, idempotent cures**: every edit requires its anchor text; drift → refuse
  (never blind edit). Already-cured → silent no-op.
- **Adopted-truth antibody**: cures re-apply prior waves' landed receipts (agent-9
  wave 19.82 signature truth, unit-boundary exclusion) — the antibody against the
  ours-merge wipe class.
- **Single-flight**: O_EXCL lock, stale (>30min) broken honestly and recorded.
- **Hash-chained receipts**: state/receipts.jsonl {seq, prevHash, hash=sha256(prev+canonicalJSON)}
  — tamper-evident, splice/reorder-detecting (verifyReceipts).
- **Git discipline**: adds ONLY the cure's declared files (never `git add -A`),
  conventional commit, fetch→rebase(autoStash)→push loop ≤3, ls-remote identity proof,
  never force-push.
- **Honest idle**: no curable contract → verdict `no-work` (0→0), never fabricated work.

## Interfaces

- `GET :3051/health` — liveness + last verdict
- `GET :3051/status` — full receipts chain state (head hash, verified flag, last cycle)
- `POST :3051/cycle` — one bounded executive cycle (single-flight, 409 if busy)
- `bun index.ts --once` — single provable cycle, exit code = honesty
- beat loop: `ARCHITECT_BEAT_MS` (default 30min, floor 30s)

Runtime state lives in `state/` (git-ignored — never enters history).
