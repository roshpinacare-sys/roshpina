/**
 * task29-unit-correction.ts — Task 29: honest correction of the ×10⁴ unit trap.
 *
 * WHAT HAPPENED (full disclosure): ask-side-rebuild.ts sent usds amounts as
 * µ¢ integers ("8000000"), but the /economy/allocate contract parses USDS
 * strings in CENT units (parseMicroCents: "1.00" = 10,000 µ¢ = 0.01 USDS) —
 * so each 8-USDS intent minted 80,000 USDS (×10⁴). The SAOS side was correct
 * (µ-SAOS direct). Result: USDS minted 238,112,919 → 290,238,112,919 µ¢.
 *
 * THE FIX (this script): burn the exact over-mint per maker through the
 * DESIGNED contraction path — operator-signed NEGATIVE realloc → guardWithdraw
 * into the platform reserve. Burn is computed LIVE: current_free − target,
 * where target = pre-grant free + intended grant. Idempotent by ref.
 *
 * Run: bun scripts/task29-unit-correction.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { AgentKeys } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

/** target_free_µ¢ = free balance measured immediately BEFORE the grants
 *  (ask-side-rebuild output) + the intended grant (8 USDS = 8,000,000 µ¢;
 *  delta 5 USDS = 5,000,000 µ¢). */
const TARGETS: { id: string; preGrant: bigint; intended: bigint }[] = [
  { id: "iota",  preGrant: 1_999_602n, intended: 8_000_000n },
  { id: "kappa", preGrant: 1_999_602n, intended: 8_000_000n },
  { id: "theta", preGrant: 142_160n,   intended: 8_000_000n },
  { id: "delta", preGrant: 2_200n,     intended: 5_000_000n },
];

/** µ¢ → exact cent-unit string for parseMicroCents ("123456789" → "12345.6789"). */
function uToCents(µ: bigint): string {
  const neg = µ < 0n;
  const a = neg ? -µ : µ;
  const q = a / 10000n, r = a % 10000n;
  const s = r === 0n ? `${q}` : `${q}.${r.toString().padStart(4, "0")}`;
  return neg ? `-${s}` : s;
}

function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

const op = new AgentClient(BASE, loadKeys("operator"));

const before = (await (await fetch(`${BASE}/economy/report`)).json()) as {
  agents: { agentId: string; usds: string }[];
  conservation: { quote: { minted: string; holds: boolean } };
};
const free = new Map(before.agents.map((a) => [a.agentId, BigInt(a.usds)]));
const mintedBefore = BigInt(before.conservation.quote.minted);
console.log(`before: USDS minted=${mintedBefore} µ¢ holds=${before.conservation.quote.holds}`);

const REF = "task29-unit-correction-v1";
let totalBurn = 0n;
const results: { id: string; burned: bigint; target: bigint; post?: bigint }[] = [];
for (const t of TARGETS) {
  const cur = free.get(t.id);
  if (cur === undefined) { console.error(`agent ${t.id} missing — aborting`); process.exit(1); }
  const target = t.preGrant + t.intended;
  const burn = cur - target;
  if (burn < 0n) {
    console.error(`  ${t.id}: free ${cur} < target ${target} — capital was deployed/lost before correction; refusing to fabricate. Investigate.`);
    process.exit(1); // fail-closed: we do not burn into a moving target blindly
  }
  if (burn === 0n) { console.log(`  ${t.id}: already at target ${target} µ¢ (idempotent rerun) — skip`); results.push({ id: t.id, burned: 0n, target }); continue; }
  const cents = uToCents(-burn);
  console.log(`  ${t.id}: free ${cur} → target ${target} µ¢; burning ${burn} µ¢ (realloc usds ${cents} cents)`);
  const r = await op.post("/economy/allocate", { agentId: t.id, usds: cents, saos: "0", ref: REF });
  if (r.status !== 201) {
    console.error(`    → REFUSED http ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    process.exit(1); // fail-closed
  }
  totalBurn += burn;
  results.push({ id: t.id, burned: burn, target });
}

const post = (await (await fetch(`${BASE}/economy/report`)).json()) as typeof before;
const mintedAfter = BigInt(post.conservation.quote.minted);
console.log(`after: USDS minted=${mintedAfter} µ¢ holds=${post.conservation.quote.holds}`);

let bad = 0;
for (const r of results) {
  const now = BigInt(post.agents.find((a) => a.agentId === r.id)!.usds);
  r.post = now;
  if (now !== r.target) { console.error(`  DRIFT ${r.id}: post=${now} target=${r.target} (economy moved during correction)`); bad++; }
  else console.log(`  ${r.id}: ${now} µ¢ ✓ exact target`);
}
if (!post.conservation.quote.holds) { console.error("CONSERVATION VIOLATED"); bad++; }
if (bad > 0) { console.error("UNIT-CORRECTION-DRIFTED — numbers above are the truth; rerun after inspecting"); process.exit(1); }
console.log(`UNIT-CORRECTION-OK — burned ${totalBurn} µ¢ total; minted ${mintedBefore} → ${mintedAfter}; supply restored, all signed + journaled (ref ${REF})`);
