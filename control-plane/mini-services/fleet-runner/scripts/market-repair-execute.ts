/**
 * market-repair-execute.ts — Task 30: run the historical-damage repair, signed.
 *
 * זרימה fail-closed מול השירות-החי (3033):
 *   1. quiesce ON   — אף-מסחר בזמן-התיקון (עקביות-מלאה בין-תוכנית לביצוע)
 *   2. dry-run      — המנוע מחשב את התוכנית מהיומנים שלו עצמו (הבקשה לא נושאת
 *                     סכומים) ומחזיר sha256 של הגרסה
 *   3. execute      — אותו-sha בדיוק; אי-התאמה = 409 וריצה-חוזרת (עד 3 ניסיונות)
 *   4. quiesce OFF  — תמיד, גם-בכישלון (finally)
 *   5. בדיקת-שימור לאחר-מעשה + דוח מלא ל-outputs/
 *
 * כל-רגל idempotent (repair:<kind>:<ref>) — ריצה-חוזרת היא no-op מדויק.
 * Run: bun scripts/market-repair-execute.ts
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { readFileSync } from "fs";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { AgentKeys } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const OUT_DIR = join(import.meta.dir, "..", "data", "outputs");

function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

const op = new AgentClient(BASE, loadKeys("operator"));

const pre = (await (await fetch(`${BASE}/economy/report`)).json()) as {
  conservation: { quote: { minted: string; holds: boolean }; base: { minted: string; holds: boolean } };
};
console.log(`pre-repair conservation: USDS minted=${pre.conservation.quote.minted} holds=${pre.conservation.quote.holds} | SAOS minted=${pre.conservation.base.minted} holds=${pre.conservation.base.holds}`);

const q = await op.post("/internal/quiesce", { on: true });
if (q.status !== 200) {
  console.error(`quiesce refused → http ${q.status} ${JSON.stringify(q.json).slice(0, 160)}`);
  process.exit(1); // fail-closed: לא מתקנים על-שוק-חי-שלא-הסכים לקפוא
}
console.log("market quiesced — no trading during the repair window");

let report: unknown = null;
try {
  let plan: { planSha256: string; summary: { kind: string; count: number; owed: string; payable: string; shortfall: string }[]; anomalies: string[]; scope: { distinctTrades: number; refunds: number; unsettledTrades: number } } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const d = await op.post("/economy/repair-historical", { dryRun: true });
    if (d.status !== 200) {
      console.error(`dry-run refused → http ${d.status} ${JSON.stringify(d.json).slice(0, 200)}`);
      process.exit(1);
    }
    plan = d.json as typeof plan;
    console.log(`plan ${plan!.planSha256.slice(0, 16)}… (attempt ${attempt}):`);
    for (const s of plan!.summary) {
      if (s.count > 0) console.log(`  ${s.kind.padEnd(12)} n=${String(s.count).padStart(5)} owed=${s.owed} payable=${s.payable} shortfall=${s.shortfall}`);
    }
    if (plan!.anomalies.length) console.log(`  anomalies (${plan!.anomalies.length}): ${plan!.anomalies.slice(0, 3).join(" | ")}`);

    const ex = await op.post("/economy/repair-historical", { execute: true, planSha256: plan!.planSha256 });
    if (ex.status === 200) {
      report = ex.json;
      break;
    }
    const code = (ex.json as { code?: string })?.code;
    if (code === "PLAN_SHA_MISMATCH" && attempt < 3) {
      console.log("  sha mismatch (state moved) — recomputing…");
      continue;
    }
    console.error(`execute refused → http ${ex.status} ${JSON.stringify(ex.json).slice(0, 240)}`);
    process.exit(1);
  }

  const r = report as { executed: number; zero: number; shortfall: number; movedUsds: string; movedSaos: string; planSha256: string; conservation: { quote: { holds: boolean }; base: { holds: boolean } } } | null;
  if (r) {
    console.log(`executed legs=${r.executed} zero=${r.zero} shortfall=${r.shortfall}`);
    console.log(`moved: USDS ${r.movedUsds} µ¢ | SAOS ${r.movedSaos} µ-SAOS`);
    console.log(`post-repair conservation: quote holds=${r.conservation.quote.holds} base holds=${r.conservation.base.holds}`);
    if (!r.conservation.quote.holds || !r.conservation.base.holds) {
      console.error("CONSERVATION BROKEN — LOUD FAILURE");
      process.exit(1);
    }
  }
} finally {
  await op.post("/internal/quiesce", { on: false });
  console.log("market resumed");
}

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, `market-repair-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ pre, report, at: new Date().toISOString() }, null, 2));
console.log(`report → ${out}`);
