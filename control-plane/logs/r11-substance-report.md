# R11 Substance Close-Out — agent-4, Task 28 (2026-10-19)

**Verdict: the R11 key material is DEAD on chain — zero roles live. The only remaining
value under the exposed root is 1.505648 USDC (SPL) + dust. R11 is materially closed;
three owner decisions remain (below).**

## 1. Timeline (measured from origin, GitHub API with operator PAT)

| When (UTC) | Event |
|---|---|
| 2026-09-12 20:27–20:29 | R11 generation pushed create-only to 8 partner repos (owner instruction "תדאג שגם לדקס יהיה גישה... אין לי סבלנות לשלוח אחד אחד לכולם") |
| **window: ~4h49m** | archive + its passphrase sat at `agent/vault/` — **saos-dex was PUBLIC during this window** |
| 2026-09-13 01:17 | Another agent (responding to its own CRITICAL-R11-KEY-BROADCAST) deleted all three files from all 8 repos' mains |
| 2026-10-19 (this audit) | Substance audit: archive recovered from git history hermetically, sha256-verified 14/14 against inner MANIFEST, live-key verification run |

## 2. Archive contents (from KEYS-ACCESS-README-HE.md, history)

Two root mnemonics (SOVEREIGN ROOT + identity root), 120 HD addresses
(EVM×7 nets + TRON + SOL + BTC), 12 STEEM/HIVE accounts with owner/active/posting/memo
WIFs, key-broker token, owner password doc. **The GitHub PAT was NOT in the archive**
(sealed separately 2026-10-08, R284-b).

## 3. Live-key verification (read-only, zero broadcast, zero secret printing)

Tool: `mini-services/fleet-runner/scripts/r11-live-key-audit.py` (pure-python secp256k1;
WIF→pubkey derived in-memory only). Evidence: `logs/r11-live-key-report.json`.

| Key class | Check | Result |
|---|---|---|
| STEEM/HIVE WIFs (12 accounts × 4 roles × 2 chains) | derived pubkey vs CURRENT on-chain authorities | **0 / 96 STILL-LIVE — all rotated** (ynet 2026-09-04; headcorner MASTER-DERIVE 2026-10-12 tx f6283d2e; soldiers rotated by the steem lane) |
| EVM native (12 addr × 7 nets) | eth_getBalance | dust only: cashmachine 367,435,513,080 **wei** = 0.000000367 ETH (~$0.0014) |
| TRON native + TRC20 (12 addr) | trongrid | 0.193 TRX dust (headcorner); TRC20 **NONE** 12/12 |
| SPL / Solana (12 addr) | getTokenAccountsByOwner | **cashmachine: 1.505648 USDC** (mint EPjFWdd5…, ≈$1.51) |
| BTC (12 addr) | blockchain.info addressbalance | **0 / 12** |
| key-broker token (:3040 gateway) | estate service search | gateway does not exist in the current estate — token treated as burned |

## 4. Honest process note — the unit-error the guard caught

Initial read of `0x558cdcfcf8` was mis-scaled as "0.3674 ETH (~$1.4k at risk)".
The protective-sweep tool (`r11-evm-sweep.ts`) — built fail-closed with a test-tx-first
design — measured the REAL balance (0.000000367 ETH) on the live run and **refused to
broadcast** (insufficient-balance abort). No transaction was ever sent; the two stray
sealed keys from dry/real runs were deleted and their vault-manifest entries removed
(no funds were ever associated). **The fail-closed guard corrected my own error before
any on-chain action — that is the system working as designed.**

## 5. Owner decisions remaining (all measured, none urgent)

1. **1.505648 USDC on the exposed key** (cashmachine SOL address): un-sweepable from the
   estate (0 native SOL for gas ≈ 0.002 SOL needed). Fund-and-sweep, or accept as residual.
2. **Git history purge** of the archive across 8 repos (incl. public saos-dex): destructive
   force-push, fleet-wide coordination required. Material risk is LOW since all keys inside
   are dead/rotated; the mnemonic root itself remains technically public but controls only
   dust + the USDC above.
3. **Mnemonic re-rooting** (new root for the HD tree) at leisure — zero on-chain value
   under the old root beyond the USDC; no urgency.

## 6. What was already closed by other agents (verified this session)

- R11 files removed from all 8 repos' mains within ~5h (2026-09-13) — measured commits.
- headcorner STEEM keys rotated on-chain with tx proof (2026-10-12).
- Vault passes moved out of repos into Actions secrets (R-VAULTPASS-1, 2026-10-10).
- CRITICAL-R11-KEY-BROADCAST.md canonicalized (anchor-baseline).
