/**
 * kernel/market/liquidity-desk.ts — the venue's DESIGNATED LIQUIDITY DESKS.
 *
 * הנחיית-מפעיל 2026-10-21: שוק-חריף של גרידים וארביטראז' על הDEX שלנו — בלי
 * תלות בשירותי-חוץ (HTX נפסל-KYC; FixedFloat pending). שני שולחנות ממונים,
 * חשופים, עם אותן-חוקי-מנוע בדיוק כמו כל-סוכן (עמלה, escrow, שימור):
 *
 *   mm-grid   — גריד מכני דו-צדדי סביב EMA איטי של ה-mid הפנימי (postOnly,
 *               מגודל-מלאי ב-capBid/capAsk). סוחר-תנודתיות: כל-מחזור
 *               קניה-מתחת/מכירה-מעל ה-EMA הוא רווח אמיתי מספר-הזמנות.
 *   mm-oracle — שולחן-העוגן: קורא את העוגנים האמיתיים (Kraken/Bitstamp
 *               BTC/ETH/SOL, עם provenance) ומושל את מדיניות-הנזילות
 *               לפי-משטר-התנודתיות החיצוני; כשהספר רחב מדי — מוסיף עומק
 *               בתוך-הספר (תיקון-ספרים). oracle חסר/ישן → halt (fail-closed).
 *
 * ערוץ-ארביטראז' חוץ-אמיתי (מתועד-בכנות): SAOS לא נסחר בשום-ווניות חוץ —
 * אין-ארביטראז' חוץ אמיתי עד-שער-חוץ ייפתח (FixedFloat pending). כשייפתח,
 * mm-oracle הוא נקודת-החיבור (fair-value → fade-סטייה). אין-המצאה.
 *
 * כל-הפונקציות טהורות (state+inputs → intents) — נבדקות-זהב דרך-נתיב-החתימה
 * האמיתי (liquidity-desk-probe.ts) ומורצות בתוך market-serve.ts (desk-host).
 */

import { capBid, capAsk } from "../fleet/sovereign-agents";
import type { Intent, MarketView } from "../fleet/sovereign-agents";

export const MIN_ORDER = 100_000n; // 0.1 SAOS (µ-SAOS) — אותו-רצפה-כנה של sovereign-agents

// ─── Config / state ──────────────────────────────────────────────────────────

export interface DeskConfig {
  agentId: string;
  kind: "grid" | "oracle";
  /** (grid) רמות לכל-צד */
  levels: number;
  /** (grid) מרווח-רמה בµ¢/SAOS */
  stepU: bigint;
  /** גודל-רצוי לכל-רמה בµ-SAOS (מגודל-מלאי תמיד) */
  sizeU: bigint;
  /** מחיר-בראשית כשהספר ריק לגמרי (µ¢/SAOS) — לעולם לא המצאת-mid */
  genesisPriceU: bigint;
  /** EMA factor בparts-per-million (grid) */
  alphaPpm: number;
  /** (oracle) סף-ספר-רחב בµ¢ — מעליו מוסיפים עומק בתוך-הספר */
  maxSpreadU: bigint;
}

export interface OracleView {
  /** גיל רשומה-העוגן החדשה ביותר בדקות; null = אין-עוגן כלל */
  ageMin: number | null;
  source: string | null;
  networks: number;
  /** תנודתיות-סל ממוצעת לקריאה (fraction, e.g. 0.004 = 0.4%) */
  volPct: number | null;
}

export type OracleRegime = { mode: "calm" | "active" | "wild" | "halt"; reason: string };

export interface DeskState {
  tickNo: number;
  emaU: bigint | null;
  lastMidU: bigint | null;
  buys: number;
  sells: number;
  /** Σ מכר-notional − Σ קנה-notional (µ¢, מה-fills האמיתיים בלבד) */
  grossFlowU: bigint;
  lastActionTick: number;
  maxSpreadSeenU: bigint;
  haltedReason: string | null;
}

export function newDeskState(): DeskState {
  return {
    tickNo: 0, emaU: null, lastMidU: null, buys: 0, sells: 0,
    grossFlowU: 0n, lastActionTick: 0, maxSpreadSeenU: 0n, haltedReason: null,
  };
}

// ─── Oracle regime (מושל-המשטר מהעוגנים האמיתיים) ───────────────────────────

/** העוגנים קובעים משטר, לא מחיר: ה-µ-USDS פנימי ואין-לו-מחיר-חוץ אמיתי עדיין.
 *  calm ≤30min + תנודתיות שקטה → מותר-לצקת עומק; active → זהירות; wild/halt
 *  (oracle ישן >45min או חסר) → אין-תוספת-עומק (fail-closed, כנות). */
export function oracleRegime(o: OracleView): OracleRegime {
  if (o.ageMin === null) return { mode: "halt", reason: "oracle absent" };
  if (o.ageMin > 45) return { mode: "halt", reason: `oracle stale ${Math.round(o.ageMin)}min > 45` };
  if (o.volPct === null) return { mode: "active", reason: `fresh ${Math.round(o.ageMin)}min, vol unknown` };
  if (o.volPct <= 0.006) return { mode: "calm", reason: `vol ${(o.volPct * 100).toFixed(2)}%/read` };
  if (o.volPct <= 0.02) return { mode: "active", reason: `vol ${(o.volPct * 100).toFixed(2)}%/read` };
  return { mode: "wild", reason: `vol ${(o.volPct * 100).toFixed(2)}%/read` };
}

// ─── Desk inputs ─────────────────────────────────────────────────────────────

export interface DeskInputs {
  view: MarketView;
  ownOrders: { id: string; side: "bid" | "ask"; price: string }[];
  balances: { usdsAvailable: string; saosAvailable: string };
  oracle: OracleView;
}

/** mid דו-צדדי בלבד — ספר-חד-צדדי אינו mid (אין-המצאת-מחיר). */
export function twoSidedMidU(view: MarketView): bigint | null {
  const b = view.bids[0] ? BigInt(view.bids[0].price) : null;
  const a = view.asks[0] ? BigInt(view.asks[0].price) : null;
  if (b !== null && a !== null) return (b + a) / 2n;
  return null;
}

function updateEma(s: DeskState, mid: bigint, cfg: DeskConfig): void {
  if (s.emaU === null) { s.emaU = mid; return; }
  s.emaU = s.emaU + ((mid - s.emaU) * BigInt(cfg.alphaPpm)) / 1_000_000n;
}

/** האם קיימת-פרישה-משלנו בטווח level±step/2 (כיסוי-רמה) */
function levelCovered(own: { side: "bid" | "ask"; price: string }[], side: "bid" | "ask", level: bigint, step: bigint): boolean {
  const half = step / 2n;
  return own.some((o) => {
    if (o.side !== side) return false;
    const p = BigInt(o.price);
    const d = p > level ? p - level : level - p;
    return d <= half;
  });
}

// ─── The desk decision (pure) ────────────────────────────────────────────────

export function deskIntents(state: DeskState, cfg: DeskConfig, inputs: DeskInputs): Intent[] {
  state.tickNo += 1;
  const intents: Intent[] = [];
  const { view, ownOrders, balances } = inputs;

  const mid = twoSidedMidU(view);
  if (mid !== null) {
    state.lastMidU = mid;
    updateEma(state, mid, cfg);
  }
  if (view.bids[0] && view.asks[0]) {
    const spread = BigInt(view.asks[0].price) - BigInt(view.bids[0].price);
    if (spread > state.maxSpreadSeenU) state.maxSpreadSeenU = spread;
  }

  // grid — גריד מכני סביב EMA (שני-הצדדים, postOnly, מגודל-מלאי)
  if (cfg.kind === "grid") {
    const ref = state.emaU ?? cfg.genesisPriceU;
    // 1) חוק-סטייה-מבני: פרישה שנסחפה מעבר לטווח-הגריד עצמו ((levels+1)×step)
    //    אינה שייכת-עוד לגריד — מבוטלת. (בדיקת-הזהב תפסה את הגרסה-הקודמת:
    //    סף-bps קבוע שהיה-קטן-מהטווח יצר churn ביטול/הצבה אינסופי.)
    const maxDrift = (BigInt(cfg.levels + 1)) * cfg.stepU;
    for (const o of ownOrders) {
      const p = BigInt(o.price);
      const drift = p > ref ? p - ref : ref - p;
      if (drift > maxDrift) intents.push({ action: "cancel", orderId: o.id });
    }
    // 2) השלמת-רמות-חסרות (הכיסוי נבדק מול הפרישות שלא בוטלו)
    const survivors = ownOrders.filter((o) => !intents.some((i) => i.action === "cancel" && i.orderId === o.id));
    for (let i = 1; i <= cfg.levels; i++) {
      const bidPx = ref - BigInt(i) * cfg.stepU;
      if (bidPx > 0n && !levelCovered(survivors, "bid", bidPx, cfg.stepU)) {
        const amt = capBid(cfg.sizeU, balances.usdsAvailable, bidPx);
        if (amt) intents.push({ action: "place", side: "bid", price: bidPx, amount: amt, type: "postOnly" });
      }
      const askPx = ref + BigInt(i) * cfg.stepU;
      if (!levelCovered(survivors, "ask", askPx, cfg.stepU)) {
        const amt = capAsk(cfg.sizeU, balances.saosAvailable);
        if (amt) intents.push({ action: "place", side: "ask", price: askPx, amount: amt, type: "postOnly" });
      }
    }
    return intents;
  }

  // oracle — שולחן-העוגן: משטר-חוץ אמיתי מושל תוספת-עומק בתוך-ספר-רחב
  const regime = oracleRegime(inputs.oracle);
  state.haltedReason = regime.reason;
  if (regime.mode === "wild" || regime.mode === "halt") return intents; // אין-תוספת בזמן-סערה/עוגן-מת
  if (!view.bids[0] || !view.asks[0]) return intents; // ספר-חד-צדדי — אין-מה לתקן

  const bestBid = BigInt(view.bids[0].price);
  const bestAsk = BigInt(view.asks[0].price);
  const spread = bestAsk - bestBid;

  const tick = cfg.stepU; // מרווח-שיפור מינימלי
  // drift law: ציטוט-שיפור שכבר-אינו מחבק את המגע (3×step) נסוג — אין-צבירת
  // פרישות-ישנות של שולחן-העוגן (נבדק גם-כשהספר חריף — נסיגה היא תמיד חוקית)
  const touchDriftMax = cfg.stepU * 3n;
  for (const o of ownOrders) {
    const p = BigInt(o.price);
    const touch = o.side === "bid" ? bestBid : bestAsk;
    const d = p > touch ? p - touch : touch - p;
    if (d > touchDriftMax) intents.push({ action: "cancel", orderId: o.id });
  }
  if (spread <= cfg.maxSpreadU) return intents; // הספר חריף ממילא — רק-נסיגות
  const half = cfg.kind === "oracle" && regime.mode === "active" ? cfg.sizeU / 2n : cfg.sizeU;
  // שיפור-המגע: bid טוב-יותר מהטאץ', ask טוב-יותר מהטאץ' — לעולם postOnly,
  // לעולם לא-מול-פרישה-של-עצמנו באותו-צד (אין-סחר-עצמי)
  const bidPx = bestBid + tick;
  if (bidPx < bestAsk && view.bids[0].agentId !== cfg.agentId && !levelCovered(ownOrders, "bid", bidPx, tick)) {
    const amt = capBid(half, balances.usdsAvailable, bidPx);
    if (amt) intents.push({ action: "place", side: "bid", price: bidPx, amount: amt, type: "postOnly" });
  }
  const askPx = bestAsk - tick;
  if (askPx > bestBid && view.asks[0].agentId !== cfg.agentId && !levelCovered(ownOrders, "ask", askPx, tick)) {
    const amt = capAsk(half, balances.saosAvailable);
    if (amt) intents.push({ action: "place", side: "ask", price: askPx, amount: amt, type: "postOnly" });
  }
  return intents;
}

// ─── Fill accounting (מה-fills האמיתיים בלבד) ────────────────────────────────

export function recordFill(state: DeskState, side: "bid" | "ask", notionalU: bigint): void {
  if (side === "bid") { state.buys += 1; state.grossFlowU -= notionalU; }
  else { state.sells += 1; state.grossFlowU += notionalU; }
  state.lastActionTick = state.tickNo;
}

/** Maker-print: fill נגד פרישה שלנו מודפס במחיר-הפרישה שלנו (חוק-המנוע) —
 *  זו גילוי-המחיר האמיתי של השוק, ולכן הוא מזין את ה-EMA בדיוק כמו mid.
 *  בלעדיו הגריד מתעוור לקריסות: הוא עצמו ממלא-מחדש רמות במהירות
 *  שמוחקת את הראיה-מהספר לפני שה-EMA מספיק לראות. */
export function onMakerPrint(state: DeskState, priceU: bigint, cfg: DeskConfig): void {
  if (cfg.kind !== "grid") return; // רק-הגריד מאונך-EMA
  updateEma(state, priceU, cfg);
}
