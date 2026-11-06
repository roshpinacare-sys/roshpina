/**
 * economy-cycle.ts — אפוק-פיסקלי שלם של הכלכלה-הריבונית, מול צומת-השוק החי:
 *
 *   1. מיסים   — המפעיל גובה 0.01% (1bp) מהיתרה-החופשית של כל-סוכן לאוצר
 *   2. שכר     — האוצר משלם לכל-סוכן שכר-אפוק קבוע (100 USDS)
 *   3. תגמולים — 10% מהאוצר מתחלקים בין הסטייקרים יחסית לסטייק שלהם
 *
 * אפוק = שעה-UTC (למשל e2026-10-17T05) — ריצה-חוזרת באותה-שעה היא no-op
 * אמיתי (idempotency לפי epoch בשתי-שכבות: מנוע+ledger). אם-האוצר לא-מכסה
 * את-השכר — כל-השכר נדחה (fail-closed, אף-תשלום-חלקי). שימור-כסף נבדק
 * בהתחלה ובסוף — הפרה = exit 1.
 *
 * רץ: bun scripts/economy-cycle.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const TAX_RATE_BPS = "1";      // 0.01% of free USDS per epoch
const WAGE = "100";            // 100 USDS per agent per epoch — the engine unit is µ¢: 100 USDS = 100 engine units (×10⁴ canonical)
const REWARDS_RATE_BPS = "1000"; // 10% of treasury distributed to stakers

function loadOperator() {
  const publicPem = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
  return { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

interface EconomyReport {
  conservation: { quote: { holds: boolean; fees: string }; base: { holds: boolean } };
  settledTrades: number;
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; fills: number }[];
  treasury?: { usds: string };
  epochOps?: { kind: string; epoch: string; agentId: string; amount: string; ref: string }[];
}

const dec = (v: bigint): string => `${v} µ¢`;

// ─── quiesce-aware client: cooperate with the backup capsule gate ───────────
// state-backup quiesces the market ~10s per run for a tear-free tar. While
// quiesced the market refuses mutations (MARKET_QUIESCED) — the honest client
// waits inside the window instead of crashing into it. The epoch is idempotent
// (repeat within the hour = real no-op), so a skip after the budget loses nothing.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const QUIESCE_ATTEMPTS = 6;
const QUIESCE_WAIT_MS = 6000; // 6×6s = 36s ≫ the ~10s backup window
const isQuiescedReply = (status: number, body: unknown): boolean =>
  (status === 503 || status === 400) && /quiesc/i.test(JSON.stringify(body ?? ""));

async function getLive(p: string): Promise<EconomyReport> {
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    const res = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok) return body as EconomyReport;
    if (isQuiescedReply(res.status, body)) {
      console.log(`  market quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
      await sleep(QUIESCE_WAIT_MS);
      continue;
    }
    throw new Error(`GET ${p} → http ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
  console.error(`ECONOMY-CYCLE-SKIP: market quiesced throughout the 36s retry budget — epoch deferred honestly (idempotent by epoch; nothing lost, next tick runs it)`);
  process.exit(0);
}

async function postLive(path: string, payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    const r = await client.post(path, payload);
    if (isQuiescedReply(r.status, r.json)) {
      console.log(`  market quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
      await sleep(QUIESCE_WAIT_MS);
      continue;
    }
    return r;
  }
  console.error(`ECONOMY-CYCLE-SKIP: market quiesced throughout the 36s retry budget — epoch deferred honestly (idempotent by epoch; nothing lost, next tick runs it)`);
  process.exit(0);
}

async function conservationCheck(label: string): Promise<void> {
  const r = await getLive("/economy/report");
  const ok = r.conservation.quote.holds === true && r.conservation.base.holds === true;
  if (!ok) {
    console.error(`CONSERVATION-VIOLATION at ${label}: ${JSON.stringify(r.conservation)}`);
    process.exit(1);
  }
}

console.log(`== economy-cycle against LIVE node ${BASE} ==`);
await conservationCheck("start");

// epoch id: the UTC hour — repeats within the hour are honest no-ops (idempotent)
const now = new Date();
const epoch = `e${now.toISOString().slice(0, 13)}`;
const op = loadOperator();
const client = new AgentClient(BASE, op);

const before = await getLive("/economy/report");
const treasuryBefore = BigInt(before.conservation.quote.fees);
console.log(`epoch ${epoch} · treasury before: ${dec(treasuryBefore)} · trades=${before.settledTrades}`);

// 1) tax — the operator levies on free balances
const tax = await postLive("/economy/tax", { epoch, rateBps: TAX_RATE_BPS });
if (tax.status !== 201) { console.error(`tax refused: http ${tax.status} ${JSON.stringify(tax.json).slice(0, 160)}`); process.exit(1); }
console.log(`  tax      : collected ${dec(BigInt(tax.json.collected as string))} from ${tax.json.taxed} agents (${tax.json.skipped} skipped/already-taxed)`);

// 2) payroll — the treasury pays every agent (fail-closed: all or nothing)
const payroll = await postLive("/economy/payroll", { epoch, wage: WAGE });
if (payroll.status !== 201) { console.error(`payroll refused: http ${payroll.status} ${JSON.stringify(payroll.json).slice(0, 200)}`); process.exit(1); }
console.log(`  payroll  : paid ${payroll.json.paid} agents × ${dec(BigInt(WAGE))} = ${dec(BigInt(payroll.json.total as string))} (${payroll.json.skipped} already paid)`);

// 3) staking rewards — 10% of the treasury, pro-rata by stake
const rewards = await postLive("/economy/rewards", { epoch, rateBps: REWARDS_RATE_BPS });
if (rewards.status !== 201) { console.error(`rewards refused: http ${rewards.status} ${JSON.stringify(rewards.json).slice(0, 200)}`); process.exit(1); }
console.log(`  rewards  : budget ${dec(BigInt(rewards.json.budget as string))} → distributed ${dec(BigInt(rewards.json.distributed as string))} to ${rewards.json.stakers} stakers (remainder ${dec(BigInt(rewards.json.remainder as string))} stays)`);

await conservationCheck("end");

const after = await getLive("/economy/report");
const treasuryAfter = BigInt(after.conservation.quote.fees);
const stakedTotal = after.agents.reduce((s, a) => s + BigInt(a.usdsStaked), 0n);
console.log(`\ntreasury after: ${dec(treasuryAfter)} (Δ ${dec(treasuryAfter - treasuryBefore)}) · Σstaked=${dec(stakedTotal)}`);
console.log(`conservation: HOLDS ✓ (start & end)`);
console.log("ECONOMY-CYCLE-OK");
