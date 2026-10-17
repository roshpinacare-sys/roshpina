/**
 * kernel/fleet/sovereign-agents.ts — P2: the agents ARE the clients.
 *
 * כל-סוכן = זהות Ed25519 משלו + אסטרטגיה deterministic (PRNG מוזרע —
 * ניתן-לשחזור). הסוכן חותם על-כל-פעולה שלו מול-השוק (K5 route-auth) —
 * בדיוק כמו-לקוח חוץ, רק-שהוא הריבונות עצמה.
 *
 * אסטרטגיות (פשוטות-וכנות — המטרה היא הוכחת-המשטח, לא-אלפא):
 *   market-maker — מציב-שני-צדדים סביב-ה-mid, מבטל-פרישות-סטיות
 *   momentum     — IOC לכיוון-התנועה כשיש-נפח
 *   accumulator  — פוסק-בידים-מתחת-ל-mid (קונה-ירידות)
 *   farmer       — פוסק-הצעות-מעל-ה-mid (מוכר-עליות)
 */

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { sha256Hex, canonicalRoutePayload } from "../../src/lib/route-auth";

export interface AgentKeys {
  agentId: string;
  publicPem: string;
  privatePem: string;
  kid: string; // computed on the NORMALIZED pem — must match the server's provisioning
}

export function generateAgent(agentId: string): AgentKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const kid = sha256Hex(publicPem.trim()).slice(0, 16); // same normalization as provisionOperatorKeys
  return { agentId, publicPem, privatePem, kid };
}

/** Signed HTTP client — the agent's own hand. */
export class AgentClient {
  constructor(readonly base: string, readonly keys: AgentKeys) {}

  private headers(method: string, pathname: string, body: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const payload = canonicalRoutePayload(this.keys.kid, method, pathname, timestamp, sha256Hex(body));
    const signature = edSign(null, Buffer.from(payload), this.keys.privatePem).toString("base64");
    return {
      "content-type": "application/json",
      "x-roshpina-kid": this.keys.kid,
      "x-roshpina-timestamp": timestamp,
      "x-roshpina-signature": signature,
    };
  }

  async post(pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const raw = JSON.stringify(body);
    const res = await fetch(this.base + pathname, { method: "POST", headers: this.headers("POST", pathname, raw), body: raw });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async get(pathname: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(this.base + pathname, { headers: this.headers("GET", pathname, "") });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
}

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Market view (what an agent sees) ────────────────────────────────────────

export interface MarketView {
  bids: { price: string; amount: string; agentId: string; id: string }[];
  asks: { price: string; amount: string; agentId: string; id: string }[];
}

export function midOf(view: MarketView): number | null {
  const bestBid = view.bids[0] ? BigInt(view.bids[0].price) : null;
  const bestAsk = view.asks[0] ? BigInt(view.asks[0].price) : null;
  if (bestBid && bestAsk) return Number(bestBid + bestAsk) / 2;
  return bestBid !== null ? Number(bestBid) : bestAsk !== null ? Number(bestAsk) : null;
}

// ─── Strategies ──────────────────────────────────────────────────────────────

export interface Intent {
  action: "place" | "cancel";
  orderId?: string;
  side?: "bid" | "ask";
  price?: bigint; // µ¢ per SAOS
  amount?: bigint; // µ-SAOS
  type?: "limit" | "postOnly" | "ioc";
}

export interface StrategyState {
  agentId: string;
  tick: number;
  ownOrders: { id: string; side: "bid" | "ask"; price: string; amount: string }[];
  balances: { usdsAvailable: string; saosAvailable: string };
}

export type Strategy = (view: MarketView, state: StrategyState, rnd: () => number) => Intent[];

const PRICE_STEP = 1_000n; // price tick: 0.001 µ¢/SAOS — fine-grained
const ORDER_SAOS = 5_000_000n; // 5 SAOS per quote

export function marketMaker(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  if (mid === null) return [{ action: "place", side: "bid", price: 298_000n, amount: ORDER_SAOS, type: "limit" }, { action: "place", side: "ask", price: 302_000n, amount: ORDER_SAOS, type: "limit" }];
  const jitter = BigInt(Math.floor((rnd() - 0.5) * 4_000)); // ±0.4 µ¢/SAOS ≈ ±0.0004 USDS
  const spread = 3_000n + BigInt(Math.floor(rnd() * 5_000)); // 0.3–0.8 µ¢/SAOS
  const intents: Intent[] = [];
  for (const o of state.ownOrders) intents.push({ action: "cancel", orderId: o.id }); // refresh quotes every tick
  const midB = BigInt(Math.round(mid));
  intents.push({ action: "place", side: "bid", price: midB - spread + jitter, amount: ORDER_SAOS, type: "limit" });
  intents.push({ action: "place", side: "ask", price: midB + spread + jitter, amount: ORDER_SAOS, type: "limit" });
  return intents;
}

export function momentum(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const bestAsk = view.asks[0] ? BigInt(view.asks[0].price) : null;
  const bestBid = view.bids[0] ? BigInt(view.bids[0].price) : null;
  if (!bestAsk || !bestBid) return [];
  if (rnd() < 0.5) {
    return [{ action: "place", side: "bid", price: bestAsk, amount: 1_000_000n + BigInt(Math.floor(rnd() * 2_000_000)), type: "ioc" }];
  }
  return [{ action: "place", side: "ask", price: bestBid, amount: 1_000_000n + BigInt(Math.floor(rnd() * 1_500_000)), type: "ioc" }];
}

export function accumulator(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  if (mid === null) return [];
  const midB = BigInt(Math.round(mid));
  const intents: Intent[] = [];
  for (const o of state.ownOrders) {
    // re-anchor only if mid moved far
    if (BigInt(Math.abs(Number(BigInt(o.price)) - mid)) > 20_000) intents.push({ action: "cancel", orderId: o.id });
  }
  if (state.ownOrders.filter((o) => o.side === "bid").length < 2) {
    intents.push({ action: "place", side: "bid", price: midB - 15_000n - BigInt(Math.floor(rnd() * 10_000)), amount: 2_000_000n, type: "limit" });
  }
  return intents;
}

export function farmer(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  if (mid === null) return [];
  const midB = BigInt(Math.round(mid));
  const intents: Intent[] = [];
  for (const o of state.ownOrders) {
    if (BigInt(Math.abs(Number(BigInt(o.price)) - mid)) > 25_000) intents.push({ action: "cancel", orderId: o.id });
  }
  if (state.ownOrders.filter((o) => o.side === "ask").length < 2) {
    intents.push({ action: "place", side: "ask", price: midB + 18_000n + BigInt(Math.floor(rnd() * 12_000)), amount: 2_500_000n, type: "limit" });
  }
  return intents;
}

export const STRATEGIES: Record<string, Strategy> = { marketMaker, momentum, accumulator, farmer };
void PRICE_STEP;
