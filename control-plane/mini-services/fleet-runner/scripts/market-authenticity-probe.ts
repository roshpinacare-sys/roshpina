/**
 * market-authenticity-probe.ts — Task 27: LIVE fail-closed probes against the real
 * market node, proving the exchange is genuine (no forgery paths). Units:
 * amount is μ-SAOS (1e6 = 1 SAOS), price is μ¢ per SAOS → notional μ¢ = amount×price/1e6.
 *
 *   P1  unsigned order        → REFUSED (no anonymous trading)
 *   P2  forged signature      → REFUSED (no impersonation)
 *   P3  over-sell (short)     → REFUSED INSUFFICIENT_BASE (no thin-air SAOS)
 *   P4  over-buy (no USDS)    → REFUSED INSUFFICIENT_QUOTE (escrow enforces funding)
 *   P5  garbage price         → REFUSED 400 (input guards)
 *   P6  conservation before/after → holds (probes wrote nothing)
 *
 * Honest probes only: every expected refusal is EVIDENCE of integrity.
 * Run: bun scripts/market-authenticity-probe.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { AgentKeys } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const BASE = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");

function loadKeys(id: string): AgentKeys {
  const publicPem = readFileSync(join(KEYS_DIR, `${id}.pub.pem`), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, `${id}.priv.pem`), "utf8");
  return { agentId: id, publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail}`); }
};

const alpha = new AgentClient(BASE, loadKeys("alpha"));
const bravo = new AgentClient(BASE, loadKeys("bravo"));

interface Rep { conservation: { quote: { holds: boolean }; base: { holds: boolean } } }
const report = async (): Promise<Rep> => (await (await fetch(`${BASE}/economy/report`)).json()) as Rep;

const before = await report();
console.log(`baseline: conservation q=${before.conservation.quote.holds} b=${before.conservation.base.holds}`);

// ── P1: unsigned order ───────────────────────────────────────────────────────
{
  const res = await fetch(`${BASE}/market/order`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ side: "ask", price: "250000", amount: "1000" }),
  });
  const body = (await res.json()) as { code?: string };
  check("P1 unsigned order refused", res.status === 401, `HTTP ${res.status} ${body.code ?? ""}`);
}

// ── P2: forged signature (valid-format base64 garbage) ──────────────────────
{
  const timestamp = new Date().toISOString();
  const res = await fetch(`${BASE}/market/order`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-roshpina-kid": loadKeys("bravo").kid, "x-roshpina-timestamp": timestamp, "x-roshpina-signature": "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9" },
    body: JSON.stringify({ side: "ask", price: "250000", amount: "1000", orderId: `probe-forged-${Date.now()}` }),
  });
  check("P2 forged signature refused", !res.ok && res.status === 401, `HTTP ${res.status}`);
}

// ── P3: over-sell — alpha asks 200 SAOS while holding ~106.3 μ-SAOS×1e2 ─────
{
  // saosAvailable ~106,293,050 μ-SAOS → ask 200,000,000 μ-SAOS (=200 SAOS) > holdings
  const r = await alpha.post("/market/order", { side: "ask", price: "250000", amount: "200000000", orderId: `probe-oversell-${Date.now()}` });
  const code = String(r.json.code ?? r.json.error ?? "");
  check("P3 over-sell refused (no thin-air SAOS)", r.status === 400 && code.includes("INSUFFICIENT"), `HTTP ${r.status} ${code.slice(0, 60)}`);
}

// ── P4: over-buy — need = price×amount/1e6 ≫ alpha's USDS ───────────────────
{
  // price 257,273 μ¢ × 100,000,000 μ-SAOS → need 25,727,300 μ¢ vs ~1.39M μ¢ held
  const r = await alpha.post("/market/order", { side: "bid", price: "257273", amount: "100000000", orderId: `probe-overbuy-${Date.now()}` });
  const code = String(r.json.code ?? r.json.error ?? "");
  check("P4 over-buy refused (escrow enforces funding)", r.status === 400 && code.includes("INSUFFICIENT"), `HTTP ${r.status} ${code.slice(0, 60)}`);
}

// ── P5: garbage price ────────────────────────────────────────────────────────
{
  const r = await alpha.post("/market/order", { side: "ask", price: "-5", amount: "10", orderId: `probe-bad-${Date.now()}` });
  check("P5 negative price refused", r.status === 400, `HTTP ${r.status}`);
}

// ── P6: conservation unchanged ───────────────────────────────────────────────
{
  const after = await report();
  check("P6 conservation holds after probes", after.conservation.quote.holds && after.conservation.base.holds, `q=${after.conservation.quote.holds} b=${after.conservation.base.holds}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
