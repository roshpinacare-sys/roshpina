# roshpina — sovereign trust & value console

**ROLE (declared 2026-10-11, task 10-c un-silence sweep):** the **sovereign
trust & value console (kernel estate)** — a real zero-dep kernel (BigInt µ¢
ledger, Ed25519 passports, 5% escrow engine, transparency log) with a
simulated world, honestly labeled. Never deployed, never autonomous — and
honest about it. Why it was muted: never had a runtime lane + the org
billing wall. Revival path: deploy the Next.js console (any Node host),
wire `bridge/saos` from the pointer-file seam to a live reader, and point
`controls-audit.yml` (dispatch-only, valid YAML) at a real G6 audit —
the kernel itself needs no code work.

RTL Next.js 16 console over a deterministic in-memory economic kernel
("TFA Sovereign Trust-as-a-Service"): double-entry ledger (BigInt µ¢),
hash-linked signed audit chain, Ed25519 action passports, escrow with a 5%
coordination fee, Merkle transparency log, and a potential engine that routes
strengths to opportunities.

## Truth note (read this before trusting any number on screen)

The kernel world — opening balances, clients, workers and the escrow cycles
you see in the UI — is **seeded synthetically at boot** (`src/lib/seed.ts`,
labelled `עולם-זריעה (sim)` in the header since Task 11-e). The ledger,
audit chain and passports are real, verifiable machinery; the balances shown
are a demo world, not outside activity. `/api/health` reports
`seeded: true` and the audit-chain integrity verdict.

## Layout

- `src/app/` — Next.js App Router: console page + API routes
  (`api/health`, `api/ledger/*`, `api/escrow/*`, `api/passports/*`,
  `api/marketplace`, `api/audit`, `api/potential`, `api/bridge/saos`).
- `kernel/` — the zero-dependency kernel modules (ledger, orchestrator,
  escrow, passport, policy, risk, marketplace, transparency-log…).
- `src/lib/kernel.ts` — the singleton assembling the kernel (survives HMR
  via `Symbol.for`).
- `kernel-smoke.ts` — deterministic kernel smoke test (`bun run kernel-smoke`).
- `PATCH-SPEC-P10.md` — the P10 patch spec the console was built against.

## Commands

```bash
bun install
bun run dev          # next dev on :3100 (writes dev.log)
bun run build        # production build
bun run kernel-smoke # kernel deterministic smoke test
```
