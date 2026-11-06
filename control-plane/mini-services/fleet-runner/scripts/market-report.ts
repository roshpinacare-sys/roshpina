/**
 * market-report.ts — honest read-only snapshot of the live economy node:
 * health, order book, and real per-agent economics. No writes, no signatures needed.
 *
 * רץ: bun scripts/market-report.ts
 */

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";

const get = async (p: string) => {
  const res = await fetch(BASE + p, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) {
    console.error(`${p} → http ${res.status}`);
    process.exit(1);
  }
  return (await res.json()) as Record<string, unknown>;
};

const µ = (v: string | number | undefined): string => {
  if (v == null) return "—";
  const n = BigInt(String(v));
  const sign = n < 0n ? "-" : "";
  const abs = (n < 0n ? -n : n).toString().padStart(3, "0");
  const int = abs.slice(0, -2) || "0";
  const frac = abs.slice(-2);
  return `${sign}${int}.${frac}`;
};

console.log(`market report — ${new Date().toISOString()} · ${BASE}`);

const h = await get("/health");
console.log(`health: ok=${h.ok} trades=${h.trades} book bids=${h.bids} asks=${h.asks}`);

const book = (await get("/market/book")) as { bids: { price: string; amount: string; agentId: string }[]; asks: { price: string; amount: string; agentId: string }[] };
console.log(`\nbook: ${book.bids.length} bids × ${book.asks.length} asks`);
for (const b of book.bids.slice(0, 3)) console.log(`  bid ${µ(b.price)} USDS × ${µ(b.amount)} SAOS  (${b.agentId})`);
for (const a of book.asks.slice(0, 3)) console.log(`  ask ${µ(a.price)} USDS × ${µ(a.amount)} SAOS  (${a.agentId})`);

const rep = (await get("/economy/report")) as {
  conservation: { quote: { holds: boolean; minted: string; inEscrow: string; staked: string; fees: string }; base: { holds: boolean; minted: string; inEscrow: string } };
  settledTrades: number;
  treasury?: { usds: string };
  epochOps?: { kind: string; epoch: string; agentId: string; amount: string }[];
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[];
};

console.log(`\neconomy: ${rep.settledTrades} settled trades · agents=${rep.agents.length}`);
for (const a of rep.agents) {
  const usds = BigInt(a.usds) + BigInt(a.usdsLocked) + BigInt(a.usdsStaked ?? "0");
  const saos = BigInt(a.saos) + BigInt(a.saosLocked);
  console.log(`  ${a.agentId.padEnd(8)} USDS ${µ(usds.toString()).padStart(12)} (locked ${µ(a.usdsLocked).padStart(9)} · staked ${µ((a.usdsStaked ?? "0")).padStart(9)}) · SAOS ${µ(saos.toString()).padStart(10)} (locked ${µ(a.saosLocked).padStart(8)}) · fills=${a.fills}`);
}
console.log(`  treasury: ${µ(rep.treasury?.usds ?? rep.conservation.quote.fees)} USDS (הכנסות-אמת · משלם שכר/תגמולים)`);
console.log(`  escrow:  ${µ(rep.conservation.quote.inEscrow)} USDS · ${µ(rep.conservation.base.inEscrow)} SAOS`);
const ops = rep.epochOps ?? [];
if (ops.length > 0) {
  console.log(`  epoch-ops (אחרונים):`);
  for (const o of ops.slice(-5)) console.log(`    ${(o.kind ?? "").padEnd(7)} ${(o.epoch || "—").padEnd(16)} ${(o.agentId ?? "").padEnd(8)} ${µ(o.amount)}`);
}
const ok = rep.conservation.quote.holds && rep.conservation.base.holds;
console.log(`\nconservation: ${ok ? "HOLDS ✓ (שימור-מלא בשני-המטבעות)" : "VIOLATED ✗"}`);
if (!ok) process.exit(1);
