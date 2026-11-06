/**
 * ledger-report.ts — דוח-התאמה בין ספר-המתמיד (:3032) לשוק-החי (:3033). קריאה-בלבד.
 *
 * טבלת-אמת לכל-סוכן ולכל-מטבע: מה שהשוק רואה מול מה שהספר חייב — והפער ביניהם.
 * עמלות-פלטפורמה, יתרות-גיבוי (pool), seq, והוכחת-יכולת-פירעון של הספר עצמו.
 *
 * רץ: bun scripts/ledger-report.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { parseMicroCents, microCentsToString } from "/home/z/repos/roshpina/kernel/ledger/persistent-ledger";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const MARKET = process.env.MARKET_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const TENANT = "market";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

interface MarketReport {
  conservation: { quote: { holds: boolean; minted: string; inEscrow: string; fees: string }; base: { holds: boolean; minted: string; inEscrow: string } };
  settledTrades: number;
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[];
}
interface LedgerAccount { id: string; ownerId: string; type: string; balance: string; balanceDecimal: string }

const pub = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
const priv = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
const client = new AgentClient(LEDGER, { agentId: "operator", publicPem: pub, privatePem: priv, kid: sha256Hex(pub.trim()).slice(0, 16) });

const market = (await (await fetch(MARKET + "/economy/report", { signal: AbortSignal.timeout(5000) })).json()) as unknown as MarketReport;
const ledgerHealth = (await (await fetch(LEDGER + "/health", { signal: AbortSignal.timeout(5000) })).json()) as Record<string, unknown>;
const state = (await client.get(`/state?tenantId=${TENANT}`)).json as { accounts: LedgerAccount[]; solvency: Record<string, string> };
const byOwner = new Map(state.accounts.map((a) => [a.ownerId, a]));

console.log(`== market↔ledger 对账 (קריאה-בלבד) ==`);
console.log(`  market :3033 · trades=${market.settledTrades} · conservation USDS=${market.conservation.quote.holds} SAOS=${market.conservation.base.holds}`);
console.log(`  ledger :3032 · seq=${ledgerHealth.seq} · accounts=${state.accounts.length}`);

console.log(`  ${"agent".padEnd(10)} ${"cur".padEnd(5)} ${"market (avail+lock+stake)".padStart(22)} ${"book mirror".padStart(18)} ${"Δ".padStart(12)}`);
let totalDelta = 0n;
for (const a of market.agents) {
  for (const cur of ["usds", "saos"] as const) {
    const mkt = cur === "usds" ? parseMicroCents(a.usds) + parseMicroCents(a.usdsLocked) + parseMicroCents(a.usdsStaked ?? "0") : parseMicroCents(a.saos) + parseMicroCents(a.saosLocked);
    const book = BigInt(byOwner.get(`agent:${a.agentId}:${cur}`)?.balance ?? "0");
    const d = mkt - book;
    totalDelta += d < 0n ? -d : d;
    console.log(`  ${a.agentId.padEnd(10)} ${cur.toUpperCase().padEnd(5)} ${microCentsToString(mkt).padStart(22)} ${microCentsToString(book).padStart(18)} ${microCentsToString(d).padStart(12)}`);
  }
}
const feeMkt = parseMicroCents(market.conservation.quote.fees);
const feeBook = BigInt(byOwner.get("fees:usds")?.balance ?? "0");
console.log(`  ${"platform".padEnd(10)} ${"USDS".padEnd(5)} ${microCentsToString(feeMkt).padStart(22)} ${microCentsToString(feeBook).padStart(18)} ${microCentsToString(feeMkt - feeBook).padStart(12)}  (עמלות-אמת)`);

const poolUsds = byOwner.get("pool:usds");
const poolSaos = byOwner.get("pool:saos");
console.log(`  pool: USDS ${poolUsds?.balanceDecimal ?? "—"} · SAOS ${poolSaos?.balanceDecimal ?? "—"} (0 = כל-הגיבוי מוחזק כמראות)`);
console.log(`  Σ|Δ| כל המראות: ${microCentsToString(totalDelta)} μ¢ ${totalDelta === 0n ? "— הספר מסונכרן" : "— דורש sync"}`);
console.log(`  solvency: assets=${state.solvency.totalAssetsDecimal ?? state.solvency.totalAssets} liabilities=${state.solvency.totalLiabilitiesDecimal ?? state.solvency.totalLiabilities} netEquity=${state.solvency.netEquityDecimal ?? state.solvency.netEquity}`);
console.log(`LEDGER-REPORT-OK`);
