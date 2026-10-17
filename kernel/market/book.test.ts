/**
 * kernel/market/book.test.ts — P2 proof suite for the sovereign order book.
 * Deterministic vectors: אותו-קלט = אותו-פלט. כל-מבחן מפיל-את-הריצה על-הפרה.
 */

import { describe, test, expect } from "bun:test";
import { OrderBook, notionalOf, BookError, MICRO } from "./book";

describe("notionalOf — the anti-float wall", () => {
  test("exact products with explicit remainder (the saos-dex float defect, fixed)", () => {
    expect(notionalOf(30_000_000n, MICRO)).toEqual({ notional: 30_000_000n, remainder: 0n }); // 30 USDS/SAOS × 1 SAOS = 30 USDS exact
    // 33333 µ¢/SAOS × 30000 µ-SAOS = 999,990,000 → 999 µ¢ whole + 990,000 µ¢ dust — RECORDED, not dropped
    expect(notionalOf(33333n, 30000n)).toEqual({ notional: 999n, remainder: 990000n });
    const { notional, remainder } = notionalOf(7n, 1n);
    expect(notional).toBe(0n);
    expect(remainder).toBe(7n);
    void notional; void remainder;
  });
});

describe("price-time matching", () => {
  test("maker price wins; FIFO within the same price; partial fills chain", () => {
    const b = new OrderBook();
    // two asks at 30000: agent-a first (seq), agent-b second
    b.place({ id: "a1", agentId: "agent-a", side: "ask", price: 30000n, amount: 500_000n });
    b.place({ id: "b1", agentId: "agent-b", side: "ask", price: 30000n, amount: 500_000n });
    b.place({ id: "b2", agentId: "agent-b", side: "ask", price: 29000n, amount: 100_000n }); // better price first
    const res = b.place({ id: "t1", agentId: "agent-t", side: "bid", price: 30000n, amount: 800_000n });
    expect(res.fills.length).toBe(3);
    // best price first (29000 from agent-b), then FIFO at 30000 (agent-a before agent-b)
    expect(res.fills[0].makerId).toBe("agent-b");
    expect(res.fills[0].price).toBe(29000n);
    expect(res.fills[1].makerId).toBe("agent-a");
    expect(res.fills[1].price).toBe(30000n); // MAKER's price — not the taker's limit
    expect(res.fills[2].makerId).toBe("agent-b");
    expect(res.fills[2].amount).toBe(200_000n); // partial: 800k = 100k + 500k + 200k
    // the last ask rests with 300k remaining
    const st = b.stats();
    expect(st.asks).toBe(1);
    expect(b.getOrder("b1")!.filled).toBe(200_000n);
    void st;
  });

  test("taker's over-limit price does not improve the fill price (price-time law)", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "ask", price: 31000n, amount: 1_000_000n });
    const res = b.place({ id: "t1", agentId: "agent-t", side: "bid", price: 35000n, amount: 1_000_000n });
    expect(res.fills[0].price).toBe(31000n);
  });
});

describe("self-trade prevention (fail-closed)", () => {
  test("an agent cannot cross its own resting order — refused loudly", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "ask", price: 30000n, amount: 100_000n });
    expect(() => b.place({ id: "t1", agentId: "agent-a", side: "bid", price: 30000n, amount: 100_000n }))
      .toThrow(/SELF_TRADE_REFUSED|self-trade/);
    try {
      b.place({ id: "t2", agentId: "agent-a", side: "bid", price: 30000n, amount: 100_000n });
    } catch (e) {
      expect((e as BookError).code).toBe("SELF_TRADE_REFUSED");
    }
  });
  test("different agents may cross freely", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "ask", price: 30000n, amount: 100_000n });
    const res = b.place({ id: "t1", agentId: "agent-b", side: "bid", price: 30000n, amount: 100_000n });
    expect(res.fills.length).toBe(1);
  });
});

describe("postOnly / IOC", () => {
  test("postOnly refuses when it would cross", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "ask", price: 30000n, amount: 100_000n });
    try {
      b.place({ id: "t1", agentId: "agent-b", side: "bid", price: 30000n, amount: 100_000n, type: "postOnly" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as BookError).code).toBe("POST_ONLY_CROSSED");
    }
  });
  test("postOnly rests when it does not cross", () => {
    const b = new OrderBook();
    const res = b.place({ id: "m1", agentId: "agent-a", side: "bid", price: 29000n, amount: 100_000n, type: "postOnly" });
    expect(res.fills.length).toBe(0);
    expect(b.stats().bids).toBe(1);
  });
  test("IOC fills what crosses and dies otherwise (never rests)", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "ask", price: 30000n, amount: 100_000n });
    const res = b.place({ id: "t1", agentId: "agent-b", side: "bid", price: 30000n, amount: 400_000n, type: "ioc" });
    expect(res.fills[0].amount).toBe(100_000n);
    expect(res.unlock!.amount).toBe(300_000n); // refund of over-lock
    expect(b.stats().bids).toBe(0); // nothing rests
    // ioc that crosses nothing refuses (nothing to lock)
    try {
      b.place({ id: "t2", agentId: "agent-b", side: "bid", price: 25000n, amount: 100_000n, type: "ioc" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as BookError).code).toBe("IOC_NOTHING");
    }
  });
});

describe("cancel — only the owner, only resting", () => {
  test("foreign cancel refused; owner cancel releases the lock", () => {
    const b = new OrderBook();
    b.place({ id: "m1", agentId: "agent-a", side: "bid", price: 30000n, amount: 100_000n });
    expect(() => b.cancel("m1", "agent-b")).toThrow(/NOT_OWNER|owning/);
    const res = b.cancel("m1", "agent-a");
    expect(res.release.amount).toBe(100_000n);
    expect(res.release.asset).toBe("quote");
    expect(b.stats().bids).toBe(0);
  });
});

describe("determinism — same ops, same book", () => {
  test("two books fed the same sequence produce identical snapshots", () => {
    const ops: Parameters<OrderBook["place"]>[] = [
      { id: "o1", agentId: "a", side: "bid", price: 30000n, amount: 100_000n },
      { id: "o2", agentId: "b", side: "bid", price: 30100n, amount: 50_000n },
      { id: "o3", agentId: "c", side: "ask", price: 30500n, amount: 70_000n },
      { id: "o4", agentId: "d", side: "ask", price: 30400n, amount: 20_000n },
      { id: "o5", agentId: "e", side: "bid", price: 30400n, amount: 30_000n }, // crosses o4
    ];
    const b1 = new OrderBook();
    const b2 = new OrderBook();
    for (const op of ops) { b1.place(op); b2.place(op); }
    const snap = (b: OrderBook) => b.allOrders().map((o) => `${o.id}:${o.side}:${o.price}:${o.filled}/${o.amount}`).join("|");
    expect(snap(b1)).toBe(snap(b2));
  });
});
