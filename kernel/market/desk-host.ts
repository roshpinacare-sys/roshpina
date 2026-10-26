/**
 * kernel/market/desk-host.ts — runs the designated liquidity desks INSIDE the
 * market node (market-serve.ts). The host is the only impure layer: it reads
 * the real oracle file, calls the real engine, and journals every action.
 *
 * ריבונות-וחשיפה: השולחנות הם עקרונות-רגילים של הכלכלה (mm-grid, mm-oracle) —
 * אותן-עמלות, אותו-escrow, אותו-שימור; הזריעה היא guardMint חד-פעמי
 * (idempotent לפי-שם-בפנקס) ומתועדת-ביומן. אין-הרשאת-על. אין-עקיפת-חוק.
 *
 * הכל fail-closed: oracle חסר/ישן → השולחן-החיצוני מחזיק; כשל-טיק אחד לא
 * מפיל את הלופ; SIGTERM → הפסקה-נקייה (ה-interval unref'd).
 */

import { existsSync, readFileSync, appendFileSync, statSync, writeFileSync, renameSync } from "fs";
import { parseMicroCents } from "../ledger/persistent-ledger";
import type { MarketEngine } from "./engine";
import {
  deskIntents, newDeskState, oracleRegime, recordFill, onMakerPrint,
} from "./liquidity-desk";
import type { DeskConfig, DeskState, OracleView, OracleRegime } from "./liquidity-desk";
import { newTunerState, tuneGridDesk } from "./desk-tuner";
import type { TunerState } from "./desk-tuner";

export interface DeskHostOptions {
  oraclePath: string;
  tickMs: number;
  /** זריעה-חד-פעמית: מחרוזת-סנט ל-parseMicroCents ("5000" = 50 USDS) */
  seedUsdsCents: string;
  /** זריעה-חד-פעמית בµ-SAOS ("15000000" = 15 SAOS) */
  seedSaosU: string;
  /** (grid) מרווח-רמה בµ¢ — ברירת-מחדל 1500 */
  gridStepU?: bigint;
  /** (oracle) סף-ספר-רחב בµ¢ — ברירת-מחדל 4000 */
  oracleMaxSpreadU?: bigint;
  journalPath: string;
  now?: () => number;
  /** (tuner D1) מרווח-מינימלי-בין-מוטציות-כוונון בms — ברירת-מחדל 15 דקות (probe מכווץ) */
  tuneMinIntervalMs?: number;
}

const GRID_CFG: DeskConfig = {
  agentId: "mm-grid", kind: "grid", levels: 5, stepU: 1_500n,
  sizeU: 1_000_000n, genesisPriceU: 250_000n,
  alphaPpm: 200_000, maxSpreadU: 3_000n,
};
const ORACLE_CFG: DeskConfig = {
  agentId: "mm-oracle", kind: "oracle", levels: 0, stepU: 1_500n,
  sizeU: 1_000_000n, genesisPriceU: 250_000n,
  alphaPpm: 0, maxSpreadU: 4_000n,
};

const JOURNAL_MAX_BYTES = 2_000_000;
const JOURNAL_KEEP = 400;

interface AnchRec { at: string; source: string; network: string; pair: string; last?: string; bid?: string; ask?: string; rawSha256?: string }

export class DeskHost {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** עותקי-cfg פר-דסק — נבנים בקונסטרוקטור *אחרי* עקיפות-הסביבה, כדי שה-env יגיע
   *  לעותקים; ה-tuner מוטט את העותק-בלבד, לעולם לא את הקבועים-המודוליים */
  private desks: { cfg: DeskConfig; state: DeskState }[];
  /** D1 strategy-tuner state (grid desk בלבד) */
  private tuner: TunerState;
  private tuneMinIntervalMs = 900_000;
  private oracleCache: OracleView = { ageMin: null, source: null, networks: 0, volPct: null };
  private busy = false;
  private now: () => number;
  public startedAt = "";
  /** resting-order tracker per desk — fills against OUR resting orders are
   *  matched inside the engine and never pass through placeOrder; the primary
   *  evidence is the book itself (filled counter per order). */
  private tracker = new Map<string, Map<string, { side: "bid" | "ask"; price: bigint; filled: bigint; remaining: bigint }>>();
  private justCanceled = new Map<string, Set<string>>();
  /** boot-unique epoch — desk order ids embed it so a REBOOT can never collide
   *  with the forever-unique usedOrderIds registry (the 2026-10-26 lesson:
   *  tickNo restarts at 1 every boot; without this the next restart would
   *  refuse every desk placement with DUPLICATE_ORDER_ID). */
  private bootEpoch = Date.now().toString(36);

  constructor(private engine: MarketEngine, private opts: DeskHostOptions) {
    this.now = opts.now ?? Date.now;
    if (opts.gridStepU !== undefined) GRID_CFG.stepU = opts.gridStepU;
    if (opts.oracleMaxSpreadU !== undefined) ORACLE_CFG.maxSpreadU = opts.oracleMaxSpreadU;
    // עותקים אחרי-העקיפות — ערכי-env חיים בעותקים; הקבועים-המודוליים נשארים-בראשית
    this.desks = [
      { cfg: { ...GRID_CFG }, state: newDeskState() },
      { cfg: { ...ORACLE_CFG }, state: newDeskState() },
    ];
    const grid = this.desks.find((d) => d.cfg.kind === "grid");
    this.tuner = newTunerState(grid ? grid.cfg.stepU : 1_500n, grid ? grid.cfg.maxSpreadU : 3_000n, this.now());
    this.tuneMinIntervalMs = opts.tuneMinIntervalMs ?? 900_000;
  }

  // ── oracle (primary evidence from the real anchors file) ───────────────────
  private readOracle(): OracleView {
    const empty: OracleView = { ageMin: null, source: null, networks: 0, volPct: null };
    try {
      if (!existsSync(this.opts.oraclePath)) return empty;
      const lines = readFileSync(this.opts.oraclePath, "utf8").trim().split("\n").slice(-400);
      const recs: AnchRec[] = [];
      for (const l of lines) {
        try { recs.push(JSON.parse(l) as AnchRec); } catch { /* skip torn line */ }
      }
      if (recs.length === 0) return empty;
      // batches by `at` — the oracle writes one line per network per run
      const byAt = new Map<string, AnchRec[]>();
      for (const r of recs) {
        const k = r.at ?? "";
        const list = byAt.get(k) ?? [];
        list.push(r);
        byAt.set(k, list);
      }
      const stamps = [...byAt.keys()].sort();
      const newest = stamps[stamps.length - 1];
      if (!newest) return empty;
      const ageMin = (this.now() - Date.parse(newest)) / 60_000;
      // volatility: mean |Δlast|/prev across networks, over consecutive batches
      let volPct: number | null = null;
      if (stamps.length >= 2) {
        const lookback = stamps.slice(-7);
        const deltas: number[] = [];
        for (let i = 1; i < lookback.length; i++) {
          const prev = byAt.get(lookback[i - 1]) ?? [];
          const cur = byAt.get(lookback[i]) ?? [];
          for (const c of cur) {
            const p = prev.find((x) => x.network === c.network && typeof x.last === "string" && typeof c.last === "string");
            if (p && p.last && c.last) {
              const pv = Number(p.last), cv = Number(c.last);
              if (pv > 0 && Number.isFinite(pv) && Number.isFinite(cv)) deltas.push(Math.abs(cv - pv) / pv);
            }
          }
        }
        if (deltas.length > 0) volPct = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      }
      const batch = byAt.get(newest) ?? [];
      return {
        ageMin,
        source: batch[0]?.source ?? null,
        networks: new Set(batch.map((r) => r.network)).size,
        volPct,
      };
    } catch {
      return empty; // fail-closed: unreadable oracle == no oracle
    }
  }

  // ── journal (append-only JSONL, rotated) ───────────────────────────────────
  private journal(rec: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...rec }) + "\n";
      appendFileSync(this.opts.journalPath, line);
      if (statSync(this.opts.journalPath).size > JOURNAL_MAX_BYTES) {
        const lines = readFileSync(this.opts.journalPath, "utf8").trim().split("\n").slice(-JOURNAL_KEEP);
        const tmp = `${this.opts.journalPath}.tmp`;
        writeFileSync(tmp, lines.join("\n") + "\n");
        renameSync(tmp, this.opts.journalPath);
      }
    } catch { /* journaling must never kill the desk */ }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    this.startedAt = new Date(this.now()).toISOString();
    // one-time seed — ledger idempotency by agent name makes this safe across
    // reboots (guardMint with the same idem key never double-mints)
    for (const { cfg } of this.desks) {
      try {
        const b = await this.engine.balances(cfg.agentId);
        const hasEquity = BigInt(b.usdsAvailable || "0") + BigInt(b.saosAvailable || "0") > 0n
          || BigInt(b.usdsLocked || "0") + BigInt(b.saosLocked || "0") > 0n;
        if (!hasEquity) {
          await this.engine.allocate(cfg.agentId, this.opts.seedUsdsCents, this.opts.seedSaosU);
          this.journal({ kind: "seed", desk: cfg.agentId, usdsCents: this.opts.seedUsdsCents, saosU: this.opts.seedSaosU });
        }
      } catch (e) {
        this.journal({ kind: "seed-error", desk: cfg.agentId, error: String((e as Error)?.message ?? e).slice(0, 120) });
      }
    }
    // boot-cancel: adopt-or-cancel — resting orders from a previous life are
    // canceled and re-quoted fresh from the CURRENT book (no ghost desk orders)
    await this.cancelOwnResting("boot-cancel");
    await this.tick(); // first tick immediately
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs);
    this.timer.unref();
    this.journal({ kind: "started", tickMs: this.opts.tickMs, oraclePath: this.opts.oraclePath });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.journal({ kind: "stopped" });
  }

  private async cancelOwnResting(reason: string): Promise<void> {
    try {
      const snap = this.engine.bookSnapshot();
      for (const o of [...snap.bids, ...snap.asks]) {
        if (o.agentId !== "mm-grid" && o.agentId !== "mm-oracle") continue;
        try {
          await this.engine.cancelOrder(o.agentId, o.id);
          this.journal({ kind: reason, desk: o.agentId, orderId: o.id, price: o.price });
        } catch { /* not found — already gone */ }
      }
    } catch (e) {
      this.journal({ kind: `${reason}-error`, error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
  }

  // ── one tick of both desks ─────────────────────────────────────────────────
  async tick(): Promise<void> {
    if (this.busy) return; // never overlap ticks
    this.busy = true;
    // ONE VENUE, ONE FAIR VALUE: prints against ANY desk's resting orders are
    // real trades printed at that desk's price — they all feed the grid desk's
    // EMA (the venue's reference), not just the desk that was hit
    const tickPrints: bigint[] = [];
    try {
      this.oracleCache = this.readOracle();
      for (const { cfg, state } of this.desks) {
        try {
          const snap = this.engine.bookSnapshot();
          const view = { bids: snap.bids, asks: snap.asks };
          const own = [
            ...snap.bids.filter((o) => o.agentId === cfg.agentId).map((o) => ({ id: o.id, side: "bid" as const, price: o.price, filled: BigInt(o.filled ?? "0"), remaining: BigInt(o.amount) })),
            ...snap.asks.filter((o) => o.agentId === cfg.agentId).map((o) => ({ id: o.id, side: "ask" as const, price: o.price, filled: BigInt(o.filled ?? "0"), remaining: BigInt(o.amount) })),
          ];
          // maker-fill diff (book evidence, exact maker price law):
          // delta-filled on a resting order = a real trade printed at OUR price
          const trk = this.tracker.get(cfg.agentId) ?? new Map<string, { side: "bid" | "ask"; price: bigint; filled: bigint; remaining: bigint }>();
          const jc = this.justCanceled.get(cfg.agentId) ?? new Set<string>();
          for (const [id, rec] of trk) {
            if (jc.has(id)) continue; // canceled by us — never a fill
            const nowRec = own.find((o) => o.id === id);
            // a vanished order's remaining size was fully taken (tiny known
            // gap: partial-fill-then-cancel inside one tick under-credits)
            const filledNow = nowRec ? nowRec.filled : rec.filled + rec.remaining;
            const delta = filledNow - rec.filled;
            if (delta > 0n) {
              recordFill(state, rec.side, rec.price * delta);
              tickPrints.push(rec.price);
              this.journal({ kind: "maker-fill", desk: cfg.agentId, orderId: id, side: rec.side, price: rec.price.toString(), amount: delta.toString() });
            }
          }
          this.tracker.set(cfg.agentId, new Map(own.map((o) => [o.id, { side: o.side, price: BigInt(o.price), filled: o.filled, remaining: o.remaining }])));
          jc.clear();
          const b = await this.engine.balances(cfg.agentId);
          // ── D1 strategy-tuner (grid בלבד): שערי-ארבעה לפני-כל-כוונון ──
          // risk (רצפת-הפסד) → quant (משטר מהעוגנים) → execution (dampener+תחומים).
          // החלה על עותק-ה-cfg → deskIntents הבא מצטט לפי-הפרמטרים-החדשים.
          if (cfg.kind === "grid") {
            const mid = state.lastMidU;
            if (mid !== null && mid > 0n) {
              const saosBal = BigInt(b.saosAvailable || "0") + BigInt(b.saosLocked || "0");
              const usdsBal = BigInt(b.usdsAvailable || "0") + BigInt(b.usdsLocked || "0");
              const equityU = usdsBal + (saosBal * mid) / 1_000_000n;
              const seedEquityU = parseMicroCents(this.opts.seedUsdsCents) + (BigInt(this.opts.seedSaosU) * mid) / 1_000_000n;
              const dec = tuneGridDesk(this.tuner, oracleRegime(this.oracleCache), { pnlMarkedU: equityU - seedEquityU, seedEquityU }, this.now(), this.tuneMinIntervalMs);
              if (dec.stepU !== cfg.stepU) cfg.stepU = dec.stepU;
              if (dec.maxSpreadU !== cfg.maxSpreadU) cfg.maxSpreadU = dec.maxSpreadU;
              if (dec.kind === "tune" || dec.kind === "kill-revert") {
                this.journal({ kind: dec.kind, desk: cfg.agentId, fourGate: dec.fourGate ?? null, stepU: dec.stepU.toString(), maxSpreadU: dec.maxSpreadU.toString(), reason: dec.reason });
              }
            }
          }
          const intents = deskIntents(state, cfg, {
            view,
            ownOrders: own,
            balances: { usdsAvailable: b.usdsAvailable, saosAvailable: b.saosAvailable },
            oracle: this.oracleCache,
          });
          const placed: { orderId: string; side: string; price: string; amount: string }[] = [];
          const canceled: string[] = [];
          const filled: { tradeId: string; side: string; price: string; amount: string; notional: string }[] = [];
          for (const it of intents) {
            try {
              if (it.action === "cancel" && it.orderId) {
                await this.engine.cancelOrder(cfg.agentId, it.orderId);
                canceled.push(it.orderId);
                if (!this.justCanceled.has(cfg.agentId)) this.justCanceled.set(cfg.agentId, new Set());
                this.justCanceled.get(cfg.agentId)!.add(it.orderId);
              } else if (it.action === "place" && it.side && it.price && it.amount) {
                const orderId = `${cfg.agentId}-${this.bootEpoch}-t${state.tickNo}-${placed.length}-${it.side}`;
                const res = await this.engine.placeOrder({
                  agentId: cfg.agentId, orderId, side: it.side,
                  price: it.price, amount: it.amount, type: it.type ?? "limit",
                });
                placed.push({ orderId, side: it.side, price: it.price.toString(), amount: it.amount.toString() });
                for (const f of res.fills) {
                  recordFill(state, it.side, BigInt(f.notional));
                  filled.push({ tradeId: f.tradeId, side: it.side, price: f.price.toString(), amount: f.amount.toString(), notional: f.notional.toString() });
                }
              }
            } catch (e) {
              // postOnly rejection (would cross) or cancel-not-found — honest skips
              const msg = String((e as Error)?.message ?? e).slice(0, 80);
              this.journal({ kind: "intent-skip", desk: cfg.agentId, action: it.action, orderId: it.orderId ?? null, error: msg });
            }
          }
          if (placed.length || canceled.length || filled.length) {
            this.journal({ kind: "tick", desk: cfg.agentId, tick: state.tickNo, placed, canceled, filled, regime: oracleRegime(this.oracleCache).mode });
          }
        } catch (e) {
          // one desk failing never kills the other (quiesce, transient ledger…)
          this.journal({ kind: "tick-error", desk: cfg.agentId, error: String((e as Error)?.message ?? e).slice(0, 160) });
        }
      }
      // feed every desk's prints into the venue's reference (grid EMA)
      const gridDesk = this.desks.find((d) => d.cfg.kind === "grid");
      if (gridDesk && tickPrints.length > 0) {
        for (const p of tickPrints) onMakerPrint(gridDesk.state, p, gridDesk.cfg);
        this.journal({ kind: "prints-fed", desk: "mm-grid", count: tickPrints.length, last: tickPrints[tickPrints.length - 1].toString() });
      }
    } finally {
      this.busy = false;
    }
  }

  // ── open introspection (GET /desk/state) ───────────────────────────────────
  async stateJson(): Promise<Record<string, unknown>> {
    const snap = this.engine.bookSnapshot();
    const bestBid = snap.bids[0] ? BigInt(snap.bids[0].price) : null;
    const bestAsk = snap.asks[0] ? BigInt(snap.asks[0].price) : null;
    const spreadU = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const regime: OracleRegime = oracleRegime(this.oracleCache);
    const desks: Record<string, unknown>[] = [];
    for (const { cfg, state } of this.desks) {
      const b = await this.engine.balances(cfg.agentId);
      const ownCount = [...snap.bids, ...snap.asks].filter((o) => o.agentId === cfg.agentId).length;
      const mid = state.lastMidU;
      let equityU: bigint | null = null;
      let pnlMarkedU: bigint | null = null;
      if (mid !== null) {
        const saos = BigInt(b.saosAvailable || "0") + BigInt(b.saosLocked || "0");
        equityU = BigInt(b.usdsAvailable || "0") + BigInt(b.usdsLocked || "0") + (saos * mid) / 1_000_000n;
        const seedSaos = BigInt(this.opts.seedSaosU);
        const seedEquityU = parseMicroCents(this.opts.seedUsdsCents) + (seedSaos * mid) / 1_000_000n;
        pnlMarkedU = equityU - seedEquityU;
      }
      desks.push({
        agentId: cfg.agentId, kind: cfg.kind, tickNo: state.tickNo,
        stepU: cfg.stepU.toString(), maxSpreadU: cfg.maxSpreadU.toString(),
        emaU: state.emaU?.toString() ?? null, lastMidU: state.lastMidU?.toString() ?? null,
        buys: state.buys, sells: state.sells,
        grossFlowU: state.grossFlowU.toString(), ownOrders: ownCount,
        maxSpreadSeenU: state.maxSpreadSeenU.toString(),
        equityU: equityU?.toString() ?? null, pnlMarkedU: pnlMarkedU?.toString() ?? null,
        haltedReason: state.haltedReason,
      });
    }
    return {
      enabled: true, startedAt: this.startedAt, now: new Date(this.now()).toISOString(),
      oracle: {
        ageMin: this.oracleCache.ageMin === null ? null : Math.round(this.oracleCache.ageMin * 10) / 10,
        source: this.oracleCache.source, networks: this.oracleCache.networks,
        volPct: this.oracleCache.volPct === null ? null : Math.round(this.oracleCache.volPct * 10000) / 10000,
      },
      regime,
      book: {
        bestBid: bestBid?.toString() ?? null, bestAsk: bestAsk?.toString() ?? null,
        spreadU: spreadU?.toString() ?? null,
        spreadBps: spreadU !== null && bestBid !== null && bestBid > 0n ? Math.round((Number(spreadU) * 10_000) / Number(bestBid) * 100) / 100 : null,
      },
      desks,
    };
  }
}
