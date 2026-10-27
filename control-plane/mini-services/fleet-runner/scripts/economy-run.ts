/**
 * economy-run.ts — the sovereign agent economy running against the LIVE network node.
 *
 * זו ההצטרפות-של-הכלכלה-אל-הרשת: ה-runner מפעיל 4 סוכנים חתומים (Ed25519 משלהם)
 * שסוחרים מול צומת-השוק החי (http://127.0.0.1:3033) דרך HTTP חתום — בדיוק
 * כמו-לקוחות-חוץ. אין-שרת-מדומה, אין-קיצורי-דרך: כל-פעולה עוברת-את-הרשת.
 *
 * חוקי-הריצה (כנים-לגמרי):
 *   1. המפעיל רושם-סוכנים-חסרים בלבד (idempotent — ממשיך-מצב-קיים).
 *   2. כל-טיק: קריאת-שוק → החלטה-מוזרעת → פעולות-חתומות.
 *   3. אחרי-כל-טיק: שימור-כסף בשני-המטבעות — הפרה-אחת = exit 1 מיידי.
 *   4. סירובים-כנים (יתרה/חוקי-ספר) הם-חלק-מהחיים — נספרים-ומדווחים.
 *
 * רץ: bun scripts/economy-run.ts [ticks=20]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { generateKeyPairSync } from "node:crypto";
import { AgentClient, STRATEGIES, mulberry32, capitalIntents, midOf } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { llmStrategist } from "./llm-strategist";
import type { AgentKeys, MarketView, StrategyState } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const TICKS = Number(process.argv[2] ?? 20);
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const CORE = ["alpha", "bravo", "gamma", "delta", "saos-0004"] as const; // directive 42 §3: the market principal rides the core

function hasKeys(id: string): boolean {
  return existsSync(join(KEYS_DIR, `${id}.priv.pem`)) && existsSync(join(KEYS_DIR, `${id}.pub.pem`));
}
/** Provision fresh local dev keys for a member whose keys were lost with a
 *  sandbox wipe (dev-only, gitignored — the same pattern as provision-keys.ts).
 *  The MONEY belongs to the agentId, not the key — the operator re-licenses
 *  the new key below (fail-closed, signed), identity is never assumed. */
function ensureKeys(id: string): void {
  if (hasKeys(id)) return;
  mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(KEYS_DIR, `${id}.pub.pem`), publicKey.export({ type: "spki", format: "pem" }).toString());
  writeFileSync(join(KEYS_DIR, `${id}.priv.pem`), privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  console.log(`  agent ${id}: fresh local dev keys provisioned (keys were era-lost)`);
}
function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}
/** strategy for a licensed agent: deterministic by name-hash — honest, reproducible.
 *  epsilon = סוכן-ה-LLM (מוח-מלאכותי אמיתי; חוקי-המלאי והחתימה זהים-לכולם) — ניסוי A/B חי מול-4 האסטרטגיות האלגוריתמיות */
function strategyFor(id: string): keyof typeof STRATEGIES | "llm" {
  if (id === "alpha") return "marketMaker";
  if (id === "bravo") return "momentum";
  if (id === "gamma") return "accumulator";
  if (id === "delta") return "farmer";
  if (id === "epsilon") return "llm";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (["marketMaker", "momentum", "accumulator", "farmer"] as const)[h % 4];
}
function seedFor(id: string): number {
  let h = 7919;
  for (const c of id) h = ((h * 31 + c.charCodeAt(0)) | 0) >>> 0;
  return 4242 + (h % 100000);
}

interface EconomyReport {
  conservation: { quote: { holds: boolean; minted: string; inEscrow: string; fees: string }; base: { holds: boolean; minted: string; inEscrow: string } };
  settledTrades: number;
  agents: { agentId: string; usds: string; usdsLocked: string; saos: string; saosLocked: string; fills: number }[];
}
const get = async (p: string) => (await fetch(BASE + p)).json() as Record<string, unknown>;

async function report(): Promise<EconomyReport> {
  return (await get("/economy/report")) as EconomyReport;
}

async function conservationCheck(label: string): Promise<void> {
  const r = await report();
  const ok = r.conservation.quote.holds === true && r.conservation.base.holds === true;
  if (!ok) {
    console.error(`CONSERVATION-VIOLATION at ${label}: ${JSON.stringify(r.conservation)}`);
    process.exit(1); // the law is the law — a violated economy is a failed run
  }
  console.log(`  tick ${label.padStart(6)}  ✓ שימור-מלא (USDS minted=${r.conservation.quote.minted} · SAOS minted=${r.conservation.base.minted}) · trades=${r.settledTrades}`);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`== economy-run against LIVE node ${BASE} · ${TICKS} ticks ==`);

// health gate: the node must be up before anything
const health = await fetch(BASE + "/health", { signal: AbortSignal.timeout(3000) });
if (!health.ok) {
  console.error(`market node not healthy: http ${health.status}`);
  process.exit(1);
}

const operator = loadKeys("operator");
const opClient = new AgentClient(BASE, operator);

// 1) operator registers missing core agents (idempotent — resume existing state)
const pre = await report();
const existing = new Set(pre.agents.map((a) => a.agentId));
for (const a of CORE) {
  // market registration can survive a reboot while the local key files do NOT
  // (live bug 2026-10-27: saos-0004 registered on the node, ENOENT on its pem —
  // fleet could not load). ensureKeys is idempotent: only writes when missing.
  ensureKeys(a);
  if (existing.has(a)) {
    console.log(`  agent ${a}: already registered — resuming (אין-הקצאה-כפולה)`);
    continue;
  }
  const keys = loadKeys(a);
  const res = await opClient.post("/agents", { agentId: a, usds: "5000.00", saos: "100000000", publicPem: keys.publicPem });
  console.log(`  agent ${a}: register → http ${res.status} ${res.status === 201 ? "(5000.00 USDS + 100 SAOS הוקצו)" : JSON.stringify(res.json).slice(0, 120)}`);
  if (res.status !== 201) process.exit(1);
}
await conservationCheck("setup");

// 1-a) era-accident restoration: if the WHOLE economy holds zero SAOS (the
// supply was wiped with a sandbox reboot — the live bug of 2026-10-18), no ask
// can ever rest and every run is INCONCLUSIVE. The operator signs a
// re-allocation restoring the genesis SAOS grant to the core fleet.
// Idempotent per day-ref — reruns never double-mint; a new day is a new,
// signed, journaled decision.
const drought = pre.conservation.base.minted === "0" && pre.agents.every((a) => a.saos === "0" && a.saosLocked === "0");
if (drought) {
  const ref = `restore-${new Date().toISOString().slice(0, 10)}`;
  console.log(`  SAOS drought detected (minted=0) — operator signs re-allocation ref=${ref}`);
  for (const a of CORE) {
    const r = await opClient.post("/economy/allocate", { agentId: a, usds: "0", saos: "100000000", ref });
    if (r.status === 201 || r.status === 200) console.log(`  agent ${a}: SAOS restored (100 SAOS, ref ${ref})`);
    else {
      console.error(`  agent ${a}: re-allocation refused → http ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
      process.exit(1); // fail-closed: a drought we cannot fix honestly must be loud
    }
  }
}

// 1-b) the fleet = core + licensed members — identity restored the honest way:
// fresh dev keys + operator re-license signature. Never assumed, never faked.
const licensed: string[] = [];
for (const id of pre.agents.map((a) => a.agentId)) {
  // EVERY registered member — core included: a reboot may erase the local pem
  // while the node keeps the account; the honest cure is fresh keys + an
  // operator-signed re-license (the money belongs to the agentId, not the key).
  ensureKeys(id);
  const isCore = (CORE as readonly string[]).includes(id);
  const keys = loadKeys(id);
  const client = new AgentClient(BASE, keys);
  const probe = await client.get("/agent/me");
  if (probe.status === 200) {
    if (!isCore) licensed.push(id);
    continue;
  }
  const relic = await opClient.post("/agents", { agentId: id, usds: "0", saos: "0", publicPem: keys.publicPem });
  if (relic.status === 201) {
    const probe2 = await client.get("/agent/me");
    if (probe2.status === 200) {
      console.log(`  agent ${id}: re-licensed by operator signature (key binding was era-lost)`);
      if (!isCore) licensed.push(id);
      continue;
    }
  }
  if (isCore) {
    console.log(`  agent ${id}: KEY BINDING LOST and re-license refused (http ${relic.status}) — stays in fleet, will fail-loud`);
    continue;
  }
  console.log(`  agent ${id}: re-license refused (http ${relic.status}) — skipping honestly`);
}
const fleetIds = [...CORE, ...licensed];
const agents = fleetIds.map(loadKeys);
console.log(`  fleet: ${fleetIds.join(", ")} (${licensed.length} licensed members joined)`);

// 1-c) the fleet trades — every action signed, every tick conserved
// sovereign capital first: each agent rebalances its own stake (signed, idempotent refusals are honest)
const clients = new Map(agents.map((a) => [a.agentId, new AgentClient(BASE, a)]));
const seeds = new Map(agents.map((a) => [a.agentId, seedFor(a.agentId)]));
let refusals = 0;
let orders = 0;
let stakeOps = 0;
let stakeMoved = 0n;
const runId = Date.now().toString(36);

// 1-d) fuel streaming (directive 42 §1, trace 1a178c71bcb7ddad): no soldier
// sits dry — the operator signs a bounded top-up for any member whose
// available USDS fell below the fuel floor. Idempotent per run-ref, capped
// per member per run; conservation is re-proven immediately after.
const FLOOR_USDS = 2_500_000n; // 250.00 USDS (1.00 USDS = 10^4 units)
const CAP_USDS = 10_000_000n; // hard cap 1000.00 USDS per member per run
let fuelOps = 0;
let fuelMoved = 0n;
for (const a of agents) {
  const client = clients.get(a.agentId)!;
  const me = await client.get("/agent/me");
  if (me.status !== 200) continue; // identity problems fail-loud in the trading loop
  const avail = BigInt((me.json as unknown as { usdsAvailable: string }).usdsAvailable || "0");
  if (avail >= FLOOR_USDS) continue;
  const headroom = CAP_USDS - avail;
  const topUp = headroom > CAP_USDS / 4n ? CAP_USDS / 2n : headroom;
  // /economy/allocate takes a CENT-unit DECIMAL string ("1.00" = 10,000 µ¢) —
  // the ×10⁴ trap (Tasks 27/29): sending raw units minted 10,000× the intent
  // (live bug 2026-10-27, clawed back same-hour via negative-realloc burn).
  // Convert exactly, no floats.
  const usdsDec = `${topUp / 10_000n}.${String(topUp % 10_000n).padStart(4, "0")}`;
  const ref = `fuel-${runId}-${a.agentId}`;
  const r = await opClient.post("/economy/allocate", { agentId: a.agentId, usds: usdsDec, saos: "0", ref });
  if (r.status === 201 || r.status === 200) {
    fuelOps++;
    fuelMoved += topUp;
    console.log(`  ⛽ fuel ${a.agentId}: +${topUp} µ¢ (${usdsDec} USDS) (available ${avail} < floor ${FLOOR_USDS}) ref=${ref}`);
  } else {
    refusals++;
    console.log(`  ⚠ fuel refused (${a.agentId}): http ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  }
}
if (fuelOps > 0) await conservationCheck("fuel");

for (let tick = 1; tick <= TICKS; tick++) {
  const view = (await get("/market/book")) as unknown as MarketView;
  for (const a of agents) {
    const client = clients.get(a.agentId)!;
    const meRes = await client.get("/agent/me");
    if (meRes.status !== 200) {
      console.error(`agent ${a.agentId}: /agent/me → ${meRes.status} (signature/identity problem)`);
      process.exit(1);
    }
    const me = meRes.json as unknown as {
      usdsAvailable: string; saosAvailable: string; usdsStaked?: string;
      ownOrders: { id: string; side: "bid" | "ask"; price: string; amount: string }[];
    };
    const state: StrategyState = {
      agentId: a.agentId,
      tick,
      ownOrders: me.ownOrders,
      balances: { usdsAvailable: me.usdsAvailable, saosAvailable: me.saosAvailable },
      usdsStaked: me.usdsStaked ?? "0",
    };
    // sovereign capital management — the agent stakes/unstakes its OWN money by policy
    for (const ci of capitalIntents(state)) {
      const endpoint = ci.action === "stake" ? "/economy/stake" : "/economy/unstake";
      const r = await client.post(endpoint, {
        amount: ci.stakeAmount!.toString(),
        stakeId: `${a.agentId}-cap-${runId}-t${tick}`,
      });
      if (r.status === 201 || r.status === 200) {
        stakeOps++;
        stakeMoved += ci.stakeAmount!;
      } else refusals++;
    }
    const strategyName = strategyFor(a.agentId);
    if (strategyName === "llm") {
      // קצב-אסטרטגי: החלטת-מוח כל-3-טיקים; ביניהם — הזמנות-קיימות יושבות-בספר (מנתח, לא רועם-תדרים)
      if (tick % 3 === 0) {
        for (const o of me.ownOrders) {
          const r = await client.post("/market/cancel", { orderId: o.id });
          if (r.status !== 200) refusals++;
        }
        const dec = await llmStrategist(view, state, { mid: midOf(view) });
        for (const it of dec.intents) {
          const r = await client.post("/market/order", {
            orderId: `${a.agentId}-llm-${tick}-${it.side}`,
            side: it.side,
            price: it.price.toString(),
            amount: it.amount.toString(),
            type: it.type,
          });
          if (r.status !== 201) refusals++;
          else orders++;
        }
        const capsNote = dec.mode === "noop" ? ` noop(${dec.note ?? ""})` : "";
        console.log(`  🧠 LLM ${a.agentId} t${tick}: ${dec.rationale}${capsNote} [${dec.intents.length} הזמנות]`);
      }
      continue;
    }
    const strategy = STRATEGIES[strategyName];
    const rnd = mulberry32(seeds.get(a.agentId)! + tick);
    const intents = strategy(view, state, rnd);
    for (let n = 0; n < intents.length; n++) {
      const it = intents[n];
      if (it.action === "cancel") {
        const r = await client.post("/market/cancel", { orderId: it.orderId });
        if (r.status !== 200) refusals++;
        else orders++;
        continue;
      }
      const r = await client.post("/market/order", {
        orderId: `${a.agentId}-${tick}-${n}`,
        side: it.side,
        price: it.price!.toString(),
        amount: it.amount!.toString(),
        type: it.type ?? "limit",
      });
      if (r.status !== 201) refusals++; // honest refusals — the rules are working
      else orders++;
    }
  }
  await conservationCheck(`${tick}/${TICKS}`);
}

// 3) final economics — real numbers from the live node
const fin = await report();
const totalFills = fin.agents.reduce((s, a) => s + a.fills, 0);

console.log("\n== דוח כלכלי אמיתי (מהנתונים-החיים, לא-מהצהרות) ==");
for (const a of fin.agents) {
  const usdsTotal = BigInt(a.usds) + BigInt(a.usdsLocked);
  const saosTotal = BigInt(a.saos) + BigInt(a.saosLocked);
  console.log(`  ${a.agentId.padEnd(6)} USDS ${usdsTotal.toString().padStart(12)} (locked ${a.usdsLocked.padStart(10)}) · SAOS ${saosTotal.toString().padStart(10)} (locked ${a.saosLocked.padStart(8)}) · fills=${a.fills}`);
}
console.log(`  fees   USDS ${fin.conservation.quote.fees} µ¢ (הכנסה-אמיתית-של-הפלטפורמה)`);
console.log(`  escrow USDS ${fin.conservation.quote.inEscrow} · SAOS ${fin.conservation.base.inEscrow}`);
const capLine = stakeOps > 0 ? `${stakeOps} פעולות-סטייק אוטונומיות · ${stakeMoved} µ¢ הועברו ל/מ-הסטייק` : "אין-תזוזת-סטייק (בתוך-טווח-היסטרזיס — כנה)";
console.log(`  פעולות-חתומות שבוצעו: ${orders} · סירובים-כנים: ${refusals}`);
console.log(`  הון-ריבוני: ${capLine}`);

if (fin.settledTrades === 0) {
  console.error("ECONOMY-RUN-INCONCLUSIVE: אפס-עסקאות — הספר-לא-התאים (לא-כשל-שימור, אך-גם-לא-מסחר)");
  process.exit(2);
}
console.log("\nECONOMY-RUN-OK · סוכנים-ריבוניים סחרו וניהלו-את-ההון-שלהם מול-הצומת-החי · כסף-נשמר-לכל-טיק");
