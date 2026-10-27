/**
 * agent-pnl.ts — סקורבורד ניסוי ה-A/B של הצי-הריבוני: מוח-LLM (epsilon) מול אסטרטגיות-אלגוריתמיות.
 *
 * השאלה שהמדד עונה עליה בכנות: האם אינטליגנציה אמיתית (LLM) מרוויחה יותר מכללי-אצבע
 * אלגוריתמיים — בכסף-חי, על-ספר-חי, עם-חוקי-מלאי-אמיתיים? זה המדד שהופך "יש לנו
 * סוכן-AI" מטענה-שיווקית לניסוי מדיד מתמשך.
 *
 * חוקי-כנות:
 *  - P&L מאז-inception אינו ניתן-לשחזור: יומני-המשמורת נחתכו ב-boot-repair
 *    (2026-10-18, prevHash=GENESIS) — שחזור-הקצאות-הייסוד מהיומנים היה-המצאה.
 *    לכן המדד מבוסס-מדידה: baseline נרשם בריצה-הראשונה וכל-ריצה מדווחת דלתא ממנו.
 *    החל מריצה-זו, כל-דלתא היא עובדה מדודה — לא שחזור.
 *  - שווי = USDS (פנוי+נעול+סטייק) + SAOS (פנוי+נעול) × mid-הספר-החי (µ¢/SAOS).
 *    הסטייק נספר — הוא הון-חי שמניב; הנעול נספר — הוא בבעלות-הסוכן.
 *  - שימור שבור (holds:false) = exit 1 — מסרב לדרג כסף שבור.
 *  - ספר ריק דו-צדדית = exit 1 — מסרב להמציא מחיר-שווי.
 *  - סוכן-חדש שנצפה = נכנס ל-baseline בשוויו-אז (delta=0 בריצה-הראשונה-שלו) —
 *    סוכן לא נולד עם רווח-פנטום.
 *
 * רץ: bun scripts/agent-pnl.ts · exit 1 = מדידה לא-אמינה (רועש, לא-מוסתר)
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const MARKET = process.env.SOVR_MARKET_URL ?? "http://127.0.0.1:3033";
const AI_DIR = join(import.meta.dir, "..", "data", "ai");
const BASELINE = join(AI_DIR, "agent-pnl-baseline.json");
const LEDGER_JSONL = join(AI_DIR, "agent-pnl.jsonl");
const LAST_JSON = join(AI_DIR, "agent-pnl-last.json");
const TIMEOUT = 8_000;

type Agent = { agentId: string; usds: string; usdsLocked: string; usdsStaked?: string; saos: string; saosLocked: string; fills: number };
type Row = { agentId: string; kind: "LLM" | "algo"; wealth: string; delta: string; deltaPct: number | null; fills: number };

function fail(msg: string): never {
  console.error(`AGENT-PNL-FAIL: ${msg}`);
  process.exit(1);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
  return JSON.parse(raw) as T;
}

function trimJsonl(path: string, max = 2000): void {
  try {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf8").trim().split("\n");
    if (lines.length > max) writeFileSync(path, lines.slice(lines.length - max).join("\n") + "\n");
  } catch { /* trimming never breaks scoring */ }
}

async function main(): Promise<void> {
  const at = new Date().toISOString();
  const rep = await getJson<{
    conservation?: { quote?: { holds?: boolean }; base?: { holds?: boolean } };
    book?: { bestBid: string | null; bestAsk: string | null; trades?: number };
    settledTrades?: number;
    agents?: Agent[];
    treasury?: { usds?: string };
  }>(`${MARKET}/economy/report`).catch((e) => fail(`market unreachable: ${e instanceof Error ? e.message : String(e)}`));

  // ── gate: מסרב לדרג כסף שבור ──
  if (rep.conservation?.quote?.holds !== true || rep.conservation?.base?.holds !== true) {
    fail(`conservation broken (quote.holds=${String(rep.conservation?.quote?.holds)} base.holds=${String(rep.conservation?.base?.holds)}) — refuse to score broken money`);
  }
  const agents = rep.agents ?? [];
  if (agents.length === 0) fail("no agents in economy report");

  // ── mid: ספר דו-צדדי קודם; צד-יחיד מותר בכנות; ריק משני-הצדדים = כישלון ──
  const bid = rep.book?.bestBid ? BigInt(rep.book.bestBid) : null;
  const ask = rep.book?.bestAsk ? BigInt(rep.book.bestAsk) : null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2n : bid ?? ask;
  if (mid === null) fail("book empty on both sides — refuse to invent a valuation price");

  // יחידות (חוק-ה-×10⁶): SAOS ב-µ-SAOS, mid ב-µ¢/SAOS ⇒ SAOS×mid/10⁶ = µ¢.
  // נתפס-בריצה-הראשונה (המדד הציג שווי מנופח ×10⁶) — תוקן לפני-הbaseline האמיתי.
  const wealthOf = (a: Agent): bigint =>
    BigInt(a.usds) + BigInt(a.usdsLocked) + BigInt(a.usdsStaked ?? "0") + ((BigInt(a.saos) + BigInt(a.saosLocked)) * mid) / 1_000_000n;

  // ── baseline: המדידה-הראשונה היא הייסוד של-המדד (לא שחזור, לא המצאה) ──
  mkdirSync(AI_DIR, { recursive: true });
  let baseline: { createdAt: string; midBaseline: string; wealths: Record<string, string>; joinedAt: Record<string, string> } | null = null;
  if (existsSync(BASELINE)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof baseline;
    } catch {
      baseline = null;
    }
  }
  const mode = baseline ? "measure" : "baseline-set";
  if (!baseline) {
    baseline = {
      createdAt: at,
      midBaseline: mid.toString(),
      wealths: Object.fromEntries(agents.map((a) => [a.agentId, wealthOf(a).toString()])),
      joinedAt: Object.fromEntries(agents.map((a) => [a.agentId, at])),
    };
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + "\n");
    console.log(`AGENT-PNL: baseline set @ ${at} — ${agents.length} agents, mid=${mid.toString()} µ¢/SAOS. הדלתות יימדדו מכאן והלאה (כנות: אין-שחזור-inception).`);
  } else {
    // סוכן-חדש: נכנס ל-baseline בשוויו-אז — אפס-רווח-פנטום
    let joined = false;
    for (const a of agents) {
      if (!baseline.wealths[a.agentId]) {
        baseline.wealths[a.agentId] = wealthOf(a).toString();
        baseline.joinedAt[a.agentId] = at;
        joined = true;
      }
    }
    if (joined) writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + "\n");
  }

  // ── סקורבורד: דלתא-שווי מה-baseline ──
  const rows: Row[] = [];
  const vanished: string[] = [];
  for (const a of agents) {
    const w = wealthOf(a);
    const b = baseline.wealths[a.agentId];
    const delta = b !== undefined ? w - BigInt(b) : 0n;
    const bNum = b !== undefined ? BigInt(b) : 0n;
    rows.push({
      agentId: a.agentId,
      kind: a.agentId === "epsilon" ? "LLM" : "algo",
      wealth: w.toString(),
      delta: delta.toString(),
      deltaPct: bNum > 0n ? Number((delta * 10_000n) / bNum) / 100 : null,
      fills: a.fills ?? 0,
    });
  }
  for (const id of Object.keys(baseline.wealths)) if (!agents.some((a) => a.agentId === id)) vanished.push(id);
  rows.sort((x, y) => (BigInt(y.delta) > BigInt(x.delta) ? 1 : BigInt(y.delta) < BigInt(x.delta) ? -1 : 0));

  const epsIdx = rows.findIndex((r) => r.agentId === "epsilon");
  const bestAlgo = rows.find((r) => r.kind === "algo");
  const eps = epsIdx >= 0 ? rows[epsIdx] : null;
  const verdict =
    eps === null
      ? "epsilon לא נצפה בדוח — המוח מחוץ לשוק כרגע"
      : epsIdx === 0
        ? "המוח-LLM מוביל על כל-האלגוריתמים"
        : `המוח במקום #${epsIdx + 1}/${rows.length} · האלגוריתם-המוביל: ${bestAlgo?.agentId} (${bestAlgo?.delta} µ¢)`;

  const out = {
    at,
    mode,
    mid: mid.toString(),
    feesTotal: rep.treasury?.usds ?? null,
    bookTrades: rep.book?.trades ?? null,
    settledTrades: rep.settledTrades ?? null,
    epsilonRank: epsIdx >= 0 ? epsIdx + 1 : null,
    verdict,
    rows,
    vanished: vanished.length ? vanished : undefined,
  };
  appendFileSync(LEDGER_JSONL, JSON.stringify(out) + "\n");
  trimJsonl(LEDGER_JSONL);
  writeFileSync(LAST_JSON, JSON.stringify(out, null, 1) + "\n");

  console.log(`AGENT-PNL @ ${at} · mid=${mid.toString()} µ¢/SAOS · fees=${out.feesTotal} · book-trades=${out.bookTrades}`);
  for (const r of rows) {
    const sign = r.delta.startsWith("-") ? "" : "+";
    console.log(`  #${rows.indexOf(r) + 1} ${r.agentId.padEnd(9)} [${r.kind}] wealth=${r.wealth.padStart(14)} µ¢ · Δ=${sign}${r.delta} µ¢ (${r.deltaPct === null ? "n/a" : sign + r.deltaPct + "%"}) · fills=${r.fills}`);
  }
  if (vanished.length) console.log(`  vanished-from-report: ${vanished.join(",")}`);
  console.log(`AGENT-PNL-OK · ${verdict}`);
}

await main();
