/**
 * kernel/fleet/sovereign-agents.ts — P2: the agents ARE the clients.
 *
 * כל-סוכן = זהות Ed25519 משלו + אסטרטגיה deterministic (PRNG מוזרע —
 * ניתן-לשחזור). הסוכן חותם על-כל-פעולה שלו מול-השוק (K5 route-auth) —
 * בדיוק כמו-לקוח חוץ, רק-שהוא הריבונות עצמה.
 *
 * אסטרטגיות (פשוטות-וכנות — המטרה היא הוכחת-המשטח, לא-אלפא):
 *   market-maker — מציב-שני-צדדים סביב-ה-mid, מבטל-פרישות-סטיות
 *   momentum     — IOC לכיוון-התנועה (לקיחת-מחיר — עובד-גם-בספר-חד-צדדי)
 *   accumulator  — פוסק-בידים-מתחת-ל-mid (קונה-ירידות)
 *   farmer       — פוסק-הצעות-מעל-ה-mid (מוכר-עליות)
 *
 * כל-הצבה מגודלת-לפי-מלאי-מוכח (capBid/capAsk) — מוכר-מוצלח לעולם לא שותק
 * בגלל-הצלחתו (באג-הספר-השקט 2026-10-19); מלאי-אפס = השמטה-כנה, לא-סירוב-נצחי.
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
  usdsStaked?: string; // own committed capital (µ¢) — sovereign agents manage it
}

export type Strategy = (view: MarketView, state: StrategyState, rnd: () => number) => Intent[];

const PRICE_STEP = 1_000n; // price tick: 0.001 µ¢/SAOS — fine-grained
const ORDER_SAOS = 5_000_000n; // 5 SAOS per quote (desired size — capped by real inventory)

/** Honest inventory floor: below this the agent is genuinely out of inventory —
 *  the truthful action is a no-op, not an eternal refusal stream. */
const MIN_ORDER = 100_000n; // 0.1 SAOS

/** Size a BID by the µ¢ the agent provably holds (cost = amount × price).
 *
 *  LIVE BUG (2026-10-19, the silent ask side): every strategy placed a FIXED
 *  size without reading the balance. A successful seller sold its inventory
 *  DOWN below that fixed size — and from that moment the engine honestly
 *  refused every order, every tick, forever. Success was punished with
 *  permanent silence: the more a seller sold, the sooner it vanished from the
 *  book. Sizing by provable inventory keeps the agent trading; null means the
 *  agent is truly out — an honest no-op, journaled as nothing, claimed as
 *  nothing. */
export function capBid(desired: bigint, usdsAvailable: string, price: bigint): bigint | null {
  if (price <= 0n) return null;
  const usds = BigInt(usdsAvailable || "0");
  // units — a bid of `amount` µ-SAOS at `price` µ¢/SAOS costs
  // amount × price / 10⁶ µ¢ (1 SAOS = 10⁶ µ-SAOS; the engine locks exactly
  // that — verified against `lock bid` transfers). Missing the 10⁶ here made
  // every bid look unaffordable: even a 12.7B µ¢ balance capped below the
  // 0.1 SAOS floor and the whole bid side went dark.
  const max = (usds * 1_000_000n) / price; // floor division — never spend money not held
  const amt = desired > max ? max : desired;
  return amt >= MIN_ORDER ? amt : null;
}

/** Size an ASK by the µ-SAOS the agent provably holds (same live-bug cure). */
export function capAsk(desired: bigint, saosAvailable: string): bigint | null {
  const saos = BigInt(saosAvailable || "0");
  const amt = desired > saos ? saos : desired;
  return amt >= MIN_ORDER ? amt : null;
}

export function marketMaker(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  const jitter = BigInt(Math.floor((rnd() - 0.5) * 4_000)); // ±0.4 µ¢/SAOS ≈ ±0.0004 USDS
  const spread = 3_000n + BigInt(Math.floor(rnd() * 5_000)); // 0.3–0.8 µ¢/SAOS
  const intents: Intent[] = [];
  for (const o of state.ownOrders) intents.push({ action: "cancel", orderId: o.id }); // refresh quotes every tick
  // genesis quotes when the book is empty; otherwise quote around the mid —
  // BOTH sides sized to provable inventory (never a fixed size over the balance)
  const midB = mid === null ? 300_000n : BigInt(Math.round(mid));
  const bidPrice = mid === null ? 298_000n : midB - spread + jitter;
  const askPrice = mid === null ? 302_000n : midB + spread + jitter;
  const bid = capBid(ORDER_SAOS, state.balances.usdsAvailable, bidPrice);
  if (bid) intents.push({ action: "place", side: "bid", price: bidPrice, amount: bid, type: "limit" });
  const ask = capAsk(ORDER_SAOS, state.balances.saosAvailable);
  if (ask) intents.push({ action: "place", side: "ask", price: askPrice, amount: ask, type: "limit" });
  return intents;
}

export function momentum(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const bestAsk = view.asks[0] ? BigInt(view.asks[0].price) : null;
  const bestBid = view.bids[0] ? BigInt(view.bids[0].price) : null;
  if (!bestAsk && !bestBid) return []; // no market at all — honest no-op
  if (rnd() < 0.5 && bestAsk) {
    const amt = capBid(1_000_000n + BigInt(Math.floor(rnd() * 2_000_000)), state.balances.usdsAvailable, bestAsk);
    if (!amt) return [];
    return [{ action: "place", side: "bid", price: bestAsk, amount: amt, type: "ioc" }];
  }
  // sell into the bid — works even when the offer side is empty (price-taking,
  // not fabrication): the OLD guard required a bestAsk to exist, so momentum
  // went fully dark exactly when the ask side died (a self-reinforcing loop).
  const price = bestBid ?? bestAsk!;
  const amt = capAsk(1_000_000n + BigInt(Math.floor(rnd() * 1_500_000)), state.balances.saosAvailable);
  if (!amt) return [];
  return [{ action: "place", side: "ask", price, amount: amt, type: "ioc" }];
}

export function accumulator(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  if (mid === null) return [];
  const midB = BigInt(Math.round(mid));
  const intents: Intent[] = [];
  for (const o of state.ownOrders) {
    // re-anchor only if mid moved far — pure BigInt drift (a fractional mid must never reach BigInt())
    const priceB = BigInt(o.price);
    const drift = priceB > midB ? priceB - midB : midB - priceB;
    if (drift > 20_000n) intents.push({ action: "cancel", orderId: o.id });
  }
  if (state.ownOrders.filter((o) => o.side === "bid").length < 2) {
    const price = midB - 15_000n - BigInt(Math.floor(rnd() * 10_000));
    const amt = capBid(2_000_000n, state.balances.usdsAvailable, price);
    if (amt) intents.push({ action: "place", side: "bid", price, amount: amt, type: "limit" });
  }
  return intents;
}

export function farmer(view: MarketView, state: StrategyState, rnd: () => number): Intent[] {
  const mid = midOf(view);
  if (mid === null) return [];
  const midB = BigInt(Math.round(mid));
  const intents: Intent[] = [];
  for (const o of state.ownOrders) {
    const priceB = BigInt(o.price);
    const drift = priceB > midB ? priceB - midB : midB - priceB;
    if (drift > 25_000n) intents.push({ action: "cancel", orderId: o.id });
  }
  if (state.ownOrders.filter((o) => o.side === "ask").length < 2) {
    const price = midB + 18_000n + BigInt(Math.floor(rnd() * 12_000));
    const amt = capAsk(2_500_000n, state.balances.saosAvailable);
    if (amt) intents.push({ action: "place", side: "ask", price, amount: amt, type: "limit" });
  }
  return intents;
}

export const STRATEGIES: Record<string, Strategy> = { marketMaker, momentum, accumulator, farmer };
void PRICE_STEP;

// ─── Sovereign capital — agents manage their OWN committed capital ──────────
// Policy: keep ~20% of own equity (free + staked USDS) committed in stake.
// Hysteresis band = 1% of equity (floor 1M µ¢) prevents churn; inside the band
// the honest answer is "no action" — a truthful no-op is evidence too.
// The agent stakes its OWN money, signed, per-tick, before trading.

export interface CapitalIntent {
  action: "stake" | "unstake";
  stakeAmount: bigint;
}

export function capitalIntents(state: StrategyState): CapitalIntent[] {
  const free = BigInt(state.balances.usdsAvailable);
  const staked = BigInt(state.usdsStaked ?? "0");
  const equity = free + staked;
  if (equity <= 0n) return [];
  const target = equity / 5n; // 20% of own equity
  const raw = equity / 100n;
  const band = raw > 1_000_000n ? raw : 1_000_000n;
  if (staked + band < target) {
    const want = target - staked;
    const amount = want <= free ? want : free; // never overcommit free money
    return amount > 0n ? [{ action: "stake", stakeAmount: amount }] : [];
  }
  if (staked - band > target) {
    const amount = staked - target;
    return amount > 0n ? [{ action: "unstake", stakeAmount: amount }] : [];
  }
  return [];
}
