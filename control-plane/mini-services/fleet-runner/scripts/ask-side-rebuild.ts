/**
 * ask-side-rebuild.ts — Task 29: re-capitalize the market-makers, honestly.
 *
 * WHY: live bug 13 (boot ghosting by age + reused order ids) drained the ask
 * side at every reboot; its sibling (the silent ask side — fixed orders sized
 * above a sold-down inventory) then kept the drained sellers permanently
 * silent. The engine root fixes are deployed (deposit-evidence ghosting +
 * attributed refunds + forever-unique order ids + inventory-aware strategies).
 * This script re-capitalizes the drained makers through the DESIGNED
 * operator-signed path (POST /economy/allocate) so real two-sided liquidity
 * can rebuild.
 *
 * LIVE BUG 16 (2026-10-19, the idem-recycling family — same lesson as live
 * bug 15): the ref used to be FIXED ("task29-ask-side-rebuild-v1"), so a
 * second run replayed the FIRST run's idem keys — http 201 + journal
 * correction records were written, but ZERO money moved, and the script
 * reported success. A grant record without money behind it is a lie in the
 * journal. Cure, three layers:
 *   1. the ref carries a unique RUN_ID — every run is a new, signed, journaled
 *      decision (re-running the SAME decision deliberately = new ref),
 *   2. grants are CALIBRATED to the live shortfall (target minus current
 *      free balance) — an agent already at target is skipped honestly,
 *   3. POST-VERIFICATION: after the grants, the script re-reads the live
 *      balances and PROVES each agent's SAOS grew by the granted amount —
 *      a grant that did not move money fails the run loudly (exit 1).
 *
 * Calibration: modest targets vs live holdings — no supply shock. Integer
 * µ-unit strings only (decimal strings hit the parseMicroCents 10⁴ trap of
 * Task 27).
 *
 * Run: bun scripts/ask-side-rebuild.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { AgentKeys } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

/** unique per run — a re-run is a NEW operator decision, never an idem replay
 *  of a previous grant (live bug 16: a fixed ref made run #2 a silent no-op
 *  that journaled correction records with no money behind them). */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const REF = `task29-ask-side-rebuild-v2-${RUN_ID}`;

/** (agentId, target free SAOS µ-SAOS) — the grant tops up to the target,
 *  calibrated against the LIVE balance (integer µ-SAOS strings only). */
const TARGETS: { id: string; saosTarget: string; note: string }[] = [
  { id: "iota",  saosTarget: "25000000", note: "maker re-capitalization (ghost victim; sold its inventory honestly since)" },
  { id: "kappa", saosTarget: "25000000", note: "maker re-capitalization (ghost victim; sold its inventory honestly since)" },
  { id: "delta", saosTarget: "20000000", note: "maker re-capitalization (125M µ-SAOS ghost victim)" },
  { id: "alpha", saosTarget: "10000000", note: "maker re-capitalization (sold down below its own fixed size — the silent ask side)" },
];

function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

const operator = loadKeys("operator");
const op = new AgentClient(BASE, operator);

type Report = {
  agents: { agentId: string; usds: string; saos: string; saosLocked: string }[];
  conservation: { quote: { holds: boolean; minted: string }; base: { holds: boolean; minted: string } };
};
const report = async (): Promise<Report> =>
  (await (await fetch(`${BASE}/economy/report`)).json()) as Report;

const pre = await report();
const freeSaos = new Map(pre.agents.map((a) => [a.agentId, BigInt(a.saos)]));
console.log(`before: SAOS minted=${pre.conservation.base.minted} holds=${pre.conservation.base.holds} · ref=${REF}`);

// ── calibrate: grant only the live shortfall, skip agents already at target ──
const grants: { id: string; saos: string; note: string }[] = [];
for (const t of TARGETS) {
  const current = freeSaos.get(t.id);
  if (current === undefined) {
    console.error(`  ${t.id}: not registered on the market — skipping honestly (no agent, no grant)`);
    continue;
  }
  const shortfall = BigInt(t.saosTarget) - current;
  if (shortfall <= 0n) {
    console.log(`  ${t.id}: free ${current} µ-SAOS ≥ target ${t.saosTarget} — no grant needed (honest skip)`);
    continue;
  }
  grants.push({ id: t.id, saos: shortfall.toString(), note: t.note });
}
if (grants.length === 0) {
  console.log("ASK-SIDE-REBUILD-OK: every target agent already holds its target inventory — nothing to grant, nothing claimed");
  process.exit(0);
}

let applied = 0;
for (const g of grants) {
  const before = freeSaos.get(g.id)!;
  console.log(`  ${g.id}: free ${before} µ-SAOS → granting ${g.saos} µ-SAOS (${g.note})`);
  const r = await op.post("/economy/allocate", { agentId: g.id, usds: "0", saos: g.saos, ref: REF });
  if (r.status !== 201) {
    console.error(`    → REFUSED http ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    process.exit(1); // fail-closed: a re-capitalization we cannot complete honestly is loud
  }
  applied++;
  console.log(`    → 201 accepted (ref ${REF})`);
}

// ── post-verification: PROVE the money actually moved (live bug 16 guard) ────
const post = await report();
const postFree = new Map(post.agents.map((a) => [a.agentId, BigInt(a.saos)]));
let verified = 0;
for (const g of grants) {
  const before = freeSaos.get(g.id)!;
  const after = postFree.get(g.id) ?? -1n;
  if (after - before !== BigInt(g.saos)) {
    console.error(`    POST-VERIFY FAILED for ${g.id}: free ${before} → ${after}, expected ${before} + ${g.saos}. A grant that moved no money was journaled — THIS IS LIVE BUG 16's SHAPE. Loud failure.`);
    process.exit(1);
  }
  verified++;
  console.log(`    post-verify ${g.id}: ${before} → ${after} ✓ (money provably moved)`);
}

console.log(`after: SAOS minted ${pre.conservation.base.minted} → ${post.conservation.base.minted} holds=${post.conservation.base.holds}`);
if (!post.conservation.base.holds) {
  console.error("CONSERVATION-VIOLATION after re-capitalization — loud failure");
  process.exit(1);
}
console.log(`ASK-SIDE-REBUILD-OK (${verified}/${grants.length} grants applied AND verified, ref ${REF})`);
