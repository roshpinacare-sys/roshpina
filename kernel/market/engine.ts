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

import { OrderBook, BookError, MICRO, notionalOf, exactCeilMicro } from "./book";
import type { Fill, Order, Side } from "./book";
import { PersistentLedger, Journal, JournalError, parseMicroCents } from "../ledger/persistent-ledger";
import type { Envelope } from "../ledger/persistent-ledger";
import { computeHistoricalRepairPlan } from "./repair-plan";
import type { RepairPlan } from "./repair-plan";

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
  | { t: "ghosted"; orderId: string; side: Side; agentId: string; unbacked: string; ref: string } // boot ghost: unbacked lock removed, nothing released
  | { t: "trade_intent"; fill: SFill }                    // a fill decided (legs follow)
  | { t: "trade_done"; tradeId: string }                  // legs committed (idempotent)
  | { t: "econ"; kind: EconKind; epoch: string; agentId: string; amount: string; ref: string }; // economy ops (audit + replay of idempotency keys)

type EconKind = "payroll" | "tax" | "reward" | "stake" | "unstake" | "correction";
export interface EconOp { kind: EconKind; epoch: string; agentId: string; amount: string; ref: string }

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
  book = new OrderBook(); // book + trade sequencer are boot-restored from the journal (live bug 17)
  private journal!: Journal<MarketRecord>;
  private settledTrades = new Set<string>();
  private escrowQuoteId = "";  // market escrow on the USDS ledger
  private escrowBaseId = "";   // market escrow on the SAOS ledger
  private feeAccountId = "";   // platform revenue (USDS)
  private treasuryQuoteId = "";
  private treasuryBaseId = "";
  private agentAccounts = new Map<string, { quoteId: string; baseId: string }>();
  private fillsByAgent = new Map<string, number>();
  private stakeAccounts = new Map<string, string>(); // agentId → stake account id (USDS ledger)
  private epochOps: EconOp[] = [];                   // economy audit trail (rebuilt on replay)
  private phantomsSkipped = 0;                       // residual records skipped during replay (honest ghost count)
  private paidKeys = new Set<string>();              // "kind:epoch:agentId" — epoch idempotency that survives reboot
  /** Every order id that EVER appeared in the market journal (resting, canceled,
   *  ghosted, or part of a fill). Order ids are forever-unique: a reused id lets
   *  the currency ledger's idempotency silently REPLAY an old lock transfer (no
   *  money moves) while the book counts a fresh lock — a structural lock/escrow
   *  divergence that ghosted real capital at every boot (live bug 13's deeper
   *  root). placeOrder refuses reused ids fail-closed. */
  private usedOrderIds = new Set<string>();
  /** Orphaned escrow detected at boot (after salvage: 0; negative = locks>escrow, degraded). */
  escrowOrphanQuote = 0n;
  escrowOrphanBase = 0n;
  /** Orders ghosted at boot (unbacked locks — torn backup / lost-journal era). */
  ghostsBoot = { quote: { count: 0, amount: 0n }, base: { count: 0, amount: 0n } };
  /** Quiesce flag — mutations refused while a consistent backup is taken. */
  private quiesced = false;
  bootedAt = "";

  /** Boot both ledgers (fail-closed verify) + ensure system accounts + replay. */
  static async open(dataDir: string): Promise<MarketEngine> {
    const eng = new MarketEngine();
    eng.bootedAt = new Date().toISOString();
    eng.dataDir = dataDir; // Task 30: was never assigned (latent) — the repair plan reads it
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
    // Orders whose escrowed deposits were consumed by SETTLED fills — excluded
    // from boot orphan attribution so a filled order is never mistaken for an
    // unattributed deposit. Gated on trade_done: a trade_intent whose settle
    // threw (money never moved) must NOT exclude its maker's lock from the
    // evidence refunds — that money is still in escrow and still the maker's.
    // fillPaid* caps the refund of partially-filled ghosts by what their fills
    // already delivered (LIVE BUG 19 fix bookkeeping).
    const doneTrades = new Set<string>();
    for (const env of records) {
      if (env.rec.t === "trade_done") doneTrades.add(env.rec.tradeId);
    }
    const filledOrderIds = new Set<string>();
    const fillPaidQuote = new Map<string, bigint>(); // maker-buyers: µ¢ paid out of their locks
    const fillPaidBase = new Map<string, bigint>();  // maker-sellers: µ-SAOS delivered from their locks
    // LIVE BUG 17: the trade sequencer must CONTINUE the journaled history —
    // a process restart used to reset it to 0, so post-boot trades collided
    // with pre-boot tradeIds and every settlement idem replayed an OLD trade's
    // transfer: the journal recorded trades while the ledgers moved no money.
    let maxTradeSeq = 0;
    for (const env of records) {
      const r = env.rec;
      if (r.t === "trade_intent") {
        if (doneTrades.has(r.fill.tradeId)) {
          filledOrderIds.add(r.fill.makerOrderId);
          filledOrderIds.add(r.fill.takerOrderId);
          if (r.fill.side === "ask") {
            // taker sold → the maker bought → the maker's µ¢ lock paid the taker
            // (by the law the LEDGER actually settled with: exact ceil µ¢)
            const paid = BigInt(r.fill.notional) + (BigInt(r.fill.remainder) > 0n ? 1n : 0n);
            fillPaidQuote.set(r.fill.makerOrderId, (fillPaidQuote.get(r.fill.makerOrderId) ?? 0n) + paid);
          } else {
            // taker bought → the maker sold → the maker's µ-SAOS lock was delivered
            fillPaidBase.set(r.fill.makerOrderId, (fillPaidBase.get(r.fill.makerOrderId) ?? 0n) + BigInt(r.fill.amount));
          }
        }
        const m = /^trade-(\d+)$/.exec(r.fill.tradeId ?? "");
        if (m) {
          const n = Number(m[1]);
          if (n > maxTradeSeq) maxTradeSeq = n;
        }
      }
    }
    eng.book.restoreTradeCounter(maxTradeSeq);
    await eng.reconcileEscrow(filledOrderIds, fillPaidQuote, fillPaidBase);
    return eng;
  }

  /** Boot-time escrow reconciliation. The rebuilt book's locks MUST equal the
   *  escrow balances — any difference is resolved BY EVIDENCE, never by age:
   *
   *  PASS 1 — evidence-based ghosting (the root fix of live bug 13): an order
   *  whose lock deposit is PROVABLY ABSENT from the verified currency history
   *  (idem `lock:<orderId>` missing — its deposit was rolled away by a sandbox
   *  wipe) is ghosted. Its money truly does not exist; the loss is attributed
   *  to the rollback event itself. The PREVIOUS policy ghosted the NEWEST
   *  orders FIFO-by-age regardless of deposits — every reboot then silently
   *  confiscated the newest depositors' real escrowed capital and let it back
   *  the survivors (146 orders / 350M µ-units across 5 boots, 2026-10-18→19 —
   *  that is how the ask side kept dying). That confiscation is over.
   *
   *  PASS 2 — FIFO fallback (fail-closed, expected never to fire): if the book
   *  is STILL overlocked after pass 1 (deeper corruption than a rollback),
   *  the old FIFO-by-age ghosting converges the book as a last resort, loud
   *  record each. Never fabricated away.
   *
   *  ORPHAN ATTRIBUTION — the surplus (escrow > kept locks) used to be swept
   *  to the treasury anonymously. Now it is attributed BY EVIDENCE: deposits
   *  (`lock:<orderId>`) of orders that are no longer on the book, were never
   *  released, and were never filled are refunded to the account that paid
   *  them (oldest first, capped at each deposit's amount); only a truly
   *  unattributable remainder goes to the treasury, with a loud, signed
   *  correction record. The fiscal loop still redistributes — but through
   *  legitimate channels, to the right owners first. Idempotent per boot
   *  (idem keys carry bootedAt). */
  private async reconcileEscrow(
    filledOrderIds: Set<string>,
    fillPaidQuote: Map<string, bigint>,
    fillPaidBase: Map<string, bigint>,
  ): Promise<void> {
    this.escrowOrphanQuote = 0n;
    this.escrowOrphanBase = 0n;
    this.ghostsBoot = { quote: { count: 0, amount: 0n }, base: { count: 0, amount: 0n } };
    const escQ = BigInt((await this.quote.getAccount("sovereign", this.escrowQuoteId)).balance);
    const escB = BigInt((await this.base.getAccount("sovereign", this.escrowBaseId)).balance);
    // LIVE BUG 19d (the units law): `Order.locked` counts µ-SAOS for asks and
    // µ-SAOS-units for bids alike; a bid's MONEY coverage is the exact ceil µ¢
    // of those units (notional+remainder) — precisely what was transferred at
    // placement. The old reconcile compared bid UNITS against the µ¢ escrow
    // (≈4× phantom overlock at 0.258 USDS/SAOS): every boot "found" a bid
    // deficit that never existed and the FIFO fallback ate healthy bids.
    const coverOf = (o: Order): bigint => {
      if (o.side === "ask") return o.locked;
      const n = notionalOf(o.price, o.locked);
      return n.notional + n.remainder;
    };
    const ghostSide = async (side: "bid" | "ask", esc: bigint, ledger: PersistentLedger): Promise<void> => {
      const orders = this.book.allOrders().filter((o) => o.side === side).sort((a, b) => a.seq - b.seq);
      const covered = orders.reduce((a, o) => a + coverOf(o), 0n);
      if (covered <= esc) return; // fully backed — nothing to ghost
      let ghosted = 0n;
      let count = 0;
      const ghostOne = async (o: Order, ref: string): Promise<void> => {
        ghosted += o.locked;
        count++;
        try { this.book.cancel(o.id, o.agentId); } catch { /* already gone */ }
        await this.journal.append({ t: "ghosted", orderId: o.id, side, agentId: o.agentId, unbacked: o.locked.toString(), ref });
      };
      // PASS 1 — evidence: ghost only orders whose deposit is provably absent.
      if (covered - ghosted > esc) {
        for (const o of orders) {
          if (covered - ghosted <= esc) break;
          if (ledger.hasIdem(`lock:${o.id}`)) continue; // deposit landed — backed, keep
          await ghostOne(o, `boot-ghost-evidence:${this.bootedAt}`);
        }
      }
      // PASS 2 — last-resort FIFO-by-age over the (now all-evidence-backed) rest.
      if (covered - ghosted > esc) {
        console.error(`[market-engine] escrow reconcile: evidence pass insufficient (shortfall=${covered - ghosted - esc}) — falling back to FIFO-by-age ghosting`);
        const remaining = this.book.allOrders().filter((o) => o.side === side).sort((a, b) => a.seq - b.seq);
        for (let i = remaining.length - 1; i >= 0 && covered - ghosted > esc; i--) {
          await ghostOne(remaining[i], `boot-ghost-fifo-fallback:${this.bootedAt}`);
        }
      }
      if (side === "bid") this.ghostsBoot.quote = { count, amount: ghosted };
      else this.ghostsBoot.base = { count, amount: ghosted };
      // escrowOrphan stays 0 — the book now converges with the escrow; ghostsBoot tells the story.
      console.error(`[market-engine] escrow reconcile: GHOSTED ${count} ${side}(s), ${ghosted} µ-units of unbacked locks (deficit=${covered - esc}) — journal-recorded`);
    };
    await ghostSide("bid", escQ, this.quote);
    await ghostSide("ask", escB, this.base);
    const orders = this.book.allOrders();
    const lockQuote = orders.filter((o) => o.side === "bid").reduce((a, o) => a + coverOf(o), 0n);
    const lockBase = orders.filter((o) => o.side === "ask").reduce((a, o) => a + o.locked, 0n);
    const orphanQ = escQ - lockQuote;
    const orphanB = escB - lockBase;
    // ORPHAN ATTRIBUTION — refund provable deposits of book-less, never-released
    // orders to the account that paid them (oldest first, capped per deposit).
    // Prior refunds — legacy keys carry a bootedAt segment
    // (`escrow-refund:<bootedAt>:<orderId>` — LIVE BUG 18: the key changed
    // every boot, so the same claim was re-refunded forever; gamma-5-0 was
    // paid its 512,124 µ¢ deposit TWICE). The new key is the bare
    // `escrow-refund:<orderId>` — forever-idempotent. BOTH forms are counted
    // so a refunded claim can never be paid a third time.
    const attributeOrphans = async (
      ledger: PersistentLedger,
      escrowAccountId: string,
      orphan: bigint,
      fills: Map<string, bigint>,
    ): Promise<{ refunded: bigint; toTreasury: bigint }> => {
      if (orphan <= 0n) return { refunded: 0n, toTreasury: 0n };
      const bookIds = new Set(this.book.allOrders().map((o) => o.id));
      const priorRefunds = new Map<string, bigint>();
      for (const { key, tx } of ledger.idemTransactions("escrow-refund:")) {
        const orderId = key.slice("escrow-refund:".length).split(":").pop() ?? "";
        priorRefunds.set(orderId, (priorRefunds.get(orderId) ?? 0n) + BigInt(tx.amount));
      }
      type Cand = { orderId: string; amount: bigint; payeeAccountId: string; createdAt: string };
      const cands: Cand[] = [];
      for (const { key, tx } of ledger.idemTransactions("lock:")) {
        const orderId = key.slice("lock:".length);
        if (bookIds.has(orderId)) continue;                 // live order — its lock is counted
        if (ledger.hasIdem(`rel:${orderId}`)) continue;     // was released legitimately
        if (filledOrderIds.has(orderId)) continue;          // settled fill(s) consumed this order
        const deposit = BigInt(tx.amount);
        if (deposit <= 0n) continue;
        const due = deposit - (fills.get(orderId) ?? 0n) - (priorRefunds.get(orderId) ?? 0n);
        if (due <= 0n) continue;                            // consumed by fills / already returned (incl. legacy double-refunds)
        cands.push({ orderId, amount: due, payeeAccountId: tx.debitAccountId, createdAt: tx.createdAt });
      }
      cands.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      let refunded = 0n;
      let pool = orphan;
      for (const c of cands) {
        if (pool <= 0n) break;
        if (c.amount > pool) continue; // full-dues-only: never partial-refund a claim (fail-closed, stays documented)
        await ledger.transfer("sovereign", escrowAccountId, c.payeeAccountId, c.amount,
          `orphan-deposit refund @boot ${this.bootedAt} (order ${c.orderId})`, "market", `escrow-refund:${c.orderId}`);
        await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: "market-escrow", amount: c.amount.toString(), ref: `escrow-refund:${c.orderId}` });
        pool -= c.amount;
        refunded += c.amount;
      }
      return { refunded, toTreasury: pool };
    };
    if (orphanQ > 0n) {
      const { refunded, toTreasury } = await attributeOrphans(this.quote, this.escrowQuoteId, orphanQ, fillPaidQuote);
      if (toTreasury > 0n) {
        await this.quote.transfer(
          "sovereign", this.escrowQuoteId, this.treasuryQuoteId, toTreasury,
          `escrow-orphan salvage (unattributable) @boot ${this.bootedAt}`, "market", `escrow-reconcile:${this.bootedAt}:q`,
        );
        await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: "market-escrow", amount: (-toTreasury).toString(), ref: `escrow-reconcile:${this.bootedAt}:q` });
      }
      this.escrowOrphanQuote = toTreasury;
      if (refunded > 0n || toTreasury !== orphanQ) {
        console.warn(`[market-engine] escrow reconcile: orphan ${orphanQ} µ¢ — REFUNDED ${refunded} to proven depositors, ${toTreasury} unattributable → treasury`);
      }
    }
    if (orphanB > 0n) {
      const { refunded, toTreasury } = await attributeOrphans(this.base, this.escrowBaseId, orphanB, fillPaidBase);
      if (toTreasury > 0n) {
        await this.base.transfer(
          "sovereign", this.escrowBaseId, this.treasuryBaseId, toTreasury,
          `escrow-orphan salvage (unattributable) @boot ${this.bootedAt}`, "market", `escrow-reconcile:${this.bootedAt}:b`,
        );
        await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: "market-escrow", amount: (-toTreasury).toString(), ref: `escrow-reconcile:${this.bootedAt}:b` });
      }
      this.escrowOrphanBase = toTreasury;
      if (refunded > 0n || toTreasury !== orphanB) {
        console.warn(`[market-engine] escrow reconcile: orphan ${orphanB} µ-SAOS — REFUNDED ${refunded} to proven depositors, ${toTreasury} unattributable → treasury`);
      }
    }
    if (orphanQ < 0n || orphanB < 0n) {
      // Can only happen if ghosting could not fully cover the deficit — still never fabricated.
      console.error(`[market-engine] escrow reconcile: NEGATIVE orphan after ghosting — q=${orphanQ} b=${orphanB} — NOT fabricating; surfaced in health`);
      this.escrowOrphanQuote = orphanQ;
      this.escrowOrphanBase = orphanB;
    }
  }

  /** Quiesce control: while ON, every money mutation refuses (fail-closed).
   *  Used by the backup capsule to take a tear-free snapshot of all state
   *  dirs — the live bug of the 06:06 reboot was a tar taken mid-trade. */
  quiesce(on: boolean): void {
    this.quiesced = on;
  }

  isQuiesced(): boolean {
    return this.quiesced;
  }

  private guardLive(): void {
    if (this.quiesced) throw new MarketError("market is quiesced for a consistent backup — retry shortly", "MARKET_QUIESCED");
  }

  /** Periodic disk maintenance across all three journals (usds/saos/market):
   *  heals vanished files within seconds instead of at the next append/boot.
   *  Returns true if anything was healed. */
  diskMaintenance(): boolean {
    let healed = false;
    try { if (this.quote.diskMaintenance()) healed = true; } catch { /* next tick retries */ }
    try { if (this.base.diskMaintenance()) healed = true; } catch { /* next tick retries */ }
    try { if (this.journal.diskCheck()) healed = true; } catch { /* next tick retries */ }
    return healed;
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
      // forever-unique order-id registry (see usedOrderIds doc)
      if (r.t === "resting") this.usedOrderIds.add(r.order.id);
      else if (r.t === "canceled" || r.t === "ghosted") this.usedOrderIds.add(r.orderId);
      else if (r.t === "trade_intent") { this.usedOrderIds.add(r.fill.makerOrderId); this.usedOrderIds.add(r.fill.takerOrderId); }
      switch (r.t) {
        case "resting": {
          const o = ensure(r.order);
          o.filled = BigInt(r.order.filled);
          o.locked = BigInt(r.order.locked);
          // re-insert at its (possibly updated) state: remove-then-place keeps price-time order by seq
          try { this.book.cancel(o.id, o.agentId); } catch { /* not resting */ }
          const remaining = BigInt(r.order.amount) - BigInt(r.order.filled);
          // A record with remaining>0 but locked=0 was NEVER a resting order (IOC remainder that
          // the live book already killed — historical phantom records). Re-placing it would
          // materialize a crossing ghost — refuse-to-place is the honest reading of the journal.
          if (remaining > 0n && BigInt(r.order.locked) > 0n) {
            // Historical journals (earlier engine versions / order-id reuse between runs) can
            // hold residual records whose re-placement would cross the rebuilt book. place()
            // mutates on match and would corrupt escrow attribution — so we pre-check against
            // the best prices and skip the ghost BEFORE any mutation. The fold already
            // accounted the money; the phantom never represents live escrow. Counted loudly.
            const bs = this.book.stats();
            const price = BigInt(r.order.price);
            const wouldCross = o.side === "bid"
              ? bs.bestAsk !== null && price >= bs.bestAsk
              : bs.bestBid !== null && price <= bs.bestBid;
            if (wouldCross) {
              this.phantomsSkipped++;
              break;
            }
            const res = this.book.place({
              id: o.id, agentId: o.agentId, side: o.side,
              price: BigInt(r.order.price), amount: remaining,
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
        case "ghosted": {
          // Boot ghosting (torn-backup / lost-journal convergence): the order's
          // escrow backing no longer exists — remove from the book WITHOUT any
          // release (nothing to release; the funds sit in the treasury).
          try { this.book.cancel(r.orderId, this.book.getOrder(r.orderId)?.agentId ?? "?"); } catch { /* already gone */ }
          break;
        }
        case "trade_intent": {
          this.fillsByAgent.set(r.fill.takerId, (this.fillsByAgent.get(r.fill.takerId) ?? 0) + 1);
          this.fillsByAgent.set(r.fill.makerId, (this.fillsByAgent.get(r.fill.makerId) ?? 0) + 1);
          // maker consumed on the book — AND ITS LOCK FOLLOWS THE DELIVERY.
          // LIVE BUG 19d (units law): `locked` counts TRADED UNITS (µ-SAOS)
          // for BOTH sides; the bid's money-leg conversion happens only at
          // the ledger boundary (placement lock / cancel release / settle).
          // The old replay subtracted µ¢ notional from a units counter —
          // corrupting every partially-filled bid's book lock and feeding
          // the phantom boot deficits.
          const maker = this.book.getOrder(r.fill.makerOrderId);
          if (maker) {
            const fillAmt = BigInt(r.fill.amount);
            maker.filled += fillAmt;
            maker.locked -= fillAmt;
            if (maker.locked < 0n) maker.locked = 0n; // replay tolerance for pre-fix journals (loud ghost trail already recorded)
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
        case "econ": {
          this.epochOps.push({ kind: r.kind, epoch: r.epoch, agentId: r.agentId, amount: r.amount, ref: r.ref });
          if (r.kind === "payroll" || r.kind === "tax" || r.kind === "reward") {
            this.paidKeys.add(`${r.kind}:${r.epoch}:${r.agentId}`);
          }
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

  /** Per-agent stake account on the quote ledger — where committed (locked) USDS lives. */
  private async ensureStake(agentId: string): Promise<string> {
    const cached = this.stakeAccounts.get(agentId);
    if (cached) return cached;
    const name = `stake:${agentId}:usds`;
    const existing = (await this.quote.listAccounts("sovereign")).find((a) => a.name === name);
    // owner must NEVER be "system" — system-owned accounts collide with the
    // reserve-restore identity (equity-keyed now, but honest owners keep the
    // account graph self-describing: stake:<id> is the accountable principal).
    const id = existing?.id ?? (await this.quote.createAccount("sovereign", `stake:${agentId}`, "asset", name)).id;
    this.stakeAccounts.set(agentId, id);
    return id;
  }

  private requireAgent(agentId: string): { quoteId: string; baseId: string } {
    const pair = this.agentAccounts.get(agentId);
    if (!pair) throw new MarketError(`unknown agent ${agentId}`, "AGENT_UNKNOWN");
    return pair;
  }

  private async feeBalance(): Promise<bigint> {
    return (await this.quote.getAccount("sovereign", this.feeAccountId)).balance;
  }

  // ─── Staking (agent-signed) ─────────────────────────────────────────────────

  /** Agent commits free USDS into its stake account (escrow-like, engine-level). */
  async stake(agentId: string, amount: bigint, stakeId: string): Promise<{ staked: string }> {
    this.guardLive();
    if (amount <= 0n) throw new MarketError("stake amount must be > 0", "BAD_AMOUNT");
    if (!/^[\w.\-:]{1,128}$/.test(stakeId)) throw new MarketError("stakeId must match [\\w.\\-:]{1,128}", "BAD_REF");
    const { quoteId } = this.requireAgent(agentId);
    const free = BigInt((await this.balances(agentId)).usdsAvailable);
    if (free < amount) throw new MarketError(`agent ${agentId}: insufficient free USDS (${free} < ${amount})`, "INSUFFICIENT_QUOTE");
    const stakeIdAcc = await this.ensureStake(agentId);
    await this.quote.transfer("sovereign", quoteId, stakeIdAcc, amount, `stake ${agentId}`, "market", `stake:${agentId}:${stakeId}`);
    await this.journal.append({ t: "econ", kind: "stake", epoch: "", agentId, amount: amount.toString(), ref: stakeId });
    this.epochOps.push({ kind: "stake", epoch: "", agentId, amount: amount.toString(), ref: stakeId });
    return { staked: (await this.stakedOf(agentId)).toString() };
  }

  /** Agent releases committed USDS back to free balance. */
  async unstake(agentId: string, amount: bigint, stakeId: string): Promise<{ staked: string }> {
    this.guardLive();
    if (amount <= 0n) throw new MarketError("unstake amount must be > 0", "BAD_AMOUNT");
    if (!/^[\w.\-:]{1,128}$/.test(stakeId)) throw new MarketError("stakeId must match [\\w.\\-:]{1,128}", "BAD_REF");
    const { quoteId } = this.requireAgent(agentId);
    const stakedNow = await this.stakedOf(agentId);
    if (stakedNow < amount) throw new MarketError(`agent ${agentId}: insufficient staked USDS (${stakedNow} < ${amount})`, "INSUFFICIENT_STAKE");
    const stakeIdAcc = await this.ensureStake(agentId);
    await this.quote.transfer("sovereign", stakeIdAcc, quoteId, amount, `unstake ${agentId}`, "market", `unstake:${agentId}:${stakeId}`);
    await this.journal.append({ t: "econ", kind: "unstake", epoch: "", agentId, amount: amount.toString(), ref: stakeId });
    this.epochOps.push({ kind: "unstake", epoch: "", agentId, amount: amount.toString(), ref: stakeId });
    return { staked: (stakedNow - amount).toString() };
  }

  private async stakedOf(agentId: string): Promise<bigint> {
    return (await this.quote.getAccount("sovereign", await this.ensureStake(agentId))).balance;
  }

  // ─── Sovereign fiscal ops (operator-signed) ─────────────────────────────────

  /**
   * Payroll: the treasury pays every registered agent a fixed wage for the epoch.
   * Fail-closed: if the treasury cannot cover ALL wages, nothing is paid.
   * Idempotent per (epoch, agent) at two layers — engine paidKeys (replay-built) + ledger idem key.
   */
  async payroll(epoch: string, wage: bigint): Promise<{ paid: number; total: string; skipped: number }> {
    this.guardLive();
    if (!epoch || epoch.length > 64) throw new MarketError("epoch is required (≤64 chars)", "BAD_EPOCH");
    if (wage <= 0n) throw new MarketError("wage must be > 0", "BAD_AMOUNT");
    const agentIds = [...this.agentAccounts.keys()].sort();
    const pending = agentIds.filter((a) => !this.paidKeys.has(`payroll:${epoch}:${a}`));
    const need = wage * BigInt(pending.length);
    const treasury = await this.feeBalance();
    if (treasury < need) {
      throw new MarketError(`treasury cannot cover payroll: ${treasury} < ${need} (${pending.length} × ${wage})`, "INSUFFICIENT_TREASURY");
    }
    let paid = 0;
    for (const agentId of pending) {
      const { quoteId } = this.requireAgent(agentId);
      await this.quote.transfer("sovereign", this.feeAccountId, quoteId, wage, `payroll ${epoch} ${agentId}`, "market", `payroll:${epoch}:${agentId}`);
      await this.journal.append({ t: "econ", kind: "payroll", epoch, agentId, amount: wage.toString(), ref: `payroll:${epoch}:${agentId}` });
      this.epochOps.push({ kind: "payroll", epoch, agentId, amount: wage.toString(), ref: `payroll:${epoch}:${agentId}` });
      this.paidKeys.add(`payroll:${epoch}:${agentId}`);
      paid++;
    }
    return { paid, total: (wage * BigInt(paid)).toString(), skipped: agentIds.length - paid };
  }

  /** Tax: per epoch, each agent pays floor(free × rateBps/10000) into the treasury. Idempotent per (epoch, agent). */
  async tax(epoch: string, rateBps: bigint): Promise<{ collected: string; taxed: number; skipped: number }> {
    this.guardLive();
    if (!epoch || epoch.length > 64) throw new MarketError("epoch is required (≤64 chars)", "BAD_EPOCH");
    if (rateBps < 0n || rateBps > 10000n) throw new MarketError("rateBps must be 0..10000", "BAD_RATE");
    let collected = 0n;
    let taxed = 0;
    let skipped = 0;
    for (const agentId of [...this.agentAccounts.keys()].sort()) {
      if (this.paidKeys.has(`tax:${epoch}:${agentId}`)) { skipped++; continue; }
      const free = BigInt((await this.balances(agentId)).usdsAvailable);
      const levy = free * rateBps / 10000n;
      if (levy <= 0n) { skipped++; continue; }
      const { quoteId } = this.requireAgent(agentId);
      await this.quote.transfer("sovereign", quoteId, this.feeAccountId, levy, `tax ${epoch} ${agentId}`, "market", `tax:${epoch}:${agentId}`);
      await this.journal.append({ t: "econ", kind: "tax", epoch, agentId, amount: levy.toString(), ref: `tax:${epoch}:${agentId}` });
      this.epochOps.push({ kind: "tax", epoch, agentId, amount: levy.toString(), ref: `tax:${epoch}:${agentId}` });
      this.paidKeys.add(`tax:${epoch}:${agentId}`);
      collected += levy;
      taxed++;
    }
    return { collected: collected.toString(), taxed, skipped };
  }

  /**
   * Staking rewards: distribute floor(treasury × rateBps/10000) to stakers, pro-rata by stake.
   * Deterministic (sorted), remainder stays in the treasury — reported honestly.
   */
  async rewards(epoch: string, rateBps: bigint): Promise<{ budget: string; distributed: string; stakers: number; remainder: string }> {
    this.guardLive();
    if (!epoch || epoch.length > 64) throw new MarketError("epoch is required (≤64 chars)", "BAD_EPOCH");
    if (rateBps < 0n || rateBps > 10000n) throw new MarketError("rateBps must be 0..10000", "BAD_RATE");
    const stakers: { agentId: string; stake: bigint }[] = [];
    for (const agentId of [...this.agentAccounts.keys()].sort()) {
      const s = await this.stakedOf(agentId);
      if (s > 0n) stakers.push({ agentId, stake: s });
    }
    if (stakers.length === 0) return { budget: "0", distributed: "0", stakers: 0, remainder: "0" };
    const treasury = await this.feeBalance();
    const budget = treasury * rateBps / 10000n;
    if (budget <= 0n) return { budget: "0", distributed: "0", stakers: stakers.length, remainder: "0" };
    const totalStake = stakers.reduce((s, x) => s + x.stake, 0n);
    let distributed = 0n;
    for (const { agentId, stake } of stakers) {
      if (this.paidKeys.has(`reward:${epoch}:${agentId}`)) continue;
      const share = budget * stake / totalStake;
      if (share <= 0n) continue;
      const { quoteId } = this.requireAgent(agentId);
      await this.quote.transfer("sovereign", this.feeAccountId, quoteId, share, `stake-reward ${epoch} ${agentId}`, "market", `reward:${epoch}:${agentId}`);
      await this.journal.append({ t: "econ", kind: "reward", epoch, agentId, amount: share.toString(), ref: `reward:${epoch}:${agentId}` });
      this.epochOps.push({ kind: "reward", epoch, agentId, amount: share.toString(), ref: `reward:${epoch}:${agentId}` });
      this.paidKeys.add(`reward:${epoch}:${agentId}`);
      distributed += share;
    }
    return { budget: budget.toString(), distributed: distributed.toString(), stakers: stakers.length, remainder: (budget - distributed).toString() };
  }

  /** The sovereign treasury mints initial allocation to an agent (genuine credit creation through the guard). */
  async allocate(agentId: string, usds: string, saos: string): Promise<void> {
    this.guardLive();
    const { quoteId, baseId } = await this.registerAgent(agentId);
    if (parseMicroCents(usds) > 0n) {
      await this.quote.guardMint("sovereign", quoteId, parseMicroCents(usds), `genesis allocation ${agentId}`, "treasury", `alloc:${agentId}:usds`);
    }
    if (BigInt(saos) > 0n) {
      await this.base.guardMint("sovereign", baseId, BigInt(saos), `genesis allocation ${agentId}`, "treasury", `alloc:${agentId}:saos`);
    }
  }

  /** Re-allocation: honest liquidity restoration for an EXISTING agent whose
   *  allocation was lost to an era accident (e.g. the SAOS supply wiped with a
   *  sandbox reboot — the live bug of 2026-10-18: the whole economy held USDS
   *  but zero SAOS, so no ask could ever rest and every economy-run was
   *  INCONCLUSIVE). Ref-scoped idempotency: the same ref never double-mints;
   *  a new ref is a new, signed, journaled decision. Genuine credit creation
   *  through the guard, audited as econ/correction records. */
  async realloc(agentId: string, usds: string, saos: string, ref: string): Promise<{ usdsIdem: string; saosIdem: string }> {
    this.guardLive();
    if (!/^[\w.\-:]{1,128}$/.test(ref)) throw new MarketError("ref must match [\\w.\\-:]{1,128}", "BAD_REF");
    const { quoteId, baseId } = await this.registerAgent(agentId);
    // UNITS — read before calling (the ×10⁴ trap bit Task 27 AND Task 29):
    //   usds: CENT-unit decimal string — "1.00" = 10,000 µ¢ = 0.01 USDS (parseMicroCents).
    //   saos: µ-SAOS integer string — "25000000" = 25 SAOS (BigInt, direct).
    // A signed amount contracts: negative = guardWithdraw (burn into the platform
    // reserve — the ONLY designed destruction path), positive = guardMint.
    const negU = usds.startsWith("-");
    const usdsAmt = (() => { const a = parseMicroCents(negU ? usds.slice(1) : usds); return negU ? -a : a; })();
    const negS = saos.startsWith("-");
    const saosAmt = (() => { const a = BigInt(negS ? saos.slice(1) : saos); return negS ? -a : a; })();
    if (usdsAmt > 0n) {
      await this.quote.guardMint("sovereign", quoteId, usdsAmt, `re-allocation ${agentId} (${ref})`, "treasury", `alloc:${agentId}:usds:${ref}`);
      await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId, amount: usds, ref: `realloc:${ref}:${agentId}:usds` });
    } else if (usdsAmt < 0n) {
      await this.quote.guardWithdraw("sovereign", quoteId, -usdsAmt, `re-allocation withdrawal ${agentId} (${ref})`, "treasury", `alloc-neg:${agentId}:usds:${ref}`);
      await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId, amount: usds, ref: `realloc:${ref}:${agentId}:usds` });
    }
    if (saosAmt > 0n) {
      await this.base.guardMint("sovereign", baseId, saosAmt, `re-allocation ${agentId} (${ref})`, "treasury", `alloc:${agentId}:saos:${ref}`);
      await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId, amount: saos, ref: `realloc:${ref}:${agentId}:saos` });
    } else if (saosAmt < 0n) {
      await this.base.guardWithdraw("sovereign", baseId, -saosAmt, `re-allocation withdrawal ${agentId} (${ref})`, "treasury", `alloc-neg:${agentId}:saos:${ref}`);
      await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId, amount: saos, ref: `realloc:${ref}:${agentId}:saos` });
    }
    return { usdsIdem: `alloc:${agentId}:usds:${ref}`, saosIdem: `alloc:${agentId}:saos:${ref}` };
  }

  // ─── Balances / reading ────────────────────────────────────────────────────

  async balances(agentId: string): Promise<{ usdsAvailable: string; usdsLocked: string; usdsStaked: string; saosAvailable: string; saosLocked: string }> {
    const { quoteId, baseId } = await this.registerAgent(agentId);
    const q = await this.quote.getAccount("sovereign", quoteId);
    const b = await this.base.getAccount("sovereign", baseId);
    const qLocked = await this.sumLockedQuote(agentId);
    const bLocked = await this.sumLockedBase(agentId);
    return {
      usdsAvailable: q.balance.toString(),
      usdsLocked: qLocked.toString(),
      usdsStaked: (await this.stakedOf(agentId)).toString(),
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
    this.guardLive();
    const { agentId, orderId, side, price, amount } = params;
    const type = params.type ?? "limit";
    if (this.usedOrderIds.has(orderId)) {
      // fail-closed: a reused id would let the currency ledger's idempotency
      // REPLAY an old lock transfer (no money moves) while the book counts a
      // fresh lock — the structural lock/escrow divergence behind live bug 13.
      throw new BookError(`order id ${orderId} was already used in a previous era — order ids are forever-unique`, "DUPLICATE_ORDER_ID");
    }
    if (this.book.getOrder(orderId)) throw new BookError(`order ${orderId} already on book`, "DUPLICATE_ORDER_ID");

    // 1) capacity pre-check on the locking asset (fail-closed BEFORE any mutation)
    // LIVE BUG 19d: bids pre-check their EXACT ceil µ¢ cost (notional+remainder)
    // — the same amount the escrow lock will demand, so a dust-short balance
    // can never pass the check and then die mid-lock (after fills executed).
    const bal = await this.balances(agentId);
    if (side === "bid") {
      const need = exactCeilMicro(price, amount); // LIVE BUG 19d/20: the exact µ¢ the escrow lock will demand
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
      this.usedOrderIds.add(fill.makerOrderId);
      this.usedOrderIds.add(fill.takerOrderId);
    }

    // 4) resting remainder → lock into market escrow (idempotent by orderId).
    //    locked===0 → nothing rests (full fill, or IOC remainder which the book already killed):
    //    journal NOTHING — a phantom resting record would re-materialize the order on replay.
    //    LIVE BUG 19d: bids lock their EXACT ceil µ¢ (notional+remainder) —
    //    the old floor-lock underfunded every bid by its rounding dust while
    //    settlement paid ceil — µ-dust leak per fill, forever.
    if (res.order.locked > 0n) {
      await this.journal.append({ t: "resting", order: sOrder(res.order) });
      this.usedOrderIds.add(orderId);
      if (side === "bid") {
        // LIVE BUG 19d/20: the lock is the EXACT ceil µ¢ of the resting units
        // (the same law settle pays by) — the old floor-lock underfunded every
        // bid by its rounding dust while settlement paid more.
        await this.quote.transfer("sovereign", (await this.registerAgent(agentId)).quoteId, this.escrowQuoteId, exactCeilMicro(price, res.order.locked), `lock bid ${orderId}`, "market", `lock:${orderId}`);
      } else {
        await this.base.transfer("sovereign", (await this.registerAgent(agentId)).baseId, this.escrowBaseId, res.order.locked, `lock ask ${orderId}`, "market", `lock:${orderId}`);
      }
    }

    return { order: res.order, fills: res.fills };
  }

  /** Cancel: release the escrow lock (idempotent), remove from book, journal. */
  async cancelOrder(agentId: string, orderId: string): Promise<{ released: string }> {
    this.guardLive();
    const res = this.book.cancel(orderId, agentId);
    await this.journal.append({ t: "canceled", orderId, released: res.release.amount.toString() });
    if (res.release.amount > 0n) {
      if (res.release.asset === "quote") {
        // LIVE BUG 19d/20: release.amount is remaining UNITS — release their
        // exact ceil µ¢ (the same law the placement lock used; never floor,
        // never remainder-as-µ¢).
        await this.quote.transfer("sovereign", this.escrowQuoteId, (await this.registerAgent(agentId)).quoteId, exactCeilMicro(res.order.price, res.release.amount), `release bid ${orderId}`, "market", `rel:${orderId}`);
      } else {
        await this.base.transfer("sovereign", this.escrowBaseId, (await this.registerAgent(agentId)).baseId, res.release.amount, `release ask ${orderId}`, "market", `rel:${orderId}`);
      }
    }
    return { released: res.release.amount.toString() };
  }

  /** Settle one fill: quote leg + base leg, each idempotent by tradeId.
   *
   *  LIVE BUG 19 (root-fixed): the maker's escrowed lock IS the settlement
   *  float, and a taker pays/delivers from their OWN balances —
   *   • taker buys  (maker sells): unchanged — the maker's µ-SAOS lock
   *     delivers escrow→taker; the taker pays fee+price from their own
   *     quote balance.
   *   • taker sells (maker buys): the TAKER delivers from their OWN base
   *     balance (the old code paid the buyer out of the SHARED escrow pool
   *     while the taker never deposited — draining other makers' backing
   *     until the whole delivery side collapsed: 856 undelivered base legs),
   *     and the maker's escrowed µ¢ lock pays fee+price to the taker (the
   *     old code paid from the maker's available balance while their lock
   *     sat stuck in escrow — the phantom surplus behind the boot refunds).
   *  BASE leg first on the taker-sell path: if the taker cannot deliver,
   *  nothing else moves (fail-closed, no partial settlement). */
  private async settleFill(f: Fill): Promise<void> {
    // exact buyer cost = ceil µ¢ of the traded value (LIVE BUG 20 root-fix:
    // the old `notional + remainder` charged the sub-µ¢ remainder as WHOLE µ¢
    // — up to ~1 USDS of phantom cost per fill, trade-657 paid 76% over).
    const buyerPays = f.notional + (f.remainder > 0n ? 1n : 0n);
    const fee = f.notional * FEE_BPS / 10000n;
    const makerReceives = buyerPays - fee;
    const takerIsBid = f.side === "bid";

    const buyerQuoteId = (await this.registerAgent(takerIsBid ? f.takerId : f.makerId)).quoteId;
    const sellerQuoteId = (await this.registerAgent(takerIsBid ? f.makerId : f.takerId)).quoteId;
    const sellerBaseId = (await this.registerAgent(takerIsBid ? f.makerId : f.takerId)).baseId;
    const buyerBaseId = (await this.registerAgent(takerIsBid ? f.takerId : f.makerId)).baseId;

    if (takerIsBid) {
      // QUOTE leg: buyer(taker) → fee + seller, from the taker's own balance
      await this.quote.transfer("sovereign", buyerQuoteId, this.feeAccountId, fee, `fee ${f.tradeId}`, "market", `${f.tradeId}:fee`);
      await this.quote.transfer("sovereign", buyerQuoteId, sellerQuoteId, makerReceives, `settle ${f.tradeId}`, "market", `${f.tradeId}:q`);
      // BASE leg: the maker's escrowed lock → buyer(taker)
      await this.base.transfer("sovereign", this.escrowBaseId, buyerBaseId, f.amount, `deliver ${f.tradeId}`, "market", `${f.tradeId}:b`);
    } else {
      // BASE leg first: the taker-seller delivers from their OWN balance
      await this.base.transfer("sovereign", sellerBaseId, buyerBaseId, f.amount, `deliver ${f.tradeId}`, "market", `${f.tradeId}:b`);
      // QUOTE leg: the maker's escrowed bid-lock → fee + taker-seller
      await this.quote.transfer("sovereign", this.escrowQuoteId, this.feeAccountId, fee, `fee ${f.tradeId}`, "market", `${f.tradeId}:fee`);
      await this.quote.transfer("sovereign", this.escrowQuoteId, sellerQuoteId, makerReceives, `settle ${f.tradeId}`, "market", `${f.tradeId}:q`);
    }
  }

  // ─── Proofs ────────────────────────────────────────────────────────────────

  /**
   * Global conservation per asset: minted == Σ(available) + Σ(escrow) + fees.
   * This is THE economic invariant — the selftest asserts it after every storm.
   */
  async conservation(): Promise<{
    quote: { minted: string; inAccounts: string; inEscrow: string; staked: string; fees: string; holds: boolean };
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
    // stake accounts are asset accounts too — they are a SUBSET of inAccounts (committed, not free);
    // exposed separately for transparency. The identity itself is unchanged.
    const qStaked = qAccounts.filter((a) => a.name.startsWith("stake:")).reduce((s, a) => s + a.balance, 0n);
    const qAssetNoEscrowNoFee = qSum - qEscrow - qFees;
    return {
      quote: { minted: qMinted.toString(), inAccounts: qAssetNoEscrowNoFee.toString(), inEscrow: qEscrow.toString(), staked: qStaked.toString(), fees: qFees.toString(), holds: qMinted === qAssetNoEscrowNoFee + qEscrow + qFees },
      base: { minted: bMinted.toString(), inAccounts: (bSum - bEscrow).toString(), inEscrow: bEscrow.toString(), holds: bMinted === bSum },
    };
  }

  stats(): { book: ReturnType<OrderBook["stats"]>; settled: number; phantomsSkipped: number } {
    return {
      book: this.book.stats(),
      settled: this.settledTrades.size,
      phantomsSkipped: this.phantomsSkipped,
      ghostsBootQuote: this.ghostsBoot.quote.count,
      ghostsBootQuoteAmount: this.ghostsBoot.quote.amount.toString(),
      ghostsBootBase: this.ghostsBoot.base.count,
      ghostsBootBaseAmount: this.ghostsBoot.base.amount.toString(),
      quiesced: this.quiesced,
    };
  }

  /** Real per-agent economics — computed from the live ledgers, never estimated. */
  async economyReport(): Promise<{ agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[]> {
    const out: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[] = [];
    for (const agentId of this.agentAccounts.keys()) {
      const b = await this.balances(agentId);
      out.push({
        agentId,
        usds: b.usdsAvailable,
        usdsLocked: b.usdsLocked,
        usdsStaked: b.usdsStaked,
        saos: b.saosAvailable,
        saosLocked: b.saosLocked,
        fills: this.fillsByAgent.get(agentId) ?? 0,
      });
    }
    return out;
  }

  /** Treasury (platform fee account) balance — the real income of the network. */
  async treasury(): Promise<{ usds: string }> {
    return { usds: (await this.feeBalance()).toString() };
  }

  /**
   * Honest correction: bring a NEGATIVE account back to exactly zero, funded by
   * the equity (reserve) line. Operator-signed, idempotent by correctionId
   * (three layers: epochOps audit rebuilt on replay + ledger idem key + the
   * ≥0 guard), journaled as kind:"correction". Fail-closed: known accounts
   * only, never an equity account, never below zero, never a top-up.
   */
  async correct(ledgerName: "usds" | "saos", accountName: string, correctionId: string): Promise<{ corrected: string }> {
    this.guardLive();
    if (!/^[\w.\-:]{1,128}$/.test(correctionId)) throw new MarketError("correctionId must match [\\w.\\-:]{1,128}", "BAD_REF");
    if (this.epochOps.some((op) => op.kind === "correction" && op.ref === correctionId)) {
      return { corrected: "0" }; // already applied — honest no-op
    }
    const led = ledgerName === "usds" ? this.quote : this.base;
    const accounts = await led.listAccounts("sovereign");
    const target = accounts.find((a) => a.name === accountName);
    if (!target) throw new MarketError(`unknown account ${accountName}`, "ACCOUNT_UNKNOWN");
    if (target.type === "equity") throw new MarketError("refusing to correct an equity account", "BAD_ACCOUNT");
    const bal = BigInt(target.balance);
    if (bal >= 0n) return { corrected: "0" }; // nothing to correct — honest no-op
    const reserve = accounts.find((a) => a.type === "equity");
    if (!reserve) throw new MarketError("no equity account on this ledger", "NO_RESERVE");
    const amount = -bal;
    await led.transfer("sovereign", reserve.id, target.id, amount, `correction ${accountName}`, "market", `correction:${correctionId}`);
    this.epochOps.push({ kind: "correction", epoch: "", agentId: accountName, amount: amount.toString(), ref: correctionId });
    await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: accountName, amount: amount.toString(), ref: correctionId });
    return { corrected: amount.toString() };
  }

  /**
   * admitLegacyCredit — the honest path for a NEGATIVE asset account whose hole
   * predates the current hash-chain window (wipe-era artifact that transfer,
   * the designed balance-checked path, can never repair: the reserve lacks the
   * funds). This admits the legacy credit as what it actually is — issued
   * equity — through guardMint, the ONLY designed chokepoint for credit
   * creation. Operator-signed, journaled (kind:"correction"), idempotent by
   * correctionId. Fail-closed: known accounts only, never an equity account,
   * never a positive account, never a top-up of wealth — only zeroing a hole
   * so the books tell the truth instead of hiding it in a negative asset.
   */
  async admitLegacyCredit(ledgerName: "usds" | "saos", accountName: string, correctionId: string): Promise<{ admitted: string }> {
    this.guardLive();
    if (!/^[\w.\-:]{1,128}$/.test(correctionId)) throw new MarketError("correctionId must match [\\w.\\-:]{1,128}", "BAD_REF");
    if (this.epochOps.some((op) => (op.kind === "correction") && op.ref === `admit:${correctionId}`)) {
      return { admitted: "0" }; // already applied — honest no-op
    }
    const led = ledgerName === "usds" ? this.quote : this.base;
    const accounts = await led.listAccounts("sovereign");
    const target = accounts.find((a) => a.name === accountName);
    if (!target) throw new MarketError(`unknown account ${accountName}`, "ACCOUNT_UNKNOWN");
    if (target.type === "equity") throw new MarketError("refusing to admit credit onto an equity account", "BAD_ACCOUNT");
    const bal = BigInt(target.balance);
    if (bal >= 0n) return { admitted: "0" }; // nothing to admit — honest no-op
    const amount = -bal;
    await led.guardMint("sovereign", target.id, amount, `legacy credit admission ${accountName} (${correctionId})`, "treasury", `admit:${correctionId}`);
    this.epochOps.push({ kind: "correction", epoch: "", agentId: accountName, amount: amount.toString(), ref: `admit:${correctionId}` });
    await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: accountName, amount: amount.toString(), ref: `admit:${correctionId}` });
    return { admitted: amount.toString() };
  }

  // ─── Task 30: historical-damage repair (evidence-based, operator-approved) ──
  //
  // The plan is ALWAYS recomputed here from this engine's own journals + live
  // balances — the request body never carries amounts (fail-closed). The
  // operator approves one exact plan version by its sha256; a mismatch refuses
  // with the current plan hash so approval can never drift from reality.

  /** Fresh repair plan from the journals + live balances (read-only). */
  async historicalRepairPlan(): Promise<RepairPlan> {
    const usdsAccounts = (await this.quote.listAccounts("sovereign")).map((a) => ({ id: a.id, name: a.name, balance: a.balance.toString() }));
    const saosAccounts = (await this.base.listAccounts("sovereign")).map((a) => ({ id: a.id, name: a.name, balance: a.balance.toString() }));
    return computeHistoricalRepairPlan({ dataDir: this.dataDir, usdsAccounts, saosAccounts });
  }

  /** Plan account name → live ledger account id (fail-closed). */
  private async repairResolve(ledger: "usds" | "saos", name: string): Promise<string> {
    const special = ledger === "usds"
      ? { "platform-fee": this.feeAccountId, "market-escrow-quote": this.escrowQuoteId, treasury: this.treasuryQuoteId }
      : { "market-escrow-base": this.escrowBaseId, treasury: this.treasuryBaseId };
    if (special[name]) return special[name];
    const m = /^agent:([a-z0-9\-]+):(usds|saos)$/.exec(name);
    if (m && m[2] === ledger) {
      const pair = await this.registerAgent(m[1]);
      return ledger === "usds" ? pair.quoteId : pair.baseId;
    }
    const led = ledger === "usds" ? this.quote : this.base;
    const found = (await led.listAccounts("sovereign")).find((a) => a.name === name);
    if (found) return found.id;
    throw new MarketError(`repair: unknown account ${name} on ${ledger}`, "ACCOUNT_UNKNOWN");
  }

  /**
   * Execute an operator-approved repair plan.
   *  • sha must match a fresh recompute (approval can never drift from reality)
   *  • quiesces the market for the whole execution (balances frozen → the
   *    plan's serial feasibility simulation holds exactly)
   *  • every leg is idempotent (repair:<kind>:<ref>) — replays are honest no-ops
   *  • a leg whose debit balance cannot cover it is recorded as a documented
   *    shortfall (the residual debt stays visible, nothing is fabricated)
   */
  async executeHistoricalRepair(approvedSha: string): Promise<{
    planSha256: string; executed: number; zero: number; shortfall: number;
    movedUsds: string; movedSaos: string;
    results: { kind: string; ref: string; idem: string; status: string; payable: string; shortfall: string }[];
    conservation: Awaited<ReturnType<MarketEngine["conservation"]>>;
  }> {
    if (!/^[0-9a-f]{64}$/.test(approvedSha)) throw new MarketError("approved plan sha must be 64 hex chars", "BAD_SHA");
    // NOTE: no guardLive() here — the operator may deliberately quiesce before
    // executing (consistency window). We keep an externally-set quiesce ON.
    const wasQuiesced = this.quiesced;
    const plan = await this.historicalRepairPlan();
    if (plan.planSha256 !== approvedSha) {
      throw new MarketError(
        `plan sha mismatch — the plan changed since approval (approved ${approvedSha.slice(0, 12)}…, current ${plan.planSha256.slice(0, 12)}…); re-approve the current plan`,
        "PLAN_SHA_MISMATCH",
      );
    }
    this.quiesce(true);
    const results: { kind: string; ref: string; idem: string; status: string; payable: string; shortfall: string }[] = [];
    let executed = 0, zero = 0, shortfall = 0;
    let movedUsds = 0n, movedSaos = 0n;
    try {
      for (const act of plan.actions) {
        const owed = BigInt(act.owed); const pay = BigInt(act.payable);
        if (pay <= 0n) {
          if (owed > 0n) { shortfall++; results.push({ kind: act.kind, ref: act.ref, idem: act.idem, status: "shortfall", payable: act.payable, shortfall: act.shortfall }); }
          else { zero++; results.push({ kind: act.kind, ref: act.ref, idem: act.idem, status: "zero", payable: act.payable, shortfall: act.shortfall }); }
          continue;
        }
        try {
          const debitId = await this.repairResolve(act.ledger, act.debitName);
          const creditId = await this.repairResolve(act.ledger, act.creditName);
          const led = act.ledger === "usds" ? this.quote : this.base;
          // Honest replay guard: an idem that already landed is a no-op — it
          // must NOT be counted as executed nor added to the moved totals.
          if (led.hasIdem(act.idem)) {
            results.push({ kind: act.kind, ref: act.ref, idem: act.idem, status: "replayed", payable: act.payable, shortfall: act.shortfall });
            continue;
          }
          await led.transfer("sovereign", debitId, creditId, pay, act.memo, "operator-repair", act.idem);
          executed++;
          if (act.ledger === "usds") movedUsds += pay; else movedSaos += pay;
          results.push({ kind: act.kind, ref: act.ref, idem: act.idem, status: "executed", payable: act.payable, shortfall: act.shortfall });
        } catch (e) {
          if (e instanceof LedgerError && e.code === "INSUFFICIENT_FUNDS") {
            shortfall++;
            results.push({ kind: act.kind, ref: act.ref, idem: act.idem, status: "shortfall", payable: act.payable, shortfall: act.shortfall });
          } else throw e;
        }
      }
      if (executed > 0) {
        await this.journal.append({ t: "econ", kind: "correction", epoch: "", agentId: "market-repair", amount: movedUsds.toString(), ref: `repair-run:${plan.planSha256.slice(0, 16)} legs=${executed}` });
      }
    } finally {
      // resume only if WE quiesced — an operator-set quiesce stays on
      if (!wasQuiesced) this.quiesce(false);
    }
    return { planSha256: plan.planSha256, executed, zero, shortfall, movedUsds: movedUsds.toString(), movedSaos: movedSaos.toString(), results, conservation: await this.conservation() };
  }

  /** Last n economy ops from the audit trail (stake/payroll/tax/reward). */
  epochReport(n: number): EconOp[] {
    return this.epochOps.slice(-Math.max(0, n));
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
