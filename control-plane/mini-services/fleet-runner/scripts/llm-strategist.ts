/**
 * llm-strategist.ts — המוח המלאכותי האמיתי הראשון של הצי-הריבוני.
 *
 * מה-זה: שכבת-אסטרטגיה מבוססת-LLM (z-ai-web-dev-sdk, backend-בלבד) שמקבלת
 * מצב-שוק אמיתי (ספר-חי + יתרות-חתומות + עוגני-מחיר אמיתיים מהרשתות-הגדולות)
 * ומחזירה החלטה מובנית. ה-LLM מציע — **החוקים מכריעים**: כל-הצעה עוברת את
 * אותן-מגבלות-מלאי (capBid/capAsk) של-האסטרטגיות-האלגוריתמיות, והריצה-חתומה
 * Ed25519 כמו-כולם. אין-עדיפות-מיוחדת, אין-עוקף-חוק.
 *
 * חוקי-כנות:
 *  - כל-החלטה (כולל-טעם ותשובה-גולמית) נרשמת ל-data/ai/llm-strategist.jsonl —
 *    עקבות-מוח מלאים, ניתנים-לביקורת.
 *  - כשל-LLM / תשובה-לא-תקפה / JSON שבור = no-op כנה (אפס-פעולה, סיבה מתועדת).
 *    המוח לא ממציא מחירים במצב-כשל.
 *  - קצב-אסטרטגי: ה-LLM מחליט כל-N-טיק (ברירת-מחדל 3) — מנתח, לא רועם-תדרים.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import ZAI from "z-ai-web-dev-sdk";
import { capBid, capAsk } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import type { MarketView } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";

const AI_DIR = join(import.meta.dir, "..", "data", "ai");
const LEDGER_JSONL = `${AI_DIR}/llm-strategist.jsonl`;
const ORACLE_JSONL = join(import.meta.dir, "..", "data", "oracle", "anchors.jsonl");
const MIN_ORDER = 100_000n; // אותו-רצפה: 0.1 µ-SAOS — כמו-בגרעין

export type LlmIntent = { action: "place"; side: "bid" | "ask"; price: bigint; amount: bigint; type: "limit" | "ioc" };

type Decision = { intents: LlmIntent[]; rationale: string; mode: "ok" | "noop"; note?: string };

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function zai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

function latestAnchors(n: number): { network: string; last: string; at: string }[] {
  try {
    if (!existsSync(ORACLE_JSONL)) return [];
    const lines = readFileSync(ORACLE_JSONL, "utf8").trim().split("\n");
    const out: { network: string; last: string; at: string }[] = [];
    const seen = new Set<string>();
    for (let i = lines.length - 1; i >= 0 && seen.size < n * 3; i--) {
      try {
        const a = JSON.parse(lines[i]) as { network: string; last: string; at: string };
        if (!seen.has(a.network)) {
          seen.add(a.network);
          out.push({ network: a.network, last: a.last, at: a.at });
        }
      } catch { /* skip broken line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function log(entry: Record<string, unknown>): void {
  try {
    mkdirSync(AI_DIR, { recursive: true });
    appendFileSync(LEDGER_JSONL, JSON.stringify(entry) + "\n");
  } catch { /* logging never breaks trading */ }
}

/** מבקש החלטה מה-LLM ומתרגם אותה לכוונות-מסחר במסגרת-החוק. אף-שדה לא מאמין ללא-בדיקה. */
export async function llmStrategist(
  view: MarketView,
  state: { agentId: string; tick: number; balances: { usdsAvailable: string; saosAvailable: string }; usdsStaked?: string },
  market: { mid: number | null; trades?: number; fees?: string },
): Promise<Decision> {
  const at = new Date().toISOString();
  const anchors = latestAnchors(3);
  const context = {
    book: {
      bestBid: view.bids[0]?.price ?? null,
      bestAsk: view.asks[0]?.price ?? null,
      bidDepth: view.bids.length,
      askDepth: view.asks.length,
      mid: market.mid,
    },
    me: {
      agentId: state.agentId,
      usdsAvailable: state.balances.usdsAvailable,
      saosAvailable: state.balances.saosAvailable,
      usdsStaked: state.usdsStaked ?? "0",
      ownOrders: state.tick ? undefined : undefined,
    },
    platform: { trades: market.trades, fees: market.fees },
    externalAnchors: anchors, // BTC/ETH/SOL אמיתיים — ההקשר-העולמי של-הרשת-הריבונית
  };

  const SYSTEM = `אתה אסטרטג-מסחר של סוכן ריבוני בשוק SAOS/USDS פנימי.
היחידות: מחיר ב-µ¢/SAOS (מספר-שלם; mid טיפוסי 240000–270000), כמות ב-µ-SAOS (מספר-שלם; מינימום 100000).
יש לך יתרות אמיתיות — הצע מחירים סבירים סביב ה-mid וכמויות שהיתרות שלך יכולות לשאת (המערכת תחתוך מעבר לזה בכל-מקרה).
עוגני-המחיר החיצוניים (BTC/ETH/SOL מהעולם האמיתי) ניתנים-לך כהקשר-ערך — השוק הפנימי הוא ריבוני, אבל הערך-העזר שלו מושפע מהעולם.
החזר JSON בלבד, בלי-טקסט-אחר, במבנה: {"bid":{"price":int,"amount":int}|null,"ask":{"price":int,"amount":int}|null,"rationale":"עד-20 מילים בעברית"}`;
  const USER = `מצב-השוק וההקשר: ${JSON.stringify(context)}
החלט: אם-התנאים-סבירים — הצע bid/ask סביב-ה-mid (או רק-צד-אחד אם-זה-ההיגיון). אם-אין-הצדקה-למסחר — החזר null בשני-הצדדים עם-טעם-כן.`;

  const raw = await (async () => {
    try {
      const z = await zai();
      const completion = await z.chat.completions.create({
        messages: [
          { role: "assistant", content: SYSTEM },
          { role: "user", content: USER },
        ],
        thinking: { type: "disabled" },
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (e) {
      return `__LLM_ERROR__:${e instanceof Error ? e.message : String(e)}`;
    }
  })();

  if (raw.startsWith("__LLM_ERROR__")) {
    log({ at, agentId: state.agentId, tick: state.tick, mode: "noop", note: raw.slice(0, 200), context });
    return { intents: [], rationale: "llm-unreachable", mode: "noop", note: raw.slice(0, 200) };
  }

  // חילוץ-JSON: התשובה עשויה להכיל מדלפי-קוד — לוקחים את-ה-object הראשון
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    log({ at, agentId: state.agentId, tick: state.tick, mode: "noop", note: "no-json", raw: raw.slice(0, 300), context });
    return { intents: [], rationale: "unparseable", mode: "noop", note: "no-json-in-response" };
  }
  let parsed: { bid?: { price?: unknown; amount?: unknown } | null; ask?: { price?: unknown; amount?: unknown } | null; rationale?: unknown };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    log({ at, agentId: state.agentId, tick: state.tick, mode: "noop", note: "bad-json", raw: raw.slice(0, 300), context });
    return { intents: [], rationale: "unparseable", mode: "noop", note: "bad-json" };
  }

  const intents: LlmIntent[] = [];
  const notes: string[] = [];
  // החוקים מכריעים: מחיר-חיובי-שלם, כמות חתוכה למלאי-מוכח (capBid/capAsk מהגרעין), רצפת-מינימום
  for (const side of ["bid", "ask"] as const) {
    const o = parsed[side];
    if (!o || typeof o !== "object") continue;
    const price = BigInt(String(o.price ?? "0").replace(/[^0-9-]/g, "") || "0");
    const desired = BigInt(String(o.amount ?? "0").replace(/[^0-9-]/g, "") || "0");
    if (price <= 0n) { notes.push(`${side}:rejected(price)`); continue; }
    let amount: bigint | null;
    if (side === "bid") amount = capBid(desired, state.balances.usdsAvailable, price);
    else amount = capAsk(desired, state.balances.saosAvailable);
    if (!amount) { notes.push(`${side}:capped-out`); continue; }
    if (amount !== desired) notes.push(`${side}:capped(${desired}→${amount})`);
    intents.push({ action: "place", side, price, amount, type: "limit" });
  }

  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "(no rationale given)";
  const decision: Decision = { intents, rationale, mode: "ok" };
  log({ at, agentId: state.agentId, tick: state.tick, mode: decision.mode, rationale, caps: notes, intents: intents.map(i => ({ side: i.side, price: i.price.toString(), amount: i.amount.toString() })), rawLen: raw.length, context });
  return decision;
}
