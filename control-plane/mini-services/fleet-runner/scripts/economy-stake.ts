/**
 * economy-stake.ts — הסוכנים נועלים הון: סטייקינג אמיתי על צומת-השוק החי.
 *
 * כל-סוכן (Ed25519 משלו) מגיע בהתכנסות אל יעד-סטייקינג = 5% מסך-ההחזקות
 * שלו (חופשי+נעול-בזמנות+סטייק): מי שמתחת-ליעד שולח הצבה חתומה ל-/economy/stake,
 * מי שמעליו — נשאר. אין-מספרים-מדומים: הכל נקרא מהדוח החי, הכל חתום, הכל
 * נרשם ביומן-השוק. שימור-כסף נבדק בסוף-הריצה — הפרה = exit 1.
 *
 * רץ: bun scripts/economy-stake.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const FLEET = ["alpha", "bravo", "gamma", "delta"] as const;
const TARGET_BPS = 500n; // 5% of total holdings

function loadKeys(id: string) {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

interface EconomyReport {
  conservation: { quote: { holds: boolean }; base: { holds: boolean } };
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[];
}

const get = async (p: string): Promise<EconomyReport> =>
  (await (await fetch(BASE + p, { signal: AbortSignal.timeout(5000) })).json()) as EconomyReport;

const dec = (v: bigint): string => `${v} µ¢`;

console.log(`== economy-stake against LIVE node ${BASE} · target ${Number(TARGET_BPS) / 100}% of holdings ==`);

const health = (await (await fetch(BASE + "/health", { signal: AbortSignal.timeout(5000) })).json()) as Record<string, unknown>;
if (health.ok !== true) { console.error("market node not healthy"); process.exit(1); }

let acted = 0;
for (const id of FLEET) {
  const rep = await get("/economy/report");
  const me = rep.agents.find((a) => a.agentId === id);
  if (!me) { console.log(`  ${id}: not registered — skipping`); continue; }
  const total = BigInt(me.usds) + BigInt(me.usdsLocked) + BigInt(me.usdsStaked);
  const staked = BigInt(me.usdsStaked);
  const target = total * TARGET_BPS / 10000n;
  const need = target - staked;
  if (need <= 0n) {
    console.log(`  ${id.padEnd(6)} already staked ${dec(staked)} ≥ target ${dec(target)} — no action`);
    continue;
  }
  const free = BigInt(me.usds);
  const stake = need < free ? need : free;
  if (stake <= 0n) {
    console.log(`  ${id.padEnd(6)} wants ${dec(need)} but free balance is ${dec(free)} — honest skip`);
    continue;
  }
  const client = new AgentClient(BASE, loadKeys(id));
  const res = await client.post("/economy/stake", { amount: stake.toString(), stakeId: `st-${id}-${Date.now()}` });
  if (res.status !== 201) {
    console.error(`  ${id}: stake refused — http ${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
    process.exit(1); // fail-closed: a refused stake that we believed legal is a bug — stop
  }
  acted++;
  console.log(`  ${id.padEnd(6)} STAKED ${dec(stake).padStart(12)} USDS → total staked ${dec(BigInt(res.json.staked as string))}`);
}

const fin = await get("/economy/report");
const stakers = fin.agents.filter((a) => BigInt(a.usdsStaked) > 0n);
const stakedTotal = fin.agents.reduce((s, a) => s + BigInt(a.usdsStaked), 0n);
console.log(`\nresult: ${acted} stake ops · stakers=${stakers.length}/${fin.agents.length} · Σstaked=${dec(stakedTotal)}`);
const ok = fin.conservation.quote.holds === true && fin.conservation.base.holds === true;
console.log(`conservation: ${ok ? "HOLDS ✓" : "VIOLATED ✗"}`);
if (!ok) process.exit(1);
console.log("ECONOMY-STAKE-OK");
