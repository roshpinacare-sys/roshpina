# Fee Engine — Revival (T-58, 2026-10-11)

Owner law: **release-not-archive** · one unit · *everything uses everything*.
This repo was revival-queued in `FLEET-GRAPH.json` (edge `roshpina → economics`).
The T-58 wave ARMS the fee engine. Nothing here is faked: the status
vocabulary is `armed`, not `live` — no runtime is serving yet.

## What exists (measured, not claimed)

- **Kernel: 114 TypeScript files across 17 domains** — escrow, ledger,
  ledger-orchestrator, marketplace (+cost-arbitrage), orchestrator, policy,
  risk, passport, track-record, transparency-log, settlement-rails,
  agent-identity, potential, rbac, mcp-server, adapter, common.
- **12 API routes** — health, audit, bridge/saos, escrow(+action),
  ledger(accounts/mint/transfer), marketplace, passports(+verify), potential.
- **11 UI panels** + KPI row — the value platform's full cockpit.
- `kernel-smoke.ts` selftest at the repo root (`bun run kernel-smoke`).

## What T-58 changed (additive only)

1. **Lane claimed** in FleetHQ `GOVERNANCE/write-log.jsonl` (commit `9618fd3`,
   law #2 — write-log before work).
2. **`fee-engine/state.json`** — the snapshot lane, first artifact: measured
   inventory + flow connection + honest `armed` status. Publish doctrine
   mirrors saos-dex `dex/pnl-desk.json` (engine state lands as JSON; the
   fleet renders it; no dedicated server needed for the snapshot lane).
3. **Flow connection recorded** — the engine feeds the economics node
   (value chain step 3), consumes the D-023 escrow decision (N2).

## What flips armed → live (one decision, no new code)

Hosting the kernel: the local sovereign engine (`:3044`, zero Actions
minutes) or an external runner. `bun run kernel-smoke` green on that runner
= live. Then the first fee lane wires ledger/mint + marketplace/
cost-arbitrage to the D-023 escrow the owner approves (N2).

## Why this repo was queued (measured history)

Billing-wall silence (private repo, Actions minutes cut ~09-20) plus the
2026-09-12 stall — already documented honestly in the repo README role
declaration. The role declaration and the broadcast archive are untouched
by this revival (additive-first law).
