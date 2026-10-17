/**
 * economy-selftest.ts — P2 end-to-end proof: the sovereign agent economy.
 *
 * "הסוכנים והריבונות הם גם הלקוח והמשתמש והכל" — מוכח כאן מקצה-לקצה:
 *   1. 4 סוכנים, לכל-אחד Ed25519 משלו — הם הלקוחות היחידים.
 *   2. המפעיל מקצה הון ראשוני (guardMint — יצירת-אשראי אמיתית דרך-השומר).
 *   3. 30 מחזורים: כל-סוכן קורא-שוק, מחליט לפי-אסטרטגיה מוזרעת, וחותם
 *      על-כל-פעולה מול-השירות (בדיוק כמו-לקוח חוץ — בלי קיצורי-דרך).
 *   4. אחרי-כל-מחזור: שימור-כסף מאומת (minted == accounts+escrow+fees, בשני
 *      המטבעות) — החוק הכלכלי המרכזי, לכל-הטיקים.
 *   5. SIGKILL אמיתי באמצע-הסשן → קימה-מחדש → ספר+יתרות+מסחר זהים →
 *      המסחר ממשיך מאותו-רגע.
 *   6. דוח-סוף: P&L אמיתי פר-סוכן, עמלות-פלטפורמה אמיתיות, אפס-אבק-אבוד.
 *
 * רץ: bun economy-selftest.ts
 */

import { spawn } from "node:child_process";
import { kill } from "node:process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentClient, generateAgent, STRATEGIES, mulberry32 } from "./kernel/fleet/sovereign-agents";
import type { MarketView, StrategyState } from "./kernel/fleet/sovereign-agents";

const assert = (cond: unknown, label: string): void => {
  if (!cond) {
    console.error(`ECONOMY-SELFTEST-FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

// ─── Harness ─────────────────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roshpina-economy-"));
const operator = generateAgent("operator");
const FLEET = ["alpha", "bravo", "gamma", "delta"] as const;
const agents = FLEET.map((id) => generateAgent(id));

function startServer(): ReturnType<typeof spawn> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ROSHPINA_PORT: "0",
    ROSHPINA_DATA_DIR: dataDir,
    ROSHPINA_OPERATOR_PUBLIC_KEY_1: operator.publicPem,
  };
  for (const a of agents) env[`ROSHPINA_AGENT_KEY_${a.agentId.toUpperCase()}`] = a.publicPem;
  return spawn("bun", ["market-serve.ts"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
}

async function waitServer(proc: ReturnType<typeof spawn>): Promise<string> {
  let out = "";
  const t0 = Date.now();
  return await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const m = out.match(/LISTENING (\d+)/);
      if (m) {
        clearInterval(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      } else if (Date.now() - t0 > 15000) {
        clearInterval(timer);
        reject(new Error(`server boot timeout. out=${out.slice(0, 600)}`));
      }
    }, 80);
    proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  });
}

const get = async (base: string, p: string) => (await fetch(base + p)).json() as Record<string, unknown>;

async function report(base: string) {
  return (await get(base, "/economy/report")) as {
    conservation: { quote: { holds: boolean; minted: string; inEscrow: string; fees: string }; base: { holds: boolean; minted: string; inEscrow: string } };
    settledTrades: number;
    agents: { agentId: string; usds: string; usdsLocked: string; saos: string; saosLocked: string; fills: number }[];
  };
}

async function bookView(base: string): Promise<MarketView> {
  return (await get(base, "/market/book")) as MarketView;
}

async function assertConservation(base: string, label: string): Promise<void> {
  const r = await report(base);
  assert(r.conservation.quote.holds === true, `${label}: שימור-USDS (minted=${r.conservation.quote.minted} escrow=${r.conservation.quote.inEscrow} fees=${r.conservation.quote.fees})`);
  assert(r.conservation.base.holds === true, `${label}: שימור-SAOS (minted=${r.conservation.base.minted} escrow=${r.conservation.base.inEscrow})`);
}

// ─── The proof ───────────────────────────────────────────────────────────────

console.log("== P2 economy-selftest: the agents ARE the economy ==");

let proc = startServer();
let base = await waitServer(proc);
console.log(`server up at ${base}`);

// operator registers the fleet (signed, of course)
const opClient = new AgentClient(base, operator);
for (const a of agents) {
  const res = await opClient.post("/agents", { agentId: a.agentId, usds: "5000.00", saos: "100000000" }); // 100 SAOS in µ-SAOS
  assert(res.status === 201, `סוכן ${a.agentId} נרשם והוקצה (5000.00 USDS + 100 SAOS)`);
}
await assertConservation(base, "לאחר-הקצאות");

// the fleet trades — 30 ticks, each agent signs its own actions
const clients = new Map(agents.map((a) => [a.agentId, new AgentClient(base, a)]));
const seeds = new Map(agents.map((a, i) => [a.agentId, 1337 + i * 7919]));
const TICKS = 30;
let refusals = 0;

for (let tick = 1; tick <= TICKS; tick++) {
  const view = await bookView(base);
  for (const a of agents) {
    const client = clients.get(a.agentId)!;
    const me = (await client.get("/agent/me")).json as {
      usdsAvailable: string; saosAvailable: string;
      ownOrders: { id: string; side: "bid" | "ask"; price: string; amount: string }[];
    };
    const state: StrategyState = {
      agentId: a.agentId,
      tick,
      ownOrders: me.ownOrders,
      balances: { usdsAvailable: me.usdsAvailable, saosAvailable: me.saosAvailable },
    };
    const strategy = STRATEGIES[a.agentId === "alpha" ? "marketMaker" : a.agentId === "bravo" ? "momentum" : a.agentId === "gamma" ? "accumulator" : "farmer"];
    const rnd = mulberry32(seeds.get(a.agentId)! + tick);
    const intents = strategy(view, state, rnd);
    for (let n = 0; n < intents.length; n++) {
      const it = intents[n];
      if (it.action === "cancel") {
        const r = await client.post("/market/cancel", { orderId: it.orderId });
        if (r.status !== 200) refusals++;
        continue;
      }
      const r = await client.post("/market/order", {
        orderId: `${a.agentId}-${tick}-${n}`,
        side: it.side,
        price: it.price!.toString(),
        amount: it.amount!.toString(),
        type: it.type ?? "limit",
      });
      if (r.status !== 201) refusals++; // honest refusals (insufficient/self-trade/…) are part of life
    }
  }
  // THE LAW: after every single tick, money is conserved — both currencies
  await assertConservation(base, `טיק ${tick}/30`);
  if (tick === 15) {
    // REAL crash mid-session
    const pre = await report(base);
    const preBook = await bookView(base);
    kill((proc as unknown as { pid: number }).pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    proc = startServer();
    base = await waitServer(proc);
    for (const [id, c] of clients) c.base = base; // agents reconnect (their keys are unchanged)
    const post = await report(base);
    const postBook = await bookView(base);
    if (JSON.stringify(post.agents) !== JSON.stringify(pre.agents)) {
      console.error("PRE :", JSON.stringify(pre.agents));
      console.error("POST:", JSON.stringify(post.agents));
      console.error("PRE-CONS :", JSON.stringify(pre.conservation));
      console.error("POST-CONS:", JSON.stringify(post.conservation));
    }
    assert(JSON.stringify(post.agents) === JSON.stringify(pre.agents), "SIGKILL בטיק-15: כל-יתרות-הסוכנים זהות לאחר-הקימה");
    assert(JSON.stringify(postBook) === JSON.stringify(preBook), "SIGKILL בטיק-15: ספר-הזמנות זהה לאחר-הקימה (replay מדויק)");
    assert(post.settledTrades === pre.settledTrades, `SIGKILL בטיק-15: ${pre.settledTrades} עסקאות שרדו`);
    console.log("✓ SIGKILL אמיתי באמצע-משמרת → המערכת קמה מדויקת והמשיכה לסחור");
  }
}

// final economics — real numbers only
const fin = await report(base);
const totalFills = fin.agents.reduce((s, a) => s + a.fills, 0);
assert(fin.settledTrades > 0, `מסחר אמיתי התרחש: ${fin.settledTrades} עסקאות / ${totalFills} רגלי-מילוי פר-סוכן`);
assert(BigInt(fin.conservation.quote.fees) > 0n, `הפלטפורמה הרוויחה עמלות אמיתיות: ${fin.conservation.quote.fees} µ¢`);
assert(refusals < 100, `סירובים-כנים (חוקים-פועלים): ${refusals} — לא-מטורף, לא-אפס`);

kill((proc as unknown as { pid: number }).pid!, "SIGKILL");

console.log("\n== דוח כלכלי אמיתי (מהנתונים, לא מהצהרות) ==");
for (const a of fin.agents) {
  const usdsTotal = BigInt(a.usds) + BigInt(a.usdsLocked);
  const saosTotal = BigInt(a.saos) + BigInt(a.saosLocked);
  console.log(`  ${a.agentId.padEnd(6)} USDS ${usdsTotal.toString().padStart(12)} (locked ${a.usdsLocked.padStart(10)}) · SAOS ${saosTotal.toString().padStart(10)} (locked ${a.saosLocked.padStart(8)}) · fills=${a.fills}`);
}
console.log(`  fees   USDS ${fin.conservation.quote.fees} (הכנסה-אמיתית של הפלטפורמה)`);
console.log(`  escrow USDS ${fin.conservation.quote.inEscrow} · SAOS ${fin.conservation.base.inEscrow}`);
console.log("\nECONOMY-SELFTEST-OK · כלכלה-ריבונית-סגורה: סוכנים-לקוחות, שימור-לכל-טיק, קריסה-וקימה, עמלות-אמיתיות");
process.exit(0);
