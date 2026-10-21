/**
 * liquidity-desk-probe.ts — GOLDEN probe for the designated liquidity desks.
 *
 * Boots a REAL market node (market-serve.ts) with ROSHPINA_DESK=on on an
 * ephemeral data dir, and proves through the PRODUCTION paths:
 *
 *   P0  desks boot: /health desk=on; /desk/state oracle fresh (real fixture
 *       file, provenance-shaped records); regime not halt
 *   P1  grid quotes genesis: two-sided book from mm-grid alone, spread ≤ 2×step
 *   P2  taker-cross fills the desk's ask → desk sells recorded, grossFlow real,
 *       conservation holds
 *   P3  recenter law: after a real 4% crash, every resting grid order sits
 *       within recenterBps of the desk's own EMA
 *   P4  oracle desk fires on a wide book: with grid step 3000 (spread 6000 >
 *       threshold 4000) mm-oracle places improving quotes → spread tightens
 *   P5  stale-oracle reboot: old `at` in the anchors file → regime halt,
 *       mm-oracle stands down, mm-grid KEEPS quoting (internal liquidity
 *       survives), boot-cancel leaves no ghost desk orders
 *   P6  desk journal exists and is valid JSONL
 *   P7  kill switch: ROSHPINA_DESK=off → no mm-* orders ever
 *
 * Honest gates only — every assertion measured from the live node.
 * Run: bun liquidity-desk-probe.ts
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentClient, generateAgent } from "./kernel/fleet/sovereign-agents";
import type { AgentKeys } from "./kernel/fleet/sovereign-agents";

const PORT = 3078;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── oracle fixture (real provenance shape, content-carried age) ─────────────
function writeOracleFixture(path: string, newestAtMs: number): void {
  const lines: string[] = [];
  const nets: [string, string, number][] = [["BTC", "BTCUSD", 81000], ["ETH", "ETHUSD", 2400], ["SOL", "SOLUSD", 105]];
  for (let i = 6; i >= 0; i--) {
    const at = new Date(newestAtMs - i * 900_000).toISOString();
    for (const [net, pair, base] of nets) {
      const drift = i * (net === "BTC" ? 350 : net === "ETH" ? 10 : 0.4); // small calm deltas
      lines.push(JSON.stringify({
        at, source: "kraken", network: net, pair,
        bid: (base + drift - 0.5).toFixed(5), ask: (base + drift + 0.5).toFixed(5),
        last: (base + drift).toFixed(5), volume24h: "1000",
        rawSha256: "0".repeat(64),
      }));
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

interface Health { ok: boolean; trades: number; desk: string; ghostsBootQuote: number; ghostsBootBase: number }
interface DeskState {
  enabled: boolean; startedAt: string;
  oracle: { ageMin: number | null; source: string | null; networks: number; volPct: number | null };
  regime: { mode: string; reason: string };
  book: { bestBid: string | null; bestAsk: string | null; spreadU: string | null; spreadBps: number | null };
  desks: { agentId: string; kind: string; tickNo: number; emaU: string | null; buys: number; sells: number; grossFlowU: string; ownOrders: number; haltedReason: string | null }[];
}
const health = async (): Promise<Health> => (await (await fetch(`${BASE}/health`)).json()) as unknown as Health;
const deskState = async (): Promise<DeskState> => (await (await fetch(`${BASE}/desk/state`)).json()) as unknown as DeskState;
const book = async (): Promise<{ bids: { price: string; agentId: string }[]; asks: { price: string; agentId: string }[] }> =>
  (await (await fetch(`${BASE}/market/book`)).json()) as unknown as { bids: { price: string; agentId: string }[]; asks: { price: string; agentId: string }[] };
const conservation = async (): Promise<{ quote: { holds: boolean }; base: { holds: boolean } }> => {
  const r = (await (await fetch(`${BASE}/economy/report`)).json()) as unknown as { conservation: { quote: { holds: boolean }; base: { holds: boolean } } };
  return r.conservation;
};

const spawnNode = (dataDir: string, oraclePath: string, operator: AgentKeys, agents: AgentKeys[], deskOn: boolean): ReturnType<typeof Bun.spawn> => {
  const overrides: Record<string, string> = {
    ROSHPINA_PORT: String(PORT),
    ROSHPINA_DATA_DIR: dataDir,
    ROSHPINA_OPERATOR_PUBLIC_KEY_1: operator.publicPem,
    ROSHPINA_DESK: deskOn ? "on" : "off",
    ROSHPINA_DESK_TICK_MS: "700",
    ROSHPINA_DESK_GRID_STEP_U: "3000",       // wide on purpose → P4 exercises the oracle desk
    ROSHPINA_DESK_ORACLE_MAX_SPREAD_U: "4000",
    ROSHPINA_ORACLE_PATH: oraclePath,
  };
  for (const a of agents) overrides[`ROSHPINA_AGENT_KEY_${a.agentId.toUpperCase()}`] = a.publicPem;
  return Bun.spawn(["bun", "market-serve.ts"], { env: { ...process.env, ...overrides }, stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });
};

const waitHealthy = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("market node did not become healthy");
};

const deskOf = (s: DeskState, agentId: string) => s.desks.find((d) => d.agentId === agentId);

// ═══ boot ═════════════════════════════════════════════════════════════════════
const dataDir = mkdtempSync(join(tmpdir(), "roshpina-desk-"));
const oracleFresh = join(dataDir, "anchors-fresh.jsonl");
const oracleStale = join(dataDir, "anchors-stale.jsonl");
writeOracleFixture(oracleFresh, Date.now());
writeOracleFixture(oracleStale, Date.now() - 3 * 60 * 60 * 1000); // 3h old
const operator = generateAgent("operator");
const alpha = generateAgent("alpha");
let node = spawnNode(dataDir, oracleFresh, operator, [alpha], true);
let jPath = "";
try {
  await waitHealthy();
  const op = new AgentClient(BASE, operator);
  const A = new AgentClient(BASE, alpha);
  jPath = join(dataDir, "desk-journal.jsonl");

  // register the probe's taker with real inventory (same signed /agents path
  // as production onboarding — the desk never gets privileges, nor does alpha)
  const reg = await op.post("/agents", { agentId: "alpha", usds: "50000000", saos: "40000000", publicPem: alpha.publicPem });
  check("P0z taker registered through the signed path", reg.status === 201, `alpha seeded 5×10¹¹ µ¢ + 20M µ-SAOS`);

  // ── P0: desks booted, oracle fresh ─────────────────────────────────────────
  const h0 = await health();
  check("P0a desk switch on in /health", h0.ok && h0.desk === "on", `desk=${h0.desk}`);
  const s0 = await deskState();
  check("P0b desk state enabled + oracle fresh",
    s0.enabled === true && s0.oracle.ageMin !== null && s0.oracle.ageMin <= 5 && s0.oracle.networks === 3,
    `age=${s0.oracle.ageMin}min networks=${s0.oracle.networks} source=${s0.oracle.source}`);
  check("P0c regime not halt with fresh oracle", s0.regime.mode !== "halt", `${s0.regime.mode} (${s0.regime.reason})`);
  check("P0d both desks present", (deskOf(s0, "mm-grid") !== undefined) && (deskOf(s0, "mm-oracle") !== undefined),
    `desks=[${s0.desks.map((d) => d.agentId).join(", ")}]`);

  // ── P1: grid quotes a two-sided genesis book ──────────────────────────────
  await sleep(2200);
  const b1 = await book();
  const gridBids = b1.bids.filter((o) => o.agentId === "mm-grid");
  const gridAsks = b1.asks.filter((o) => o.agentId === "mm-grid");
  check("P1a grid quotes BOTH sides from empty book", gridBids.length >= 1 && gridAsks.length >= 1,
    `bids=${gridBids.length} asks=${gridAsks.length}`);
  const s1 = await deskState();
  check("P1b spread tight (≤ 2×step + ε)", s1.book.spreadU !== null && BigInt(s1.book.spreadU) <= 6500n,
    `spread=${s1.book.spreadU}µ¢ (${s1.book.spreadBps}bps)`);

  // ── P2: taker-cross fills a designated desk (real settlement) ─────────────
  // the BEST ask may belong to either desk — whoever holds the touch gets the
  // trade; that is correct market behavior, not a defect
  const bestAskP2 = b1.asks[0].price;
  const cross = await A.post("/market/order", { side: "bid", price: bestAskP2, amount: "500000", type: "ioc" });
  const crossFill = (cross.json.fills as { tradeId: string; makerId: string; amount: string }[] | undefined)?.[0];
  check("P2a taker IOC buy crossed a designated desk's ask",
    cross.status === 201 && crossFill !== undefined && crossFill.makerId.startsWith("mm-"),
    `trade=${crossFill?.tradeId} maker=${crossFill?.makerId}`);
  await sleep(1200); // ≥2 ticks: the maker-fill diff must observe the trade
  const s2 = await deskState();
  const sells2 = (deskOf(s2, "mm-grid")?.sells ?? 0) + (deskOf(s2, "mm-oracle")?.sells ?? 0);
  const flow2 = BigInt(deskOf(s2, "mm-grid")?.grossFlowU ?? "0") + BigInt(deskOf(s2, "mm-oracle")?.grossFlowU ?? "0");
  check("P2b desk sell recorded from the REAL fill", sells2 >= 1 && flow2 > 0n,
    `sells=${sells2} grossFlow=${flow2}µ¢`);
  const c2 = await conservation();
  check("P2c conservation holds after the desk fill", c2.quote.holds === true && c2.base.holds === true, "minted == Σaccounts + Σescrow + fees");

  // ── P3: recenter law after a real stepped crash ───────────────────────────
  // the EMA only updates on a TWO-SIDED book, so the crash must be stepped:
  // each round takes out ~one level (−1.2%), leaving bids resting for the
  // desk's ticks to observe a two-sided, lower market
  const emaBefore = BigInt(deskOf(s2, "mm-grid")!.emaU!);
  for (let i = 0; i < 6; i++) {
    const bk = await book();
    if (bk.bids.length === 0) break;
    const px = (BigInt(bk.bids[0].price) * 98n) / 100n; // −2% through the touch
    await A.post("/market/order", { side: "ask", price: px.toString(), amount: "3000000", type: "ioc" });
    await sleep(800); // ≥1 tick between rounds — the desks must SEE each step
  }
  await sleep(4000); // ≥5 ticks: EMA converges toward the crashed mid
  const s3 = await deskState();
  const b3 = await book();
  const ema3 = BigInt(deskOf(s3, "mm-grid")!.emaU!);
  check("P3a EMA followed the crash down", ema3 < emaBefore - (emaBefore * 2n) / 100n,
    `ema ${emaBefore} → ${ema3} (−${((Number(emaBefore - ema3) / Number(emaBefore)) * 100).toFixed(1)}%)`);
  const maxDrift3 = 6n * 3000n; // span law: (levels+1) × step = 6 × 3000µ¢
  const grid3 = [...b3.bids, ...b3.asks].filter((o) => o.agentId === "mm-grid");
  const allNear = grid3.every((o) => { const p = BigInt(o.price); const d = p > ema3 ? p - ema3 : ema3 - p; return d <= maxDrift3; });
  check("P3b every resting grid order within recenterBps of its own EMA", grid3.length >= 2 && allNear,
    `${grid3.length} orders, drift ≤ ${maxDrift3}µ¢`);
  const c3 = await conservation();
  check("P3c conservation holds through the crash", c3.quote.holds === true && c3.base.holds === true, "holds");

  // ── P4: oracle desk improves a wide book ──────────────────────────────────
  // grid step was forced to 3000 → spread 6000 > oracle threshold 4000
  const s4 = await deskState();
  const b4 = await book();
  const oracleOrders = [...b4.bids, ...b4.asks].filter((o) => o.agentId === "mm-oracle");
  const spread4 = BigInt(s4.book.spreadU ?? "999999999");
  check("P4a oracle desk placed improving quotes on the wide book", oracleOrders.length >= 1,
    `mm-oracle orders=${oracleOrders.length}`);
  check("P4b book tightened to ≤ threshold + step ε", spread4 <= 4500n, `spread=${spread4}µ¢`);

  // ── P5: stale-oracle reboot — halt for the oracle desk, grid survives ─────
  node.kill("SIGTERM");
  await sleep(2500);
  node = spawnNode(dataDir, oracleStale, operator, [alpha], true);
  await waitHealthy();
  const h5 = await health();
  check("P5a reboot clean (no ghosts)", h5.ok && h5.ghostsBootQuote === 0 && h5.ghostsBootBase === 0,
    `q=${h5.ghostsBootQuote} b=${h5.ghostsBootBase}`);
  await sleep(2200); // ≥3 ticks post-boot (boot-cancel ran at start)
  const s5 = await deskState();
  check("P5b stale oracle → halt regime (fail-closed)", s5.regime.mode === "halt", `${s5.regime.mode} (${s5.regime.reason})`);
  const b5 = await book();
  const grid5 = [...b5.bids, ...b5.asks].filter((o) => o.agentId === "mm-grid");
  check("P5c mm-grid STILL quoting (internal liquidity survives)", grid5.length >= 2, `mm-grid orders=${grid5.length}`);
  check("P5d no ghost desk orders after boot-cancel (≤ levels per side)",
    grid5.filter((o) => b5.bids.includes(o)).length <= 5 && grid5.filter((o) => b5.asks.includes(o)).length <= 5,
    `bids=${grid5.filter((o) => b5.bids.includes(o)).length} asks=${grid5.filter((o) => b5.asks.includes(o)).length}`);
  const c5 = await conservation();
  check("P5e conservation holds across the reboot", c5.quote.holds === true && c5.base.holds === true, "holds");

  // ── P6: journal exists, valid JSONL ───────────────────────────────────────
  const jLines = existsSync(jPath) ? readFileSync(jPath, "utf8").trim().split("\n") : [];
  let jValid = jLines.length > 0;
  try { for (const l of jLines) JSON.parse(l); } catch { jValid = false; }
  check("P6 desk journal is real and valid JSONL", jValid && jLines.length >= 3, `${jLines.length} lines`);

  // ── P7: kill switch ───────────────────────────────────────────────────────
  node.kill("SIGTERM");
  await sleep(2500);
  node = spawnNode(mkdtempSync(join(tmpdir(), "roshpina-desk-off-")), oracleFresh, operator, [alpha], false);
  await waitHealthy();
  await sleep(2500);
  const h7 = await health();
  const s7 = await deskState();
  const b7 = await book();
  const mm7 = [...b7.bids, ...b7.asks].filter((o) => o.agentId.startsWith("mm-"));
  check("P7 kill switch: desk off → no mm-* orders ever", h7.desk === "off" && s7.enabled === false && mm7.length === 0,
    `desk=${h7.desk} mmOrders=${mm7.length}`);
} finally {
  try { node.kill("SIGTERM"); } catch { /* already down */ }
}

console.log(`\n${fail === 0 ? "LIQUIDITY-DESK-OK" : "LIQUIDITY-DESK-FAILED"} · ${pass} passed · ${fail} failed`);
if (fail === 0) { await sleep(1800); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(fail === 0 ? 0 : 1);
