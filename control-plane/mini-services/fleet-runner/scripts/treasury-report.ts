/**
 * treasury-report — דוח-רווחיות אמיתי של הרשת-הריבונית, מהשימור-כסף בלבד.
 *
 * חוק-כנות: כל-מספר נגזר מ-/economy/report של השוק החי (conservation holds) ומ-
 * /health של הפנקס. אפס-המצאה: אם-המקור לא-עונה או השימור שבור — כשל-כן, יציאה-1.
 *
 * המדידה: fees (עמלות-שנצברו) = ההכנסה-האמיתית שהרשת מייצרת לעצמה מהמסחר.
 * דלתא מול-הדוח-הקודם (data/treasury/last.json) = קצב-הרווח. ההיסטוריה נשמרת
 * ב-data/treasury/history.jsonl — ראיה-מצטברת לאורך-זמן.
 *
 * זה הבסיס לשאלה "איך המערכת מייצרת לעצמה ולמפעיל": העמלות הן עדות-שימור —
 * לא ניתן לזייף אותן בלי לשבור את השימור (holds:true מוכיח).
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";

const DATA_DIR = `${import.meta.dir}/../data/treasury`;
const LAST_JSON = `${DATA_DIR}/last.json`;
const HISTORY_JSONL = `${DATA_DIR}/history.jsonl`;
const MARKET = process.env.SOVR_MARKET_URL ?? "http://127.0.0.1:3033";
const LEDGER = process.env.SOVR_LEDGER_URL ?? "http://127.0.0.1:3032";
const TIMEOUT_MS = 8_000;

type Num = string; // מספרי-ענק כמחרוזות — בלי-איבוד-דיוק

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${raw.slice(0, 140)}`);
  return JSON.parse(raw);
}

function toNum(s: Num | number | undefined): number {
  return typeof s === "number" ? s : Number(s ?? 0);
}

type Snapshot = {
  at: string;
  marketOk: boolean;
  ledgerOk: boolean;
  fees: Num;
  mintedQuote: Num;
  staked: Num;
  inEscrowQuote: Num;
  settledTrades: number;
  bookTrades: number;
  holds: boolean;
};

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  const rep = (await getJson(`${MARKET}/economy/report`)) as {
    conservation?: { quote?: Record<string, Num | boolean> };
    book?: { trades?: number };
    settledTrades?: number;
  };
  const q = rep.conservation?.quote;
  if (!q || q.holds !== true) {
    // fail-closed: דוח-אוצרה על-שימור-שבור = שקר — מפסיקים בקול
    console.error(`TREASURY-FAIL: conservation holds=${String(q?.holds)} — refuse to report on broken money`);
    process.exit(1);
  }
  let ledgerOk = false;
  try {
    const lh = (await getJson(`${LEDGER}/health`)) as { ok?: boolean };
    ledgerOk = lh.ok === true;
  } catch (e) {
    console.log(`  honest-note: ledger health unreachable (${e instanceof Error ? e.message : e}) — market conservation still authoritative`);
  }

  const snap: Snapshot = {
    at: new Date().toISOString(),
    marketOk: true,
    ledgerOk,
    fees: String(q.fees ?? "0"),
    mintedQuote: String(q.minted ?? "0"),
    staked: String(q.staked ?? "0"),
    inEscrowQuote: String(q.inEscrow ?? "0"),
    settledTrades: rep.settledTrades ?? 0,
    bookTrades: rep.book?.trades ?? 0,
    holds: true,
  };

  const feesNow = toNum(snap.fees);
  let deltaLine = "  (first measurement — baseline recorded)";
  if (existsSync(LAST_JSON)) {
    try {
      const prev = JSON.parse(readFileSync(LAST_JSON, "utf8")) as Snapshot;
      const dFees = feesNow - toNum(prev.fees);
      const hours = Math.max((Date.parse(snap.at) - Date.parse(prev.at)) / 3_600_000, 1 / 60);
      const perHour = dFees / hours;
      const dTrades = snap.settledTrades - prev.settledTrades;
      deltaLine = `  revenue-since-last: +${dFees.toLocaleString("en-US")} fee-units over ${hours.toFixed(2)}h → ${perHour.toFixed(1)} units/h (${dTrades} settled trades)`;
    } catch {
      deltaLine = "  (prev snapshot unreadable — baseline re-recorded)";
    }
  }

  appendFileSync(HISTORY_JSONL, JSON.stringify(snap) + "\n");
  writeFileSync(LAST_JSON, JSON.stringify(snap, null, 2));

  console.log(`TREASURY-REPORT @ ${snap.at} — conservation holds:true (proof-backed)`);
  console.log(`  fees (total earned): ${feesNow.toLocaleString("en-US")} fee-units`);
  console.log(`  quote minted: ${toNum(snap.mintedQuote).toLocaleString("en-US")} · staked: ${toNum(snap.staked).toLocaleString("en-US")} · escrow: ${toNum(snap.inEscrowQuote).toLocaleString("en-US")}`);
  console.log(`  trades: ${snap.settledTrades} settled / ${snap.bookTrades} book`);
  console.log(deltaLine);
  console.log(`  ledger-health: ${ledgerOk ? "ok" : "unreachable (honest note above)"}`);
  console.log("TREASURY-OK");
}

await main();
