/**
 * evidence-ledger-dump.ts — READ-ONLY evidence probe (no writes, no transfers).
 * Dumps the live ledger accounts + market conservation so money-path deltas
 * can be computed from primary evidence, not reconstructed from logs.
 * רץ: bun scripts/evidence-ledger-dump.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";

const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const MARKET = process.env.MARKET_BASE ?? "http://127.0.0.1:3033";
const TENANT = "market";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

function loadOperator() {
  const publicPem = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
  const kid = createHash("sha256").update(publicPem.trim()).digest("hex").slice(0, 16);
  return { agentId: "operator", publicPem, privatePem, kid };
}

import { createHash } from "crypto";

const client = new AgentClient(LEDGER, loadOperator());

const stRes = await client.get(`/state?tenantId=${TENANT}`);
if (stRes.status !== 200) {
  console.error("ledger /state →", stRes.status, JSON.stringify(stRes.json).slice(0, 200));
  process.exit(1);
}
const st = stRes.json as unknown as { accounts: { id: string; ownerId: string; type: string; balance: string }[] };
console.log("== LEDGER ACCOUNTS ==");
const relevant: Record<string, string> = {};
for (const a of st.accounts) {
  if (/^(pool|fees):/.test(a.ownerId) || /mm-|kappa|iota|theta|delta/.test(a.ownerId)) {
    console.log(a.ownerId.padEnd(24), a.type.padEnd(10), a.balance);
    relevant[a.ownerId] = a.balance;
  }
}

const rep = (await fetch(`${MARKET}/economy/report`).then((r) => r.json())) as {
  conservation: { quote: { fees: string; minted: string; inEscrow: string } };
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string }[];
};
console.log("== MARKET ==");
console.log("quote.fees =", rep.conservation.quote.fees);
let marketAgents = 0n;
for (const a of rep.agents) {
  marketAgents += BigInt(a.usds) + BigInt(a.usdsLocked) + BigInt(a.usdsStaked ?? "0");
}
console.log("Σ agents usds (free+locked+staked) =", marketAgents.toString());
const fees = BigInt(rep.conservation.quote.fees);
const ledgerFees = BigInt(relevant["fees:usds"] ?? "0");
const ledgerAgents = Object.entries(relevant)
  .filter(([k]) => k.startsWith("agent:"))
  .reduce((s, [, v]) => s + BigInt(v), 0n);
const ledgerPool = BigInt(relevant["pool:usds"] ?? "0");
console.log("ledger fees:usds =", ledgerFees.toString());
console.log("ledger Σ agent mirrors (usds, dumped subset) =", ledgerAgents.toString());
console.log("ledger pool:usds =", ledgerPool.toString());
console.log("-- derived --");
console.log("feeDelta (market − ledger) =", (fees - ledgerFees).toString());
process.exit(0);
