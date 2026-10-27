/**
 * repair-stake.ts — one-off operator-signed correction for the restart-reserve bug
 * (caught live 2026-10-17). Brings every NEGATIVE stake account back to exactly
 * zero, sourced from the mint reserve, via /economy/correct — idempotent, journaled.
 *
 * רץ: bun scripts/repair-stake.ts <agentId> [correctionId]
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

const agentId = String(process.argv[2] ?? "");
if (!/^[a-z][a-z0-9]{1,15}$/.test(agentId)) {
  console.error(`repair-stake: agentId must match ^[a-z][a-z0-9]{1,15}$ — got: "${agentId.slice(0, 40)}"`);
  process.exit(1);
}
const correctionId = String(process.argv[3] ?? `repair-${Date.now().toString(36)}`);

const publicPem = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
const privatePem = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
const op = new AgentClient(BASE, { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) });

const res = await op.post("/economy/correct", { agentId, correctionId });
console.log(`correction ${agentId} (${correctionId}): http ${res.status} ${JSON.stringify(res.json).slice(0, 240)}`);
if (res.status !== 200) process.exit(1);
console.log("REPAIR-STAKE-OK");
