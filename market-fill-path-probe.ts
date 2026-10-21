/**
 * market-fill-path-probe.ts — LIVE BUG 19/19d/20 permanent probe (the money path).
 *
 * Boots a REAL market node (market-serve.ts) on an ephemeral data dir with
 * throwaway keys, trades through the SIGNED production path, and proves the
 * settlement laws the old code broke:
 *
 *   F1  taker-SELL delivers from the TAKER'S OWN base (never the shared
 *       escrow pool) — the old code drained other makers' locked SAOS until
 *       the delivery side collapsed (856 undelivered base legs in history).
 *   F2  maker-BUY pays via his ESCROWED LOCK (fee+price leave escrow; his
 *       available balance is untouched) — the old code double-charged from
 *       the available balance while the lock sat stuck in escrow forever
 *       (the phantom surplus that fed the non-idempotent boot refunds).
 *   F3  bid locks/releases are the EXACT ceil µ¢ of the resting units —
 *       one units law across placement, cancel and settlement.
 *   F4  settlement charges the EXACT ceil µ¢ (LIVE BUG 20: the old code
 *       charged notional+remainder — up to ~1 USDS of phantom cost per fill;
 *       trade-657 paid 857,682 µ¢ for 486,739 µ¢ of goods, 76% over).
 *   F5  REBOOT: replay → reconcile is SILENT (no ghosts, no refunds), the
 *       resting orders survive, conservation still holds.
 *
 * Honest probes only — every assertion is a ledger-level invariant.
 * Run: bun market-fill-path-probe.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentClient, generateAgent } from "./kernel/fleet/sovereign-agents";
import type { AgentKeys } from "./kernel/fleet/sovereign-agents";
import { exactCeilMicro } from "./kernel/market/book";

const PORT = 3077;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Health {
  ok: boolean; trades: number; bids: number; asks: number;
  escrowOrphanQuote: string; escrowOrphanBase: string;
  ghostsBootQuote: number; ghostsBootBase: number;
}
interface Bal { usdsAvailable: string; usdsLocked: string; saosAvailable: string; saosLocked: string }
const bal = async (c: AgentClient): Promise<Bal> => (await c.get("/agent/me")).json as unknown as Bal;
const health = async (): Promise<Health> => (await (await fetch(`${BASE}/health`)).json()) as unknown as Health;
const book = async (): Promise<{ asks: { amount: string; filled: string }[] }> =>
  (await (await fetch(`${BASE}/market/book`)).json()) as unknown as { asks: { amount: string; filled: string }[] };
const report = async (): Promise<{ conservation: { quote: { holds: boolean }; base: { holds: boolean } } }> =>
  (await (await fetch(`${BASE}/economy/report`)).json()) as unknown as { conservation: { quote: { holds: boolean }; base: { holds: boolean } } };

const spawnNode = (dataDir: string, operator: AgentKeys, agents: AgentKeys[]): ReturnType<typeof Bun.spawn> => {
  const overrides: Record<string, string> = {
    ROSHPINA_PORT: String(PORT),
    ROSHPINA_DATA_DIR: dataDir,
    ROSHPINA_OPERATOR_PUBLIC_KEY_1: operator.publicPem,
    // this probe verifies SETTLEMENT LAWS with hand-placed orders; the desks
    // (default on) would compete for the same fills and blur the assertions —
    // they have their own golden probe (liquidity-desk-probe.ts)
    ROSHPINA_DESK: "off",
  };
  for (const a of agents) overrides[`ROSHPINA_AGENT_KEY_${a.agentId.toUpperCase()}`] = a.publicPem;
  return Bun.spawn(["bun", "market-serve.ts"], { env: { ...process.env, ...overrides }, stdout: "pipe", stderr: "pipe", cwd: import.meta.dir });
};

const waitHealthy = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("market node did not become healthy");
};

// ── boot ─────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "roshpina-fill-path-"));
const operator = generateAgent("operator");
const alpha = generateAgent("alpha");
const bravo = generateAgent("bravo");
let node = spawnNode(dataDir, operator, [alpha, bravo]);
try {
  await waitHealthy();
  const op = new AgentClient(BASE, operator);
  const A = new AgentClient(BASE, alpha);
  const B = new AgentClient(BASE, bravo);

  for (const c of [A, B]) {
    const reg = await op.post("/agents", { agentId: c.keys.agentId, usds: "50000000", saos: "20000000", publicPem: c.keys.publicPem });
    check(`register ${c.keys.agentId}`, reg.status === 201, `50,000,000 µ¢ + 20,000,000 µ-SAOS genesis`);
  }

  // ── F3a: dusty bid locks its EXACT ceil µ¢ ─────────────────────────────────
  const dustyAmt = 999_999n, dustyPx = 250_001n;
  const dustyCeil = exactCeilMicro(dustyPx, dustyAmt); // 250,001 µ¢
  const b0 = await bal(B);
  const placeDusty = await A.post("/market/order", { orderId: "probe-a-dusty", side: "bid", price: dustyPx.toString(), amount: dustyAmt.toString(), type: "limit" });
  check("F3a dusty bid placed + resting", placeDusty.status === 201 && placeDusty.json.resting === true, `999,999 @ 250,001`);
  const aLocked = await bal(A);
  check("F3a lock = exact ceil µ¢",
    BigInt(b0.usdsAvailable) - BigInt(aLocked.usdsAvailable) === dustyCeil,
    `alpha available Δ=${BigInt(b0.usdsAvailable) - BigInt(aLocked.usdsAvailable)} == ceil ${dustyCeil}`);

  // ── F1: taker-SELL delivers from the taker's OWN base ──────────────────────
  // bravo IOC-sells 1,000,000 @ 250,000 → crosses alpha's dusty bid @ 250,001
  // for 999,999 units (maker price rules); taker remainder 1 dies (IOC).
  const bBefore = await bal(B);
  const aBeforeFill = await bal(A);
  const sellRes = await B.post("/market/order", { orderId: "probe-b-sell", side: "ask", price: "250000", amount: "1000000", type: "ioc" });
  const fill = (sellRes.json.fills as { tradeId: string; amount: string; notional: string; remainder: string; makerId: string }[])[0];
  check("F1a taker-sell filled against resting bid", sellRes.status === 201 && fill?.makerId === "alpha", `trade ${fill?.tradeId} amount=${fill?.amount}`);
  const bAfter = await bal(B);
  const aAfterFill = await bal(A);
  const ceilPay = exactCeilMicro(BigInt(fill.price), BigInt(fill.amount));
  const sellFee = BigInt(fill.notional) * 10n / 10000n;
  const sellerNet = ceilPay - sellFee;
  check("F1b taker's OWN SAOS debited (never the pool)",
    BigInt(bBefore.saosAvailable) - BigInt(bAfter.saosAvailable) === BigInt(fill.amount),
    `bravo saos Δ=${BigInt(bBefore.saosAvailable) - BigInt(bAfter.saosAvailable)} == ${fill.amount}`);
  check("F1c buyer received the delivered SAOS",
    BigInt(aAfterFill.saosAvailable) - BigInt(aBeforeFill.saosAvailable) === BigInt(fill.amount),
    `alpha saos +${BigInt(aAfterFill.saosAvailable) - BigInt(aBeforeFill.saosAvailable)}`);
  check("F1d maker paid via his ESCROWED LOCK (available untouched)",
    BigInt(aAfterFill.usdsAvailable) === BigInt(aBeforeFill.usdsAvailable),
    `alpha available unchanged at ${aAfterFill.usdsAvailable}`);
  check("F1e taker-seller received exact-ceil price − fee",
    BigInt(bAfter.usdsAvailable) - BigInt(bBefore.usdsAvailable) === sellerNet,
    `bravo usds +${BigInt(bAfter.usdsAvailable) - BigInt(bBefore.usdsAvailable)} == ${sellerNet}`);

  // ── F2: resting ASK + taker-BUY: escrow base delivers, taker pays own quote ─
  const askPlace = await B.post("/market/order", { orderId: "probe-b-ask", side: "ask", price: "255000", amount: "2000000", type: "limit" });
  check("F2a resting ask placed + locked", askPlace.status === 201 && askPlace.json.resting === true, `2,000,000 @ 255,000`);
  const bAsk = await bal(B);
  check("F2b ask lock debited from bravo's available SAOS",
    BigInt(bAfter.saosAvailable) - BigInt(bAsk.saosAvailable) === 2_000_000n, `bravo saosLocked +2,000,000`);
  const aPreBuy = await bal(A);
  const buyRes = await A.post("/market/order", { orderId: "probe-a-buy", side: "bid", price: "255000", amount: "500000", type: "ioc" });
  const buyFill = (buyRes.json.fills as { tradeId: string; amount: string; notional: string; remainder: string }[])[0];
  check("F2c taker-buy filled", buyRes.status === 201 && buyFill !== undefined, `trade ${buyFill?.tradeId} amount=${buyFill?.amount}`);
  const aPostBuy = await bal(A);
  const bPostBuy = await bal(B);
  const buyPay = exactCeilMicro(BigInt(buyFill.price), BigInt(buyFill.amount));
  const buyFee = BigInt(buyFill.notional) * 10n / 10000n;
  check("F2d taker-buyer paid exact-ceil fee+price from OWN balance",
    BigInt(aPreBuy.usdsAvailable) - BigInt(aPostBuy.usdsAvailable) === buyPay,
    `alpha usds Δ=${BigInt(aPreBuy.usdsAvailable) - BigInt(aPostBuy.usdsAvailable)} == ceil ${buyPay} (NOT notional+remainder)`);
  check("F2e maker-seller received price−fee",
    BigInt(bPostBuy.usdsAvailable) - BigInt(bAsk.usdsAvailable) === buyPay - buyFee,
    `bravo usds +${BigInt(bPostBuy.usdsAvailable) - BigInt(bAsk.usdsAvailable)} == ${buyPay - buyFee}`);
  check("F2f buyer received the maker's locked SAOS",
    BigInt(aPostBuy.saosAvailable) - BigInt(aAfterFill.saosAvailable) === BigInt(buyFill.amount),
    `alpha saos +${BigInt(aPostBuy.saosAvailable) - BigInt(aAfterFill.saosAvailable)} == ${buyFill.amount}`);

  // ── F3b: fresh dusty bid, then cancel — release == the exact ceil ──────────
  const dPlace = await A.post("/market/order", { orderId: "probe-a-dusty2", side: "bid", price: dustyPx.toString(), amount: dustyAmt.toString(), type: "limit" });
  check("F3b fresh dusty bid resting", dPlace.status === 201 && dPlace.json.resting === true, `999,999 @ 250,001`);
  const aPreCancel = await bal(A);
  const dCancel = await A.post("/market/cancel", { orderId: "probe-a-dusty2" });
  check("F3b cancel accepted", dCancel.status === 200, `released=${dCancel.json.released}`);
  const aPostCancel = await bal(A);
  check("F3b release == exact ceil µ¢ (same law as the lock)",
    BigInt(aPostCancel.usdsAvailable) - BigInt(aPreCancel.usdsAvailable) === dustyCeil,
    `alpha usds +${BigInt(aPostCancel.usdsAvailable) - BigInt(aPreCancel.usdsAvailable)} == ceil ${dustyCeil}`);

  // ── F4: conservation ────────────────────────────────────────────────────────
  const rep = await report();
  check("F4a quote conservation holds", rep.conservation.quote.holds === true, "minted == Σavailable + Σescrow + fees");
  check("F4b base conservation holds", rep.conservation.base.holds === true, "minted == Σavailable + Σescrow");

  // ── F5: REBOOT — silent reconcile, book survives ───────────────────────────
  node.kill("SIGTERM");
  await sleep(2500);
  node = spawnNode(dataDir, operator, [alpha, bravo]);
  await waitHealthy();
  const h2 = await health();
  check("F5a boot reconcile SILENT (no ghosts)", h2.ghostsBootQuote === 0 && h2.ghostsBootBase === 0, `q=${h2.ghostsBootQuote} b=${h2.ghostsBootBase}`);
  check("F5b boot reconcile SILENT (no orphans)", BigInt(h2.escrowOrphanQuote) === 0n && BigInt(h2.escrowOrphanBase) === 0n, `q=${h2.escrowOrphanQuote} b=${h2.escrowOrphanBase}`);
  const asks = (await book()).asks;
  // bookSnapshot reports `amount` as the REMAINING size (amount − filled)
  const resting = asks.find((o) => BigInt(o.amount) === 1_500_000n);
  check("F5c seller side survives reboot (remaining ask rests)", resting !== undefined, `1,500,000 µ-SAOS ask still resting`);
  const rep2 = await report();
  check("F5d conservation after reboot", rep2.conservation.quote.holds && rep2.conservation.base.holds, "holds across the restart");
} finally {
  try { node.kill("SIGTERM"); } catch { /* already down */ }
}

console.log(`\n${fail === 0 ? "FILL-PATH-OK" : "FILL-PATH-FAILED"} · ${pass} passed · ${fail} failed`);
if (fail === 0) { await sleep(1800); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(fail === 0 ? 0 : 1);
