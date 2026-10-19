/**
 * kernel/market/book.ts — P2: the sovereign order book (BigInt-exact).
 *
 * זהו ספר-זמנות אמיתי לכלכלת-הסוכנים הריבונית: הסוכנים הם הלקוחות והמשתמשים.
 * העיצוב (price-time priority, מילויים-חלקיים, מניעת-מסחר-עצמי, postOnly/IOC,
 * escrow-lock לפני-קבלה) מותאם ממנוע הזמנות saos-dex (roshpinacare-sys/saos-dex
 * audit-package/src/book.ts) — עם הפגם שנמדד בביקורת מתוקן-מבנית: notional
 * כאן מחושב BigInt-על-BigInt בלי-שום-float, אף-פעם.
 *
 * יחידות (מודל tick-size סטנדרטי, כמו בורסות-אמת):
 *   price  = BigInt µ¢ per 1 SAOS שלם  (לדוגמה: 30 USDS/SAOS = 30_000_000n)
 *   amount = BigInt µ-SAOS             (1 SAOS = 1_000_000 µ-SAOS)
 *   notional(µ¢) = price × amount / 1_000_000  (חלוקה-שלמה עם שארית-אבק
 *                  מפורשת שנרשמת ב-fill — לעולם לא נזרקת בשקט; הקונה
 *                  משלם notional+remainder, ה-maker מקבל אותם פחות עמלה)
 *
 * הספר אינו נוגע בכסף: הוא מנפיק LockIntent/FillPlan — שכבת-ה-settlement
 * (מעליו) מבצעת נגד הספרים. כל-פעולה deterministic: אותו-קלט = אותו-פלט.
 */

// ─── Errors ──────────────────────────────────────────────────────────────────

export class BookError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BookError";
    this.code = code;
  }
}

// ─── Units ───────────────────────────────────────────────────────────────────

/** µ-SAOS per 1 SAOS — also the divisor converting price×amount µ¢-products. */
export const MICRO = 1_000_000n;

// ─── Types ───────────────────────────────────────────────────────────────────

export type Side = "bid" | "ask";

export interface Order {
  id: string;
  agentId: string;
  side: Side;
  price: bigint;   // µ¢ per µ-SAOS
  amount: bigint;  // µ-SAOS (total)
  filled: bigint;  // µ-SAOS
  locked: bigint;  // µ-SAOS (ask) or µ¢ (bid) locked in market escrow
  createdAt: number;
  seq: number;     // book sequence (price-time tiebreak)
}

export interface Fill {
  tradeId: string;
  seq: number;
  price: bigint;     // µ¢ per µ-SAOS (the MAKER's price — price-time law)
  amount: bigint;    // µ-SAOS
  notional: bigint;  // µ¢ = price*amount/MICRO (floor)
  remainder: bigint; // µ¢ = price*amount % MICRO — recorded, never dropped silently
  makerId: string;
  makerOrderId: string;
  takerId: string;
  takerOrderId: string;
  side: Side;        // the TAKER's side
}

export interface LockIntent {
  agentId: string;
  /** Which asset gets locked: bids lock QUOTE (µ¢), asks lock BASE (µ-SAOS). */
  asset: "quote" | "base";
  amount: bigint;
  orderId: string;
}

export interface PlaceResult {
  order: Order;
  /** Locks required BEFORE the order may rest (fail-closed settlement). */
  lock?: LockIntent;
  fills: Fill[];
  /** Refund of over-lock after fills (taker locked full, consumed less). */
  unlock?: LockIntent;
}

export interface MatchPolicy {
  /** self-trade: "refuse" (default) rejects the incoming order loudly. */
  selfTrade: "refuse";
  /** max levels crossed per placement (deterministic bound). */
  maxDepth: number;
}

const DEFAULT_POLICY: MatchPolicy = { selfTrade: "refuse", maxDepth: 10_000 };

// ─── Guards ──────────────────────────────────────────────────────────────────

function guardOrderInput(agentId: string, side: Side, price: bigint, amount: bigint): void {
  if (!agentId || typeof agentId !== "string") throw new BookError("agentId required", "BAD_AGENT");
  if (side !== "bid" && side !== "ask") throw new BookError("side must be bid|ask", "BAD_SIDE");
  if (typeof price !== "bigint" || price <= 0n) throw new BookError("price must be positive BigInt µ¢", "BAD_PRICE");
  if (typeof amount !== "bigint" || amount <= 0n) throw new BookError("amount must be positive BigInt µ-SAOS", "BAD_AMOUNT");
}

/** floor(price[µ¢/SAOS] × amount[µ-SAOS] / 1_000_000) with explicit remainder — the anti-float law. */
export function notionalOf(price: bigint, amount: bigint): { notional: bigint; remainder: bigint } {
  const product = price * amount; // BigInt — cannot overflow silently
  return { notional: product / MICRO, remainder: product % MICRO };
}

// ─── The Book ────────────────────────────────────────────────────────────────

export class OrderBook {
  private bids: Order[] = []; // sorted: price DESC, then seq ASC
  private asks: Order[] = []; // sorted: price ASC, then seq ASC
  private seqCounter = 0;
  private tradeCounter = 0;
  readonly policy: MatchPolicy;

  constructor(policy: Partial<MatchPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  stats(): { bids: number; asks: number; bestBid: bigint | null; bestAsk: bigint | null; trades: number } {
    return {
      bids: this.bids.length,
      asks: this.asks.length,
      bestBid: this.bids[0]?.price ?? null,
      bestAsk: this.asks[0]?.price ?? null,
      trades: this.tradeCounter,
    };
  }

  /** Live order by id (either side). */
  getOrder(id: string): Order | null {
    return this.bids.find((o) => o.id === id) ?? this.asks.find((o) => o.id === id) ?? null;
  }

  allOrders(): Order[] {
    return [...this.bids, ...this.asks].map((o) => ({ ...o }));
  }

  private nextSeq(): number {
    return ++this.seqCounter;
  }

  private insert(side: Side, order: Order): void {
    const list = side === "bid" ? this.bids : this.asks;
    const better = side === "bid"
      ? (a: Order, b: Order) => a.price > b.price || (a.price === b.price && a.seq < b.seq)
      : (a: Order, b: Order) => a.price < b.price || (a.price === b.price && a.seq < b.seq);
    let i = 0;
    while (i < list.length && better(list[i], order)) i++;
    list.splice(i, 0, order);
  }

  private remove(side: Side, id: string): Order | null {
    const list = side === "bid" ? this.bids : this.asks;
    const i = list.findIndex((o) => o.id === id);
    if (i === -1) return null;
    return list.splice(i, 1)[0];
  }

  /**
   * Place a limit order. CONTRACT: the engine journals the intent + executes
   * locks via settlement BEFORE calling place(); if settlement cannot lock,
   * place() is never reached (fail-closed). place() mutates the book and
   * returns fills — deterministic given the same resting state + seq.
   */
  place(params: {
    id: string;
    agentId: string;
    side: Side;
    price: bigint;
    amount: bigint;
    type?: "limit" | "postOnly" | "ioc";
  }): PlaceResult {
    const { id, agentId, side, price, amount } = params;
    const type = params.type ?? "limit";
    guardOrderInput(agentId, side, price, amount);
    if (this.getOrder(id)) throw new BookError(`order id ${id} already on the book`, "DUPLICATE_ORDER_ID");

    const order: Order = { id, agentId, side, price, amount, filled: 0n, locked: 0n, createdAt: Date.now(), seq: this.nextSeq() };

    // Self-trade prevention: would the taker cross its OWN resting order?
    const opposite = side === "bid" ? this.asks : this.bids;
    const crossesOwn = opposite.some((o) =>
      (side === "bid" ? o.price <= price : o.price >= price) && o.agentId === agentId,
    );
    if (crossesOwn && this.policy.selfTrade === "refuse") {
      throw new BookError(
        `order ${id} would cross agent ${agentId}'s own resting order — self-trade refused (fail-closed)`,
        "SELF_TRADE_REFUSED",
      );
    }

    // postOnly: refuse if it would cross anything at all
    if (type === "postOnly" && opposite.length > 0) {
      const crosses = side === "bid" ? this.asks[0].price <= price : this.bids[0].price >= price;
      if (crosses) throw new BookError("postOnly order would cross — refused (maker-only law)", "POST_ONLY_CROSSED");
    }

    // Match against the opposite side (price-time, deterministic)
    const fills: Fill[] = [];
    let remaining = amount;
    if (type !== "postOnly") {
      let depth = 0;
      while (remaining > 0n) {
        const best = side === "bid" ? this.asks[0] : this.bids[0];
        if (!best) break;
        const crossed = side === "bid" ? best.price <= price : best.price >= price;
        if (!crossed) break;
        if (++depth > this.policy.maxDepth) throw new BookError("maxDepth exceeded — refusing", "MAX_DEPTH");

        const bestOpen = best.amount - best.filled;
        const tradeAmount = remaining < bestOpen ? remaining : bestOpen;
        const { notional, remainder } = notionalOf(best.price, tradeAmount);
        if (notional <= 0n) throw new BookError("fill notional computed ≤ 0 — price/amount law broken", "ZERO_NOTIONAL");

        best.filled += tradeAmount;
        remaining -= tradeAmount;
        // THE MAKER'S LOCK FOLLOWS THE DELIVERY: a partial fill paid out of the
        // maker's escrow (asks: µ-SAOS direct; bids: exact notional+remainder µ¢).
        // Not reducing locked here inflated Σ book locks over the real escrow —
        // a phantom deficit that ghosted healthy market-makers at EVERY boot
        // (the deepest root of live bug 13; the replay mirrors this exactly).
        if (best.side === "ask") best.locked -= tradeAmount;
        else best.locked -= notional + remainder;
        if (best.locked < 0n) throw new BookError(`maker ${best.id} locked underflow — escrow law broken`, "LOCK_UNDERFLOW");
        this.tradeCounter += 1;
        fills.push({
          tradeId: `trade-${this.tradeCounter}`,
          seq: best.seq,
          price: best.price,
          amount: tradeAmount,
          notional,
          remainder,
          makerId: best.agentId,
          makerOrderId: best.id,
          takerId: agentId,
          takerOrderId: id,
          side,
        });
        if (best.filled === best.amount) {
          this.remove(best.side, best.id);
        }
      }
    }

    // IOC: whatever did not fill is dead (never rests)
    if (type === "ioc") {
      if (fills.length === 0) throw new BookError("ioc order crossed nothing — nothing filled, nothing locked", "IOC_NOTHING");
      const filledAmount = amount - remaining;
      return {
        order: { ...order, filled: filledAmount },
        lock: { agentId, asset: side === "bid" ? "quote" : "base", amount, orderId: id },
        fills,
        unlock: { agentId, asset: side === "bid" ? "quote" : "base", amount: remaining, orderId: id },
      };
    }

    // Resting order: lock the FULL remaining amount on its asset
    order.locked = remaining;
    if (remaining > 0n) this.insert(side, order);
    const lockAsset = side === "bid" ? "quote" : "base";
    return {
      order: { ...order },
      lock: remaining > 0n ? { agentId, asset: lockAsset, amount: remaining, orderId: id } : undefined,
      fills,
    };
  }

  /** Cancel a resting order; returns the release the settlement must execute. */
  cancel(orderId: string, byAgentId: string): { order: Order; release: LockIntent } {
    const existing = this.getOrder(orderId);
    if (!existing) throw new BookError(`order ${orderId} not found`, "ORDER_NOT_FOUND");
    if (existing.agentId !== byAgentId) throw new BookError("only the owning agent may cancel", "NOT_OWNER");
    const removed = this.remove(existing.side, orderId)!;
    const removedLock = removed.locked;
    removed.locked = 0n;
    return {
      order: removed,
      release: { agentId: byAgentId, asset: removed.side === "bid" ? "quote" : "base", amount: removedLock, orderId: removed.id },
    };
  }
}
