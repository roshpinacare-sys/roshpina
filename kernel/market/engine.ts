/**
 * kernel/market/engine.ts — P2: the sovereign market engine.
 *
 * הארכיטקטורה (הנחיית-מפעיל 2026-10-17): כלכלה-סגורה שבה הסוכנים הם
 * הלקוחות והמשתמשים. שני מטבעות, שני ספרים מתמידים נפרדים (אפס-ערבוב
 * יחידות — חוק חשבונאי):
 *   BASE = SAOS (µ-SAOS) — ספר-בסיס משלו
 *   QUOTE = USDS (µ¢) — ספר-מביא משלו
 *
 * עסקה = שתי-רגליים, כל-רגל משמרת בתוך-המטבע שלה (דו-כתובי נקי):
 *   רגל-quote: קונה → (עמלה → קופת-הפלטפורמה) + מוכר
 *   רגל-base:  escrow-השוק → קונה (המוכר נעל מזה-זמן, בשעת-הצבת-הזמנה)
 *
 * כל-רגל עוברת דרך PersistentLedger עם idempotency-key משלה
 * (tradeId:q / tradeId:b / orderId:lock / orderId:rel) — קריסה-באמצע-התשלום
 * מתכנסת ב-replay (דפוס resume-log מוכח מ-kernel-smoke סעיף 3).
 *
 * יומן-השוק (journal) הוא event-sourcing של מצב-הספר: resting/canceled/
 * trade_intent/trade_done — replay בונה מחדש את הספר בדיוק, אף-פעם לא
 * מריץ-match מחדש (deterministic).
 */

import { OrderBook, BookError, MICRO, notionalOf } from "./book";
import type { Fill, Order, Side } from "./book";
import { PersistentLedger, Journal, JournalError, parseMicroCents } from "../ledger/persistent-ledger";
import type { Envelope } from "../ledger/persistent-ledger";

export const FEE_BPS = 10n; // 0.10% — עמלת-פלטפורמה אמיתית, נכנסת לחשבון-הכנסה

export class MarketError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

// ─── Market journal records ──────────────────────────────────────────────────

type SOrder = {
  id: string; agentId: string; side: Side; price: string; amount: string; filled: string; locked: string; seq: number;
};

type MarketRecord =
  | { t: "resting"; order: SOrder }                       // order came to rest (remaining>0)
  | { t: "canceled"; orderId: string; released: string }  // order left the book
  | { t: "trade_intent"; fill: SFill }                    // a fill decided (legs follow)
  | { t: "trade_done"; tradeId: string };                 // legs committed (idempotent)

type SFill = {
  tradeId: string; price: string; amount: string; notional: string; remainder: string;
  makerId: string; makerOrderId: string; takerId: string; takerOrderId: string; side: Side;
};

const sOrder = (o: Order): SOrder => ({ id: o.id, agentId: o.agentId, side: o.side, price: o.price.toString(), amount: o.amount.toString(), filled: o.filled.toString(), locked: o.locked.toString(), seq: o.seq });
const sFill = (f: Fill): SFill => ({ tradeId: f.tradeId, price: f.price.toString(), amount: f.amount.toString(), notional: f.notional.toString(), remainder: f.remainder.toString(), makerId: f.makerId, makerOrderId: f.makerOrderId, takerId: f.takerId, takerOrderId: f.takerOrderId, side: f.side });

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface EnginePaths {
  dataDir: string; // both ledgers + market journal live under here
}

export class MarketEngine {
  private quote!: PersistentLedger;  // USDS µ¢
  private base!: PersistentLedger;   // SAOS µ-SAOS
  private book = new OrderBook();
  private journal!: Journal<MarketRecord>;
  private settledTrades = new Set<string>();
  private escrowQuoteId = "";  // market escrow on the USDS ledger
  private escrowBaseId = "";   // market escrow on the SAOS ledger
  private feeAccountId = "";   // platform revenue (USDS)
  private treasuryQuoteId = "";
  private treasuryBaseId = "";
  private agentAccounts = new Map<string, { quoteId: string; baseId: string }>();
  private fillsByAgent = new Map<string, number>();
  bootedAt = "";

  /** Boot both ledgers (fail-closed verify) + ensure system accounts + replay. */
  static async open(dataDir: string): Promise<MarketEngine> {
    const eng = new MarketEngine();
    eng.bootedAt = new Date().toISOString();
    eng.quote = await PersistentLedger.open(`${dataDir}/usds`, { verify: "full" });
    eng.base = await PersistentLedger.open(`${dataDir}/saos`, { verify: "full" });
    eng.journal = new Journal<MarketRecord>(`${dataDir}/market`);
    const { records } = eng.journal.open();
    eng.escrowQuoteId = await eng.ensureAccount(eng.quote, "market-escrow-quote");
    eng.escrowBaseId = await eng.ensureAccount(eng.base, "market-escrow-base");
    eng.feeAccountId = await eng.ensureAccount(eng.quote, "platform-fee");
    eng.treasuryQuoteId = await eng.ensureAccount(eng.quote, "treasury");
    eng.treasuryBaseId = await eng.ensureAccount(eng.base, "treasury");
    // Rediscover agent principals from the ledgers (reboot = same economy)
    for (const acc of await eng.quote.listAccounts("sovereign")) {
      const m = acc.name.match(/^agent:([a-z0-9\-]+):usds$/);
      if (m) await eng.registerAgent(m[1]);
    }
    eng.replay(records);
    return eng;
  }

  private async ensureAccount(led: PersistentLedger, name: string): Promise<string> {
    const existing = (await led.listAccounts("sovereign")).find((a) => a.name === name);
    if (existing) return existing.id;
    const acc = await led.createAccount("sovereign", "system", "asset", name);
    return acc.id;
  }

  /** Deterministic book rebuild — NEVER re-matches on replay. */
  private replay(records: Envelope<MarketRecord>[]): void {
    const byId = new Map<string, Order>();
    const ensure = (s: SOrder): Order => {
      let o = byId.get(s.id);
      if (!o) {
        o = { id: s.id, agentId: s.agentId, side: s.side, price: BigInt(s.price), amount: BigInt(s.amount), filled: BigInt(s.filled), locked: BigInt(s.locked), createdAt: 0, seq: s.seq };
        byId.set(s.id, o);
      }
      return o;
    };
    for (const env of records) {
      const r = env.rec;
      switch (r.t) {
        case "resting": {
          const o = ensure(r.order);
          o.filled = BigInt(r.order.filled);
          o.locked = BigInt(r.order.locked);
          // re-insert at its (possibly updated) state: remove-then-place keeps price-time order by seq
          try { this.book.cancel(o.id, o.agentId); } catch { /* not resting */ }
          if (BigInt(r.order.amount) - BigInt(r.order.filled) > 0n) {
            const res = this.book.place({
              id: o.id, agentId: o.agentId, side: o.side,
              price: BigInt(r.order.price), amount: BigInt(r.order.amount) - BigInt(r.order.filled),
              type: "limit",
            });
            // replay-place must not match anything — assert loudly if it does
            if (res.fills.length > 0) throw new JournalError(`replay: order ${o.id} matched during rebuild — journal is not state-sourcing`, "REPLAY_MATCHED");
          }
          break;
        }
        case "canceled": {
          try { this.book.cancel(r.orderId, this.book.getOrder(r.orderId)?.agentId ?? "?"); } catch { /* already gone */ }
          break;
        }
        case "trade_intent": {
          this.fillsByAgent.set(r.fill.takerId, (this.fillsByAgent.get(r.fill.takerId) ?? 0) + 1);
          this.fillsByAgent.set(r.fill.makerId, (this.fillsByAgent.get(r.fill.makerId) ?? 0) + 1);
          // maker consumed on the book
          const maker = this.book.getOrder(r.fill.makerOrderId);
          if (maker) {
            maker.filled += BigInt(r.fill.amount);
            if (maker.filled === maker.amount) {
              try { this.book.cancel(maker.id, maker.agentId); } catch { /* race-free by construction */ }
            }
          }
          break;
        }
        case "trade_done": {
          this.settledTrades.add(r.tradeId);
          break;
        }
        default:
          throw new JournalError(`market replay: unknown record ${(r as { t: string }).t}`, "REPLAY_UNKNOWN");
      }
    }
  }

  // ─── Agent lifecycle ───────────────────────────────────────────────────────

  /** Register an agent: distinct account pair on each ledger. Idempotent by name. */
  async registerAgent(agentId: string): Promise<{ quoteId: string; baseId: string }> {
    if (!/^[a-z0-9\-]{1,64}$/.test(agentId)) throw new MarketError("agentId must match [a-z0-9\\-]{1,64}", "BAD_AGENT_ID");
    const existing = this.agentAccounts.get(agentId);
    if (existing) return existing;
    const quoteAcc = (await this.quote.listAccounts("sovereign")).find((a) => a.name === `agent:${agentId}:usds`);
    const baseAcc = (await this.base.listAccounts("sovereign")).find((a) => a.name === `agent:${agentId}:saos`);
    const quoteId = quoteAcc?.id ?? (await this.quote.createAccount("sovereign", agentId, "asset", `agent:${agentId}:usds`)).id;
    const baseId = baseAcc?.id ?? (await this.base.createAccount("sovereign", agentId, "asset", `agent:${agentId}:saos`)).id;
    const pair = { quoteId, baseId };
    this.agentAccounts.set(agentId, pair);
    return pair;
  }

  /** The sovereign treasury mints initial allocation to an agent (genuine credit creation through the guard). */
  async allocate(agentId: string, usds: string, saos: string): Promise<void> {
    const { quoteId, baseId } = await this.registerAgent(agentId);
    if (parseMicroCents(usds) > 0n) {
      await this.quote.guardMint("sovereign", quoteId, parseMicroCents(usds), `genesis allocation ${agentId}`, "treasury", `alloc:${agentId}:usds`);
    }
    if (BigInt(saos) > 0n) {
      await this.base.guardMint("sovereign", baseId, BigInt(saos), `genesis allocation ${agentId}`, "treasury", `alloc:${agentId}:saos`);
    }
  }

  // ─── Balances / reading ────────────────────────────────────────────────────

  async balances(agentId: string): Promise<{ usdsAvailable: string; usdsLocked: string; saosAvailable: string; saosLocked: string }> {
    const { quoteId, baseId } = await this.registerAgent(agentId);
    const q = await this.quote.getAccount("sovereign", quoteId);
    const b = await this.base.getAccount("sovereign", baseId);
    const qLocked = await this.sumLockedQuote(agentId);
    const bLocked = await this.sumLockedBase(agentId);
    return {
      usdsAvailable: q.balance.toString(),
      usdsLocked: qLocked.toString(),
      saosAvailable: b.balance.toString(),
      saosLocked: bLocked.toString(),
    };
  }

  /** Locked quote = escrow balance attributable to this agent's resting bids. */
  private async sumLockedQuote(agentId: string): Promise<bigint> {
    let sum = 0n;
    for (const o of this.book.allOrders()) {
      if (o.agentId === agentId && o.side === "bid") {
        sum += (o.amount - o.filled) * o.price / MICRO; // µ¢ locked per resting bid
      }
    }
    return sum;
  }
  private async sumLockedBase(agentId: string): Promise<bigint> {
    let sum = 0n;
    for (const o of this.book.allOrders()) {
      if (o.agentId === agentId && o.side === "ask") sum += o.amount - o.filled; // µ-SAOS locked
    }
    return sum;
  }

  // ─── Trading ───────────────────────────────────────────────────────────────

  /** Place an order for an agent. Fail-closed: locks first, then book, then journal. */
  async placeOrder(params: {
    agentId: string; orderId: string; side: Side; price: bigint; amount: bigint; type?: "limit" | "postOnly" | "ioc";
  }): Promise<{ order: Order; fills: Fill[] }> {
    const { agentId, orderId, side, price, amount } = params;
    const type = params.type ?? "limit";
    if (this.book.getOrder(orderId)) throw new BookError(`order ${orderId} already on book`, "DUPLICATE_ORDER_ID");

    // 1) capacity pre-check on the locking asset (fail-closed BEFORE any mutation)
    const bal = await this.balances(agentId);
    if (side === "bid") {
      const need = amount * price / MICRO;
      if (BigInt(bal.usdsAvailable) < need) throw new MarketError(`agent ${agentId}: insufficient USDS (${bal.usdsAvailable} < ${need})`, "INSUFFICIENT_QUOTE");
    } else {
      if (BigInt(bal.saosAvailable) < amount) throw new MarketError(`agent ${agentId}: insufficient SAOS (${bal.saosAvailable} < ${amount})`, "INSUFFICIENT_BASE");
    }

    // 2) the book decides (deterministic)
    const res = this.book.place({ id: orderId, agentId, side, price, amount, type });

    // 3) execute fills (each leg idempotent) + journal
    for (const fill of res.fills) {
      await this.journal.append({ t: "trade_intent", fill: sFill(fill) });
      await this.settleFill(fill);
      await this.journal.append({ t: "trade_done", tradeId: fill.tradeId });
      this.settledTrades.add(fill.tradeId);
      this.fillsByAgent.set(fill.takerId, (this.fillsByAgent.get(fill.takerId) ?? 0) + 1);
      this.fillsByAgent.set(fill.makerId, (this.fillsByAgent.get(fill.makerId) ?? 0) + 1);
    }

    // 4) resting remainder → lock into market escrow (idempotent by orderId)
    if (res.order.locked > 0n) {
      await this.journal.append({ t: "resting", order: sOrder(res.order) });
      if (side === "bid") {
        const need = res.order.locked * price / MICRO;
        await this.quote.transfer("sovereign", (await this.registerAgent(agentId)).quoteId, this.escrowQuoteId, need, `lock bid ${orderId}`, "market", `lock:${orderId}`);
      } else {
        await this.base.transfer("sovereign", (await this.registerAgent(agentId)).baseId, this.escrowBaseId, res.order.locked, `lock ask ${orderId}`, "market", `lock:${orderId}`);
      }
    } else {
      await this.journal.append({ t: "resting", order: sOrder({ ...res.order, locked: 0n }) });
    }

    return { order: res.order, fills: res.fills };
  }

  /** Cancel: release the escrow lock (idempotent), remove from book, journal. */
  async cancelOrder(agentId: string, orderId: string): Promise<{ released: string }> {
    const res = this.book.cancel(orderId, agentId);
    await this.journal.append({ t: "canceled", orderId, released: res.release.amount.toString() });
    if (res.release.amount > 0n) {
      if (res.release.asset === "quote") {
        const need = res.release.amount * res.order.price / MICRO; // release in µ¢
        await this.quote.transfer("sovereign", this.escrowQuoteId, (await this.registerAgent(agentId)).quoteId, need, `release bid ${orderId}`, "market", `rel:${orderId}`);
      } else {
        await this.base.transfer("sovereign", this.escrowBaseId, (await this.registerAgent(agentId)).baseId, res.release.amount, `release ask ${orderId}`, "market", `rel:${orderId}`);
      }
    }
    return { released: res.release.amount.toString() };
  }

  /** Settle one fill: quote leg + base leg, each idempotent by tradeId. */
  private async settleFill(f: Fill): Promise<void> {
    // exact buyer cost = notional + remainder (no dust lost)
    const buyerPays = f.notional + f.remainder;
    const fee = f.notional * FEE_BPS / 10000n;
    const makerReceives = buyerPays - fee;
    const takerIsBid = f.side === "bid";

    const buyerQuoteId = (await this.registerAgent(takerIsBid ? f.takerId : f.makerId)).quoteId;
    const sellerQuoteId = (await this.registerAgent(takerIsBid ? f.makerId : f.takerId)).quoteId;
    const sellerBaseId = (await this.registerAgent(takerIsBid ? f.makerId : f.takerId)).baseId;
    const buyerBaseId = (await this.registerAgent(takerIsBid ? f.takerId : f.makerId)).baseId;

    // QUOTE leg: buyer → fee + seller (from the buyer's available balance)
    await this.quote.transfer("sovereign", buyerQuoteId, this.feeAccountId, fee, `fee ${f.tradeId}`, "market", `${f.tradeId}:fee`);
    await this.quote.transfer("sovereign", buyerQuoteId, sellerQuoteId, makerReceives, `settle ${f.tradeId}`, "market", `${f.tradeId}:q`);

    // BASE leg: market escrow → buyer (the seller locked it at placement)
    await this.base.transfer("sovereign", this.escrowBaseId, buyerBaseId, f.amount, `deliver ${f.tradeId}`, "market", `${f.tradeId}:b`);
  }

  // ─── Proofs ────────────────────────────────────────────────────────────────

  /**
   * Global conservation per asset: minted == Σ(available) + Σ(escrow) + fees.
   * This is THE economic invariant — the selftest asserts it after every storm.
   */
  async conservation(): Promise<{
    quote: { minted: string; inAccounts: string; inEscrow: string; fees: string; holds: boolean };
    base: { minted: string; inAccounts: string; inEscrow: string; holds: boolean };
  }> {
    const qAccounts = await this.quote.listAccounts("sovereign");
    const bAccounts = await this.base.listAccounts("sovereign");
    const qMinted = qAccounts.filter((a) => a.type === "equity").reduce((s, a) => s - a.balance, 0n)
      + qAccounts.filter((a) => a.type === "revenue").reduce((s, a) => s + a.balance, 0n);
    const qSum = qAccounts.filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0n);
    const bMinted = bAccounts.filter((a) => a.type === "equity").reduce((s, a) => s - a.balance, 0n);
    const bSum = bAccounts.filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0n);
    const qEscrow = qAccounts.find((a) => a.id === this.escrowQuoteId)?.balance ?? 0n;
    const bEscrow = bAccounts.find((a) => a.id === this.escrowBaseId)?.balance ?? 0n;
    const qFees = qAccounts.find((a) => a.id === this.feeAccountId)?.balance ?? 0n;
    const qAssetNoEscrowNoFee = qSum - qEscrow - qFees;
    return {
      quote: { minted: qMinted.toString(), inAccounts: qAssetNoEscrowNoFee.toString(), inEscrow: qEscrow.toString(), fees: qFees.toString(), holds: qMinted === qAssetNoEscrowNoFee + qEscrow + qFees },
      base: { minted: bMinted.toString(), inAccounts: (bSum - bEscrow).toString(), inEscrow: bEscrow.toString(), holds: bMinted === bSum },
    };
  }

  stats(): { book: ReturnType<OrderBook["stats"]>; settled: number } {
    return { book: this.book.stats(), settled: this.settledTrades.size };
  }

  /** Real per-agent economics — computed from the live ledgers, never estimated. */
  async economyReport(): Promise<{ agentId: string; usds: string; usdsLocked: string; saos: string; saosLocked: string; fills: number }[]> {
    const out: { agentId: string; usds: string; usdsLocked: string; saos: string; saosLocked: string; fills: number }[] = [];
    for (const agentId of this.agentAccounts.keys()) {
      const b = await this.balances(agentId);
      out.push({
        agentId,
        usds: b.usdsAvailable,
        usdsLocked: b.usdsLocked,
        saos: b.saosAvailable,
        saosLocked: b.saosLocked,
        fills: this.fillsByAgent.get(agentId) ?? 0,
      });
    }
    return out;
  }

  bookSnapshot(): { bids: { price: string; amount: string; filled: string; agentId: string; id: string }[]; asks: { price: string; amount: string; filled: string; agentId: string; id: string }[] } {
    const mk = (o: Order) => ({ price: o.price.toString(), amount: (o.amount - o.filled).toString(), filled: o.filled.toString(), agentId: o.agentId, id: o.id });
    const orders = this.book.allOrders();
    return {
      bids: orders.filter((o) => o.side === "bid").sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : a.seq - b.seq)).map(mk),
      asks: orders.filter((o) => o.side === "ask").sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : a.seq - b.seq)).map(mk),
    };
  }

  close(): void {
    this.quote.close();
    this.base.close();
    this.journal.close();
  }
}

export { notionalOf };
