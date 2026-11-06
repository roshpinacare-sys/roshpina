/**
 * agent-license.ts — the network licenses a NEW member, end-to-end, for real:
 *
 *   1. new Ed25519 identity generated locally (data/keys/<id>.pem — dev-only, gitignored)
 *   2. operator signs POST /agents on the LIVE market node (:3033) WITH the member's public key
 *      → the principal is live immediately and persists via principals.json (survives restarts)
 *   3. first signature roundtrip: GET /agent/me signed by the NEW key — the identity is proven, not claimed
 *
 * fail-closed: existing key files are never overwritten; a taken agentId is refused;
 * a market that is down is refused. אין-קיצורי-דרך, אין-כספות, אין-PAT.
 *
 * רץ: bun scripts/agent-license.ts <agentId>
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { generateAgent, AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

const agentId = String(process.argv[2] ?? "");
if (!/^[a-z][a-z0-9-]{1,15}$/.test(agentId)) {
  console.error(`agent-license: agentId must match ^[a-z][a-z0-9-]{1,15}$ — got: "${agentId.slice(0, 40)}"`);
  process.exit(1);
}

// 0) the market must be alive — nothing is licensed against a dead node
const health = await fetch(BASE + "/health", { signal: AbortSignal.timeout(3000) });
if (!health.ok) {
  console.error(`agent-license: market node not healthy: http ${health.status}`);
  process.exit(1);
}

// 1) fail-closed on existing identity files — keys are never overwritten
const pubPath = join(KEYS_DIR, `${agentId}.pub.pem`);
const privPath = join(KEYS_DIR, `${agentId}.priv.pem`);
if (existsSync(pubPath) || existsSync(privPath)) {
  console.error(`agent-license: key files for "${agentId}" already exist — refusing (fail-closed, keys are never overwritten)`);
  process.exit(1);
}

// 2) generate the new sovereign identity locally
const keys = generateAgent(agentId);
writeFileSync(pubPath, keys.publicPem);
writeFileSync(privPath, keys.privatePem);
chmodSync(pubPath, 0o600);
chmodSync(privPath, 0o600);
console.log(`  identity ${agentId}: Ed25519 generated locally (kid ${keys.kid}, pem 0600, gitignored)`);

// 3) operator signs the license — the member joins WITH its public key (live principal)
const operatorPem = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
const operatorPub = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
const opClient = new AgentClient(BASE, { agentId: "operator", publicPem: operatorPub, privatePem: operatorPem, kid: sha256Hex(operatorPub.trim()).slice(0, 16) });

const res = await opClient.post("/agents", {
  agentId,
  usds: "5000.00",
  saos: "100000000",
  publicPem: keys.publicPem,
});
if (res.status !== 201) {
  console.error(`agent-license: market refused the license: http ${res.status} ${JSON.stringify(res.json).slice(0, 240)}`);
  console.error("  (the local key files stay on disk — remove them manually to retry a different name)");
  process.exit(1);
}
const principal = String(res.json.principal ?? "absent");
console.log(`  license ${agentId}: operator-signed POST /agents → 201 (allocation 5000.00 USDS + 100 SAOS · principal: ${principal})`);

// 4) proof — the NEW key signs a real roundtrip; identity is demonstrated, not asserted
const client = new AgentClient(BASE, keys);
const me = await client.get("/agent/me");
if (me.status !== 200) {
  console.error(`agent-license: first signature roundtrip failed: http ${me.status} ${JSON.stringify(me.json).slice(0, 200)}`);
  process.exit(1);
}
const bal = me.json as unknown as { agentId?: string; usdsAvailable?: string; saosAvailable?: string };
console.log(`  proof ${agentId}: GET /agent/me signed by the NEW key → 200 (agentId=${bal.agentId} · usds=${bal.usdsAvailable} · saos=${bal.saosAvailable})`);

console.log("\nAGENT-LICENSE-OK · הרשת רישמה-חבר-חדש בעצמה: זהות-מקומית + רישום-חתום + הוכחת-חתימה-חיה");
console.log(`  החבר יצטרף-אוטומטית-למסחר בריצת-הכלכלה המתוזמנת הבאה (fleet: ליבה + רישיונות)`);
