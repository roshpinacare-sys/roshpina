/**
 * desk-tuner-probe.ts — GOLDEN probe for the D1 strategy-tuner (four-gate law).
 *
 * Boots a REAL market node (market-serve.ts) with ROSHPINA_DESK=on and a
 * compressed tune window (ROSHPINA_DESK_TUNE_MIN_MS), then drives REAL regime
 * changes by rewriting the oracle fixture file — the same primary-evidence
 * file the live desk reads. Every assertion is measured from the live node.
 *
 *   T1  boot in active regime → tuner holds genesis (1500/3000), no tune event
 *   T2  calm fixture → tune event journaled WITH a complete four-gate record;
 *       live grid cfg tightens to 1200/2400 (genesis ×0.8)
 *   T3  wild fixture → dampener: step/spread move ≤25% per window (1500/3000),
 *       never the full ×1.5 jump — adverse-selection protection, bounded
 *   T4  active again → auto-revert by construction (target == genesis)
 *   T5  stale oracle → halt → tuner frozen: no mutation across windows
 *   T6  after all tuning: grid still two-sided, conservation holds
 *
 * Pure-function gates (no node — paths that cannot be honestly driven live):
 *   P1  kill floor: pnl < −10% seed → kill-revert to genesis + cooldown;
 *       inside cooldown every call is "cooldown" (no mutation)
 *   P2  rate limit: second call inside the window is "rate-limited"
 *   P3  halt (pure) → frozen
 *   P4  hard bounds: genesis clamps into [750,6000]×[1500,12000]; wild from a
 *       maxed genesis stays maxed ("none")
 *   P5  four-gate record completeness on every "tune"
 *   P6  determinism: identical input sequences → identical outcomes
 *
 * Run: bun desk-tuner-probe.ts
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateAgent } from "./kernel/fleet/sovereign-agents";
import type { AgentKeys } from "./kernel/fleet/sovereign-agents";
import { newTunerState, tuneGridDesk } from "./kernel/market/desk-tuner";

const PORT = 3080;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── oracle fixture: controlled per-read volatility (same shape as the real anchors file) ──
function writeOracleFixture(path: string, newestAtMs: number, mode: "calm" | "active" | "wild" | "stale"): void {
  const lines: string[] = [];
  const nets: [string, string, number][] = [["BTC", "BTCUSD", 81000], ["ETH", "ETHUSD", 2400], ["SOL", "SOLUSD", 105]];
  const frac = mode === "calm" ? 0.0 : mode === "active" ? 0.009 : mode === "wild" ? 0.03 : 0.0;
  const batches = mode === "stale" ? 2 : 7;
  const spacing = 900_000;
  // stale: the NEWEST batch is already 50min old → ageMin > 45 → halt (age, not vol)
  const newestShiftMs = mode === "stale" ? 50 * 60_000 : 0;
  for (let i = batches - 1; i >= 0; i--) {
    const atMs = newestAtMs - i * spacing - newestShiftMs;
    const at = new Date(atMs).toISOString();
    const drift = i * frac;
    for (const [net, pair, base] of nets) {
      const v = base * (1 + drift);
      lines.push(JSON.stringify({
        at, source: "kraken", network: net, pair,
        bid: (v - v * 0.00001).toFixed(5), ask: (v + v * 0.00001).toFixed(5),
        last: v.toFixed(5), volume24h: "1000",
        rawSha256: "0".repeat(64),
      }));
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

interface DeskState {
  enabled: boolean;
  oracle: { ageMin: number | null; source: string | null; networks: number; volPct: number | null };
  regime: { mode: string; reason: string };
  book: { bestBid: string | null; bestAsk: string | null; spreadU: string | null };
  desks: { agentId: string; kind: string; stepU: string; maxSpreadU: string; ownOrders: number; haltedReason: string | null }[];
}
const deskState = async (): Promise<DeskState> => (await (await fetch(`${BASE}/desk/state`)).json()) as unknown as DeskState;
const book = async (): Promise<{ bids: { price: string; agentId: string }[]; asks: { price: string; agentId: string }[] }> =>
  (await (await fetch(`${BASE}/market/book`)).json()) as unknown as { bids: { price: string; agentId: string }[]; asks: { price: string; agentId: string }[] };
const conservation = async (): Promise<{ quote: { holds: boolean }; base: { holds: boolean } }> => {
  const r = (await (await fetch(`${BASE}/economy/report`)).json()) as unknown as { conservation: { quote: { holds: boolean }; base: { holds: boolean } } };
  return r.conservation;
};
const gridOf = (s: DeskState): { stepU: bigint; maxSpreadU: bigint } | null => {
  const g = s.desks.find((d) => d.kind === "grid");
  return g ? { stepU: BigInt(g.stepU), maxSpreadU: BigInt(g.maxSpreadU) } : null;
};
const journalRecords = (dataDir: string): Record<string, unknown>[] => {
  const p = join(dataDir, "desk-journal.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
};

const waitHealthy = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("market node did not become healthy");
};

// ─── live-node phase ───────────────────────────────────────────────────────────
const operator = generateAgent("operator-probe");
const traders = [generateAgent("trader-probe-1"), generateAgent("trader-probe-2")];
const dataDir = mkdtempSync(join(tmpdir(), "desk-tuner-probe-"));
const oraclePath = join(dataDir, "anchors.jsonl");
writeOracleFixture(oraclePath, Date.now(), "active");

const overrides: Record<string, string> = {
  ROSHPINA_PORT: String(PORT),
  ROSHPINA_DATA_DIR: dataDir,
  ROSHPINA_OPERATOR_PUBLIC_KEY_1: operator.publicPem,
  ROSHPINA_DESK: "on",
  ROSHPINA_DESK_TICK_MS: "700",
  ROSHPINA_DESK_TUNE_MIN_MS: "500", // compressed window — the LIVE default is 15min
  ROSHPINA_DESK_GRID_STEP_U: "1500",
  ROSHPINA_DESK_ORACLE_MAX_SPREAD_U: "4000",
  ROSHPINA_ORACLE_PATH: oraclePath,
};
for (const a of traders) overrides[`ROSHPINA_AGENT_KEY_${a.agentId.toUpperCase()}`] = a.publicPem;
const node = Bun.spawn(["bun", "market-serve.ts"], { env: { ...process.env, ...overrides }, stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });

try {
  await waitHealthy();
  await sleep(2500);

  // T1 — active regime: genesis held, no tune event
  let s = await deskState();
  let g = gridOf(s);
  check("T1 active boot: genesis held", s.regime.mode === "active" && g?.stepU === 1500n && g?.maxSpreadU === 3000n,
    `regime=${s.regime.mode} step=${g?.stepU} spread=${g?.maxSpreadU}`);
  const tunes1 = journalRecords(dataDir).filter((r) => r.kind === "tune" || r.kind === "kill-revert");
  check("T1 no tune events at genesis", tunes1.length === 0, `tuneRecords=${tunes1.length}`);

  // T2 — calm: tighten to ×0.8 with a complete four-gate record
  writeOracleFixture(oraclePath, Date.now(), "calm");
  await sleep(3000);
  s = await deskState(); g = gridOf(s);
  check("T2 calm → tighten to 1200/2400", s.regime.mode === "calm" && g?.stepU === 1200n && g?.maxSpreadU === 2400n,
    `regime=${s.regime.mode} step=${g?.stepU} spread=${g?.maxSpreadU}`);
  const tuneRecs = journalRecords(dataDir).filter((r) => r.kind === "tune") as { fourGate?: Record<string, string>; stepU?: string; maxSpreadU?: string }[];
  const fg = tuneRecs[tuneRecs.length - 1]?.fourGate;
  check("T2 tune journaled with four-gate record",
    tuneRecs.length >= 1 && !!fg && typeof fg.thesis === "string" && fg.thesis.length > 0 &&
    typeof fg.quant === "string" && fg.quant.length > 0 && typeof fg.risk === "string" && fg.risk.length > 0 &&
    typeof fg.execution === "string" && fg.execution.length > 0,
    `tuneRecords=${tuneRecs.length} fourGate=${fg ? "complete" : "MISSING"}`);

  // T3 — wild: dampener walks ≤25% per window, converging to ×1.5 target (2250/4500)
  writeOracleFixture(oraclePath, Date.now(), "wild");
  await sleep(3200);
  s = await deskState(); g = gridOf(s);
  check("T3 wild → converged to 2250/4500 via bounded steps", g?.stepU === 2250n && g?.maxSpreadU === 4500n,
    `regime=${s.regime.mode} step=${g?.stepU} spread=${g?.maxSpreadU}`);

  // T4 — active: auto-revert by construction (target == genesis; dampened down)
  writeOracleFixture(oraclePath, Date.now(), "active");
  await sleep(3200);
  s = await deskState(); g = gridOf(s);
  check("T4 active → genesis restored", s.regime.mode === "active" && g?.stepU === 1500n && g?.maxSpreadU === 3000n,
    `regime=${s.regime.mode} step=${g?.stepU} spread=${g?.maxSpreadU}`);

  // T5 — stale oracle: halt → tuner frozen across windows (zero new tune events)
  const tuneCountBeforeHalt = journalRecords(dataDir).filter((r) => r.kind === "tune").length;
  writeOracleFixture(oraclePath, Date.now(), "stale");
  await sleep(3500);
  s = await deskState(); g = gridOf(s);
  const tuneCountAfterHalt = journalRecords(dataDir).filter((r) => r.kind === "tune").length;
  check("T5 halt → frozen (no mutation, no tune events)", s.regime.mode === "halt" && g?.stepU === 1500n && g?.maxSpreadU === 3000n && tuneCountAfterHalt === tuneCountBeforeHalt,
    `regime=${s.regime.mode} step=${g?.stepU} spread=${g?.maxSpreadU} tuneEvents=${tuneCountBeforeHalt}→${tuneCountAfterHalt}`);

  // T6 — the desk survived all tuning: two-sided quoting + conservation
  const bk = await book();
  const mmBids = bk.bids.filter((o) => o.agentId === "mm-grid").length;
  const mmAsks = bk.asks.filter((o) => o.agentId === "mm-grid").length;
  const cons = await conservation();
  check("T6 grid still two-sided after tuning", mmBids > 0 && mmAsks > 0, `bids=${mmBids} asks=${mmAsks}`);
  check("T6 conservation holds after tuning", cons.quote.holds && cons.base.holds, `quote=${cons.quote.holds} base=${cons.base.holds}`);
} finally {
  try { node.kill("SIGTERM"); } catch { /* already down */ }
}

// ─── pure-function phase (paths that cannot be honestly driven live) ─────────
const NOW = 1_700_000_000_000;
{
  // P1 — kill floor + cooldown
  const st = newTunerState(1500n, 3000n, NOW);
  const seedEquity = 10_000_000n;
  const d1 = tuneGridDesk(st, { mode: "calm", reason: "test" }, { pnlMarkedU: -(seedEquity / 5n), seedEquityU: seedEquity }, NOW, 900_000);
  check("P1 kill floor → kill-revert to genesis", d1.kind === "kill-revert" && d1.stepU === 1500n && d1.maxSpreadU === 3000n,
    `kind=${d1.kind} step=${d1.stepU}`);
  const d2 = tuneGridDesk(st, { mode: "calm", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 1000, 900_000);
  check("P1 inside cooldown → no mutation", d2.kind === "cooldown" && d2.stepU === 1500n, `kind=${d2.kind}`);
  const d2b = tuneGridDesk(st, { mode: "calm", reason: "test" }, { pnlMarkedU: -(seedEquity / 5n), seedEquityU: seedEquity }, NOW + 2000, 900_000);
  check("P1 floor still breached during cooldown → quiet cooldown (no spam)", d2b.kind === "cooldown", `kind=${d2b.kind}`);
  const d2c = tuneGridDesk(st, { mode: "calm", reason: "test" }, { pnlMarkedU: -(seedEquity / 5n), seedEquityU: seedEquity }, NOW + 2 * 60 * 60_000 + 500, 900_000);
  check("P1 expired cooldown + floor still breached → ONE heartbeat kill-revert", d2c.kind === "kill-revert", `kind=${d2c.kind}`);
  const d3 = tuneGridDesk(st, { mode: "active", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 4 * 60 * 60_000 + 1000, 900_000);
  check("P1 cooldown expires → adaptation resumes", d3.kind === "none", `kind=${d3.kind}`);

  // P2 — rate limit
  const st2 = newTunerState(1500n, 3000n, NOW);
  const r1 = tuneGridDesk(st2, { mode: "calm", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000, 900_000);
  const r2 = tuneGridDesk(st2, { mode: "wild", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000 + 1000, 900_000);
  check("P2 first call tunes, second inside window rate-limited", r1.kind === "tune" && r2.kind === "rate-limited", `r1=${r1.kind} r2=${r2.kind}`);

  // P3 — halt freeze (pure)
  const st3 = newTunerState(1500n, 3000n, NOW);
  const h = tuneGridDesk(st3, { mode: "halt", reason: "oracle stale" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000, 500);
  check("P3 halt → frozen", h.kind === "frozen" && h.stepU === 1500n, `kind=${h.kind}`);

  // P4 — hard bounds
  const st4 = newTunerState(100n, 100n, NOW); // absurd genesis → clamped
  check("P4 genesis clamped into hard bounds", st4.stepU === 750n && st4.maxSpreadU === 1500n, `step=${st4.stepU} spread=${st4.maxSpreadU}`);
  const st5 = newTunerState(6000n, 12000n, NOW);
  const w = tuneGridDesk(st5, { mode: "wild", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000, 500);
  check("P4 wild from maxed genesis → none (bounds hold)", w.kind === "none" && w.stepU === 6000n && w.maxSpreadU === 12000n, `kind=${w.kind} step=${w.stepU}`);

  // P5 — four-gate completeness on every tune decision
  const st6 = newTunerState(1500n, 3000n, NOW);
  const t = tuneGridDesk(st6, { mode: "calm", reason: "vol 0.10%/read" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000, 500);
  const f = t.fourGate;
  check("P5 tune carries complete four-gate record",
    t.kind === "tune" && !!f && !!f.thesis && !!f.quant && !!f.risk && !!f.execution,
    `kind=${t.kind} gates=${f ? "complete" : "MISSING"}`);

  // P5b — dampener: single call from 1200 toward wild target 2250 lands at exactly +25% (1500)
  const st7 = newTunerState(1500n, 3000n, NOW);
  st7.stepU = 1200n; st7.maxSpreadU = 2400n; st7.lastMutationAt = NOW; // mid-walk state
  const w7 = tuneGridDesk(st7, { mode: "wild", reason: "test" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, NOW + 10_000_000, 500);
  check("P5b dampener: one window = ≤+25% (1200→1500, 2400→3000)", w7.kind === "tune" && w7.stepU === 1500n && w7.maxSpreadU === 3000n,
    `kind=${w7.kind} step=${w7.stepU} spread=${w7.maxSpreadU}`);

  // P6 — determinism
  const run = (): bigint[] => {
    const s = newTunerState(1500n, 3000n, NOW);
    const seq: bigint[] = [];
    let now2 = NOW;
    for (const mode of ["calm", "wild", "active", "calm"] as const) {
      now2 += 10_000_000;
      const d = tuneGridDesk(s, { mode, reason: "seq" }, { pnlMarkedU: 0n, seedEquityU: seedEquity }, now2, 500);
      seq.push(d.stepU, d.maxSpreadU);
    }
    return seq;
  };
  const a = run(), b = run();
  check("P6 determinism: same inputs → same outcomes", a.length === b.length && a.every((v, i) => v === b[i]), `seq=${a.join(",")}`);
}

console.log(`\n${fail === 0 ? "DESK-TUNER-OK" : "DESK-TUNER-FAILED"} · ${pass} passed · ${fail} failed`);
if (fail === 0) { await sleep(1500); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(fail === 0 ? 0 : 1);
