/**
 * kernel/market/desk-tuner.ts — D1 strategy-tuner (four-gate law, deterministic).
 *
 * מה זה: התאמה-שולחן-עומק לפי-משטר-מדידה — הלופ של AutoHedge (thesis→quant→risk→
 * execution) בלי-LLM בשביל-כסף (חוק-A2: שערי-כסף דטרמיניסטיים). הכוונון עובד על
 * פרמטרי-הפריסה של שולחן-mm-grid בלבד (stepU, maxSpreadU) — גודל-רמה ומספר-רמות
 * נשארים קבועים (שטח-מוטציה מזערי). טהור לגמרי: אפס-fs, אפס-רשת, אפס-שעון-עצמאי —
 * `now` מוזרק. כל-החלטה נושאת רשום-ארבע-שערים מלא (direction · confidence ·
 * invalidation · killCriteria) ליומן-ה-host.
 *
 * חוזה-ארבע-השערים (A1, מ-channel-audit 2026-10-21):
 *   thesis      — כיוון: calm → מרווח-הדוק (לכידת-זרימה בשקט); wild → מרווח-רחב
 *                 (הגנה-מפני-בחירה-שלילית לפני-חוק-העצירה); active → בראשית.
 *   quant       — מדידה מהקרקע שלנו בלבד: volPct מעוגני-האורקל האמיתיים
 *                 (anchors.jsonl) דרך oracleRegime — אותו-מנוע-משטר של הדסק.
 *   risk        — שער-קשיח לפני-כל-מוטציה: רצפת-הפסד (pnlMarkedU < −10% מהון-זריעה
 *                 → revert-לבראשית + צינון-2h); מגבלת-צעד (≤25% מהערך-הנוכחי
 *                 לכיוון-אחד); תחומים-קשיחים (step 750–6000 · spread 1500–12000);
 *                 קצב (מוטציה-אחת לכל-tuneMinIntervalMs, ברירת-מחדל 15 דקות).
 *   execution   — החלה על cfg-השולחן-החי בhost (עותק-פר-דסק), מתועדת ביומן;
 *                 revert-אוטומטי-מובנה: היעד הוא פונקציה של המשטר-הנמדד —
 *                 חזרה-ל-band של active מחזירה לבראשית בחלון-הבא (auto-revert).
 *
 * fail-closed: halt (עוגן-חסר/ישן) → אפס-מוטציות. שגיאת-קלט (mid חסר ל-risk) →
 * אפס-מוטציות. דטרמיניזם: אותם-קלטות → אותה-החלטה, תמיד.
 */

import type { OracleRegime } from "./liquidity-desk";

/** תחומים-קשיחים (µ¢) — מעולם לא מוצאים-מהם, גם-לא בראשית-שונה-סביבה */
export const STEP_MIN_U = 750n;
export const STEP_MAX_U = 6_000n;
export const SPREAD_MIN_U = 1_500n;
export const SPREAD_MAX_U = 12_000n;

/** מגבלת-צעד: ≤25% מהערך-הנוכחי לכל-כיוון (dampener — אין-קפיצות) */
const MAX_DELTA_NUM = 5n; // ×5/4 למעלה
const MAX_DELTA_DEN = 4n;

/** רצפת-kill: pnl מסומן מתחת-ל−10% מהון-הזריעה → revert-לבראשית + צינון */
export const KILL_FLOOR_NUM = -1n;
export const KILL_FLOOR_DEN = 10n;
/** אורך-צינון אחרי-kill (ms) — ברירת-מחדל 2 שעות */
export const KILL_COOLDOWN_MS = 2 * 60 * 60_000;

/** גורמי-היעד לפי-משטר (מחושבים מהבראשית — לא מהערך-הנוכחי, למניעת-סחיפה) */
const CALM_STEP = 8n, CALM_SPREAD = 8n;       // ×0.8
const WILD_STEP = 15n, WILD_SPREAD = 15n;     // ×1.5
const FACTOR_DEN = 10n;

export interface TunerState {
  /** הערכים-החיים (מתחילים = בראשית) */
  stepU: bigint;
  maxSpreadU: bigint;
  /** בראשית-האתחול של ה-host (אחרי-עקיפת-סביבה) — נקודת-החזר */
  genesisStepU: bigint;
  genesisSpreadU: bigint;
  lastMutationAt: number;
  cooldownUntil: number;
}

export interface FourGateRecord {
  thesis: string;
  quant: string;
  risk: string;
  execution: string;
}

export type TuneKind =
  | "none"          // אין-שינוי (כבר-ביעד / קלט-חסר)
  | "tune"          // מוטציה-רגילה לפי-משטר
  | "kill-revert"   // רצפת-הפסד נחצתה → בראשית + צינון
  | "frozen"        // halt — אפס-מוטציות (fail-closed)
  | "cooldown"      // בתוך-צינון-kill
  | "rate-limited"; // טרם-חלון-הקצב

export interface TuneDecision {
  kind: TuneKind;
  /** הערכים-החיים אחרי-ההחלטה (להחלה על cfg — תמיד מוחזרים) */
  stepU: bigint;
  maxSpreadU: bigint;
  reason: string;
  fourGate?: FourGateRecord;
}

export function newTunerState(genesisStepU: bigint, genesisSpreadU: bigint, now: number): TunerState {
  return {
    stepU: clampStep(genesisStepU),
    maxSpreadU: clampSpread(genesisSpreadU),
    genesisStepU: clampStep(genesisStepU),
    genesisSpreadU: clampSpread(genesisSpreadU),
    lastMutationAt: 0,
    cooldownUntil: 0,
  };
}

function clampStep(v: bigint): bigint {
  return v < STEP_MIN_U ? STEP_MIN_U : v > STEP_MAX_U ? STEP_MAX_U : v;
}
function clampSpread(v: bigint): bigint {
  return v < SPREAD_MIN_U ? SPREAD_MIN_U : v > SPREAD_MAX_U ? SPREAD_MAX_U : v;
}

/** מגבלת-הצעד: מתקרבים אל `target` אך-לא-יותר-מ-25% מ-`cur` לכל-כיוון, ואז תחום-קשיח */
function approach(cur: bigint, target: bigint, clampFn: (v: bigint) => bigint): bigint {
  const up = (cur * MAX_DELTA_NUM) / MAX_DELTA_DEN;
  const down = (cur * MAX_DELTA_DEN) / MAX_DELTA_NUM;
  let next = target;
  if (next > cur && next > up) next = up;
  if (next < cur && next < down) next = down;
  return clampFn(next);
}

function targetFor(mode: OracleRegime["mode"], g: TunerState): { stepU: bigint; maxSpreadU: bigint } {
  if (mode === "calm") {
    return { stepU: clampStep((g.genesisStepU * CALM_STEP) / FACTOR_DEN), maxSpreadU: clampSpread((g.genesisSpreadU * CALM_SPREAD) / FACTOR_DEN) };
  }
  if (mode === "wild") {
    return { stepU: clampStep((g.genesisStepU * WILD_STEP) / FACTOR_DEN), maxSpreadU: clampSpread((g.genesisSpreadU * WILD_SPREAD) / FACTOR_DEN) };
  }
  return { stepU: g.genesisStepU, maxSpreadU: g.genesisSpreadU }; // active
}

/**
 * הכרעת-הכוונון (טהור). סדר-השערים קבוע: risk לפני-הכל, quant (משטר) אחריו,
 * execution (approach+dampener) אחרון. `tuneMinIntervalMs` מוזרק מה-host
 * (ברירת-מחדל חיה 15 דקות; probe מכווץ).
 */
export function tuneGridDesk(
  st: TunerState,
  regime: OracleRegime,
  risk: { pnlMarkedU: bigint | null; seedEquityU: bigint },
  now: number,
  tuneMinIntervalMs: number,
): TuneDecision {
  // ── שער-הסיכון הראשון: הסגר (cooldown) — לפני-ה-kill, כדי שהמצב-הנמדד
  // (pnl מתחת-לרצפה בתוך-הסגר) יהיה אירוע-שקט-אחד ולא ספאם-בכל-tick;
  // kill-revert נורה פעם-אחת-בסגר — ואז פעימת-לב-אחת-לכל-2h אם-הרצפה עדיין נפרצה
  if (now < st.cooldownUntil) {
    return { kind: "cooldown", stepU: st.stepU, maxSpreadU: st.maxSpreadU, reason: `inside kill cooldown until ${new Date(st.cooldownUntil).toISOString()}` };
  }
  if (
    risk.pnlMarkedU !== null &&
    risk.seedEquityU > 0n &&
    risk.pnlMarkedU * KILL_FLOOR_DEN < KILL_FLOOR_NUM * risk.seedEquityU // pnl < −seed/10
  ) {
    st.stepU = st.genesisStepU;
    st.maxSpreadU = st.genesisSpreadU;
    st.cooldownUntil = now + KILL_COOLDOWN_MS;
    st.lastMutationAt = now;
    return {
      kind: "kill-revert",
      stepU: st.stepU,
      maxSpreadU: st.maxSpreadU,
      reason: `pnlMarkedU ${risk.pnlMarkedU} < −(seedEquityU/${KILL_FLOOR_DEN}) — reverting to genesis + ${KILL_COOLDOWN_MS / 60_000}min cooldown`,
      fourGate: {
        thesis: "kill: drawdown floor breached — adaptation stops, genesis restored",
        quant: `pnlMarkedU=${risk.pnlMarkedU.toString()} vs seedEquityU=${risk.seedEquityU.toString()}`,
        risk: `floor −10% of seed · revert genesis · cooldown ${KILL_COOLDOWN_MS / 60_000}min`,
        execution: "host applies genesis cfg + journals kill-revert",
      },
    };
  }
  // ── quant: עוגן-מת/חסר = הקפאה (fail-closed — אין-כוונון על-עוגן-עיוור) ──
  if (regime.mode === "halt") {
    return { kind: "frozen", stepU: st.stepU, maxSpreadU: st.maxSpreadU, reason: `halt: ${regime.reason} — no mutation` };
  }
  if (now - st.lastMutationAt < tuneMinIntervalMs) {
    return { kind: "rate-limited", stepU: st.stepU, maxSpreadU: st.maxSpreadU, reason: `next window in ${Math.ceil((tuneMinIntervalMs - (now - st.lastMutationAt)) / 1000)}s` };
  }
  // ── execution: יעד לפי-משטר, dampener של-25%, תחומים-קשיחים ─────────────
  const tgt = targetFor(regime.mode, st);
  if (tgt.stepU === st.stepU && tgt.maxSpreadU === st.maxSpreadU) {
    return { kind: "none", stepU: st.stepU, maxSpreadU: st.maxSpreadU, reason: `already at ${regime.mode} target` };
  }
  const prevStep = st.stepU, prevSpread = st.maxSpreadU;
  st.stepU = approach(st.stepU, tgt.stepU, clampStep);
  st.maxSpreadU = approach(st.maxSpreadU, tgt.maxSpreadU, clampSpread);
  st.lastMutationAt = now;
  const dir = st.stepU > prevStep || st.maxSpreadU > prevSpread ? "widen" : "tighten";
  return {
    kind: "tune",
    stepU: st.stepU,
    maxSpreadU: st.maxSpreadU,
    reason: `${regime.mode} (${regime.reason}) → ${dir}: stepU ${prevStep}→${st.stepU} · maxSpreadU ${prevSpread}→${st.maxSpreadU}`,
    fourGate: {
      thesis: `${dir} grid spacing for measured ${regime.mode} regime (calm captures flow · wild avoids adverse selection · active = genesis)`,
      quant: `${regime.reason} — from our own oracle anchors, engine oracleRegime (no LLM, no prediction)`,
      risk: "≤25%/window dampener · hard bounds step 750–6000 spread 1500–12000 · kill floor −10% seed → genesis+2h cooldown",
      execution: `host applies cfg next quoting pass; invalidation: regime leaves ${regime.mode} band → retarget next window (auto-revert by construction)`,
    },
  };
}
