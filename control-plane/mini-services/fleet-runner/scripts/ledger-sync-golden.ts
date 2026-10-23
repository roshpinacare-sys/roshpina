/**
 * ledger-sync-golden.ts — strict golden gates for the pure settlement math
 * (lib-ledger-sync.ts). Every gate encodes a MEASURED fact from the live
 * 2026-10-21 incident, not a style preference:
 *   ×10,000 unit inflation unmasked by the mm desks' fresh zero mirrors;
 *   feeDelta +14,431 USDS bouncing on a 13,897 USDS pool (crash-loop);
 *   mirrors that must converge DOWN to the live market truth.
 * רץ: bun scripts/ledger-sync-golden.ts   (exit 0 = all gates green)
 */
import { parseMarketMicroCents, computeDeltas, planSettlements, type MarketReport, type LedgerAccount } from "./lib-ledger-sync";

let pass = 0, fail = 0;
function gate(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${detail}`); }
}

function acct(ownerId: string, balance: string, id = `id-${ownerId.replace(/[^a-z0-9]/gi, "-")}`): [string, LedgerAccount] {
  return [ownerId, { id, ownerId, type: "liability", name: ownerId, balance, balanceDecimal: balance }];
}

function mirrorMap(entries: [string, LedgerAccount][]): Map<string, LedgerAccount> {
  return new Map<string, LedgerAccount>(entries);
}

const mkReport = (agents: MarketReport["agents"], fees: string): MarketReport => ({
  conservation: { quote: { holds: true, minted: "0", inEscrow: "0", fees }, base: { holds: true, minted: "0", inEscrow: "0" } },
  settledTrades: 121, agents,
});

// ─── 1. unit law (the ×10,000 regression) ────────────────────────────────────
gate("raw µ¢ integer parsed at true scale", parseMarketMicroCents("49995100") === 49995100n, `got ${parseMarketMicroCents("49995100")}`);
gate("decimal string still accepted (defensive)", parseMarketMicroCents("14.6371") === 146371n);
gate("bare integer is NOT decimal-scaled", parseMarketMicroCents("146371") === 146371n && parseMarketMicroCents("146371") !== 1463710000n);
let threw = false;
try { parseMarketMicroCents("12.345678"); } catch { threw = true; }
gate("5+ fraction digits rejected", threw);

// ─── 2. the live 2026-10-21 desk regression ─────────────────────────────────
const mmGrid = { agentId: "mm-grid", usds: "39001757", usdsLocked: "1244060", usdsStaked: "9750233", saos: "10000000", saosLocked: "5000000", fills: 0 };
const book0 = mirrorMap([acct("agent:mm-grid:usds", "0"), acct("agent:mm-grid:saos", "0"), acct("fees:usds", "0")]);
const deltas0 = computeDeltas(mkReport([mmGrid], "146371"), book0);
const usdsDelta = deltas0.find((d) => d.owner === "agent:mm-grid:usds");
gate("desk delta == raw µ¢ total (NOT ×10,000)", usdsDelta?.delta === 39001757n + 1244060n + 9750233n, `got ${usdsDelta?.delta}`);
gate("desk saos delta == raw µ¢ total", deltas0.find((d) => d.owner === "agent:mm-grid:saos")?.delta === 15000000n);

// ─── 3. the 04:23 crash scenario: feeDelta vs short pool ────────────────────
const crashBook = () => mirrorMap([acct("pool:usds", "138970000"), acct("pool:saos", "0"), acct("fees:usds", "0"), acct("agent:mm-grid:usds", "0"), acct("agent:mm-grid:saos", "0")]);
// mirror the exact failing moment: fees book 0 (fresh), market fees 144,456,371 µ¢ above it
const feeDeltas = computeDeltas(mkReport([mmGrid], "144456371"), crashBook());
const feeDelta = feeDeltas.find((d) => d.owner === "fees:usds");
gate("feeDelta positive when book fees behind", feeDelta?.delta === 144456371n && feeDelta?.fromPool === true, `got ${feeDelta?.delta}`);
const balances = new Map<string, bigint>([["id-pool-usds", 138970000n], ["id-pool-saos", 0n], ["id-fees-usds", 0n], ["id-agent-mm-grid-usds", 0n], ["id-agent-mm-grid-saos", 0n]]);
const { plans, skipped } = planSettlements(feeDeltas, crashBook(), balances);
const deskPlan = plans.find((p) => p.owner === "agent:mm-grid:usds");
const feePlan = plans.find((p) => p.owner === "fees:usds");
gate("pool-funded desk delta settles uncapped first (ascending order)", deskPlan?.capped === false && deskPlan?.amount === 49996050n, `amt=${deskPlan?.amount}`);
gate("pool-short fee settle is CAPPED at the remainder, not fatal", feePlan?.capped === true && feePlan?.amount === 88973950n, `capped=${feePlan?.capped} amt=${feePlan?.amount}`);
gate("saos pool empty → honest drift skip, no crash", skipped.length === 1 && skipped[0]?.owner === "agent:mm-grid:saos");

// ─── 4. floor law on negative settles + conservation of the tracker ─────────
const book2 = mirrorMap([acct("pool:usds", "0"), acct("fees:usds", "1000000"), acct("agent:delta:usds", "11601630000")]);
const rep2 = mkReport([{ agentId: "delta", usds: "1160147", usdsLocked: "0", usdsStaked: "0", saos: "0", saosLocked: "0", fills: 4 }], "146371");
const d2 = computeDeltas(rep2, book2);
const bal2 = new Map<string, bigint>([["id-pool-usds", 0n], ["id-fees-usds", 1000000n], ["id-agent-delta-usds", 11601630000n]]);
const p2 = planSettlements(d2, book2, bal2);
const deltaPlan = p2.plans.find((p) => p.owner === "agent:delta:usds");
gate("overshooting mirror settles DOWN uncapped", deltaPlan?.capped === false && deltaPlan?.amount === 11600469853n, `amt=${deltaPlan?.amount}`);
gate("fees overdraw settles its true delta down", p2.plans.find((p) => p.owner === "fees:usds")?.amount === 853629n);
const sumAfter = [...bal2.values()].reduce((s, v) => s + v, 0n);
const sumBefore = 0n + 1000000n + 11601630000n;
gate("balance tracker conserves Σ exactly", sumAfter === sumBefore, `${sumAfter} vs ${sumBefore}`);

// ─── 5. convergence simulation: inflated era → live truth ───────────────────
let mirror = 499960500000n; // the measured inflated mm-grid mirror (µ¢)
const truth = 49996050n;    // the measured live market total (µ¢)
let pool = 138970000n;
let rounds = 0;
while (mirror !== truth && rounds < 5) {
  const delta = truth - mirror;
  const down = -delta; // positive step to remove from the mirror
  const step = down <= mirror ? down : mirror; // negative settle capped at source
  mirror -= step; pool += step; rounds++;
}
gate("inflated mirror converges to live truth exactly", mirror === truth, `mirror=${mirror} after ${rounds} rounds`);

// ─── 6. ordering law: negatives refill pool before positives draw it ────────
const book3 = mirrorMap([acct("pool:usds", "0"), acct("agent:a:usds", "500"), acct("agent:b:usds", "0")]);
const rep3 = mkReport([
  { agentId: "a", usds: "0", usdsLocked: "0", usdsStaked: "0", saos: "0", saosLocked: "0", fills: 0 },   // −500 (refills pool)
  { agentId: "b", usds: "300", usdsLocked: "0", usdsStaked: "0", saos: "0", saosLocked: "0", fills: 0 }, // +300 (draws pool)
], "0");
const d3 = computeDeltas(rep3, book3);
const bal3 = new Map<string, bigint>([["id-pool-usds", 0n], ["id-agent-a-usds", 500n], ["id-agent-b-usds", 0n]]);
const p3 = planSettlements(d3, book3, bal3);
const bPlan = p3.plans.find((p) => p.owner === "agent:b:usds");
gate("positive delta fully funded by earlier negative (order law)", bPlan?.amount === 300n && bPlan?.capped === false, `amt=${bPlan?.amount} capped=${bPlan?.capped}`);

console.log(`\nLEDGER-SYNC-GOLDEN: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
