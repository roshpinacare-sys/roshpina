/**
 * fleet-expand.ts — Task 27: grow the sovereign trading fleet, honestly.
 *
 * Registers NEW soldier agents with CALIBRATED allocations (comparable to the
 * existing members — no supply shock) + fresh local dev keys, operator-signed.
 * Idempotent: existing agents are skipped; reruns never double-mint.
 *
 * Every registration is: operator Ed25519-signed → journaled mint → principal
 * persisted (principals.json). The new soldiers auto-join every economy-run
 * (licensed-member logic) — real capital, real orders, real fills.
 *
 * Run: bun scripts/fleet-expand.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { generateKeyPairSync } from "node:crypto";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { AgentKeys } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

/** Calibrated allocation — in line with the live members (alpha≈1.4 USDS free,
 *  eta≈4.2, gamma≈16.3; SAOS holdings 16–133). Small, honest, no supply shock. */
const SOLDIERS: { id: string; usds: string; saos: string }[] = [
  { id: "theta", usds: "2.00", saos: "10000000" },  // 2 USDS + 10 SAOS
  { id: "iota",  usds: "2.00", saos: "10000000" },
  { id: "kappa", usds: "2.00", saos: "10000000" },
];

function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

function ensureKeys(id: string): void {
  if (existsSync(join(KEYS_DIR, `${id}.priv.pem`)) && existsSync(join(KEYS_DIR, `${id}.pub.pem`))) return;
  mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(KEYS_DIR, `${id}.pub.pem`), publicKey.export({ type: "spki", format: "pem" }).toString());
  writeFileSync(join(KEYS_DIR, `${id}.priv.pem`), privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

const operator = loadKeys("operator");
const op = new AgentClient(BASE, operator);

const pre = (await (await fetch(`${BASE}/economy/report`)).json()) as {
  agents: { agentId: string }[];
  conservation: { quote: { minted: string }; base: { minted: string } };
};
const existing = new Set(pre.agents.map((a) => a.agentId));
console.log(`fleet before: ${pre.agents.length} members; USDS minted=${pre.conservation.quote.minted} SAOS minted=${pre.conservation.base.minted}`);

let added = 0;
for (const s of SOLDIERS) {
  if (existing.has(s.id)) {
    console.log(`  soldier ${s.id}: already enlisted — skipping (idempotent)`);
    continue;
  }
  ensureKeys(s.id);
  const keys = loadKeys(s.id);
  const r = await op.post("/agents", { agentId: s.id, usds: s.usds, saos: s.saos, publicPem: keys.publicPem });
  if (r.status === 201) {
    added++;
    console.log(`  soldier ${s.id}: enlisted → 201 (${s.usds} USDS + ${Number(s.saos) / 1e6} SAOS allocated, key licensed ${keys.kid})`);
  } else {
    console.error(`  soldier ${s.id}: REFUSED → http ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    process.exit(1); // fail-closed: an enlistment we cannot complete honestly is loud
  }
}

const post = (await (await fetch(`${BASE}/economy/report`)).json()) as {
  agents: { agentId: string; usds: string; saos: string; fills: number }[];
  conservation: { quote: { holds: boolean; minted: string }; base: { holds: boolean; minted: string } };
};
console.log(`fleet after: ${post.agents.length} members (${added} newly enlisted)`);
console.log(`conservation: USDS minted ${pre.conservation.quote.minted} → ${post.conservation.quote.minted} holds=${post.conservation.quote.holds}`);
console.log(`              SAOS minted ${pre.conservation.base.minted} → ${post.conservation.base.minted} holds=${post.conservation.base.holds}`);
if (!post.conservation.quote.holds || !post.conservation.base.holds) {
  console.error("CONSERVATION-VIOLATION after enlistment — loud failure");
  process.exit(1);
}
console.log("FLEET-EXPAND-OK");
