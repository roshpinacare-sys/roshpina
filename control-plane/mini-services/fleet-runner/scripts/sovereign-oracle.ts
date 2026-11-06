/**
 * sovereign-oracle — מחבר עוגני-מחיר אמיתיים מרשתות-ענק אל הרשת-הריבונית שלנו.
 *
 * חוק-כנות: רק נתונים אמיתיים מ-API ציבורי, עם דריכת-מקור מלאה (מקור, זמן, sha256 של
 * התשובה הגולמית). מקור שנכשל מדווח בכנות — אף-עוגן לא מומצא, אף-מחיר לא מדומה.
 * קריאה-בלבד: המחבר לא נוגע בספר, בפנקס או בשימור-כסף. אפס-סיכון למצב-הכסף.
 *
 * מטרה-אסטרטגית: פיזור-ריכוזיות — ערך-העזר של הרשת שלנו לא נשען על רשת-אחת
 * (Steem) אלא על עוגנים חיים מהרשתות-הגדולות (Kraken · Bitstamp ציבוריים, ללא-מפתחות).
 *
 * פלט: data/oracle/anchors.jsonl (שורה-לכל-עוגן) + טבלה כנה ל-stdout (ראיה ביומן-העבודות).
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";

const DATA_DIR = `${import.meta.dir}/../data/oracle`;
const ANCHORS_JSONL = `${DATA_DIR}/anchors.jsonl`;
const MAX_KEEP = 2000; // גבול-שימור: הקובץ נחתך לשורות-אחרונות (אחרי-כתיבה)

type Anchor = {
  at: string;
  source: string;
  network: string; // סמל-הרשת הגדולה (BTC/ETH/SOL)
  pair: string;
  bid: string;
  ask: string;
  last: string;
  volume24h: string;
  rawSha256: string;
};

// סל-העוגנים: הרשתות-הגדולות. הוספת-רשת = הוספת-שורה כאן (חוק-מתאם: לא-נוגעים בליבה)
const BASKET: { network: string; krakenPair: string; bitstampPair: string }[] = [
  { network: "BTC", krakenPair: "XBTUSD", bitstampPair: "btcusd" },
  { network: "ETH", krakenPair: "ETHUSD", bitstampPair: "ethusd" },
  { network: "SOL", krakenPair: "SOLUSD", bitstampPair: "solusd" },
];

const TIMEOUT_MS = 10_000;

async function fetchJson(url: string): Promise<{ ok: true; raw: string; json: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 140)}` };
    return { ok: true, raw, json: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Kraken public Ticker: result.<PAIR>.a=ask[0] b=bid[0] c=last[0] v[1]=vol24h
async function fromKraken(pair: string): Promise<Omit<Anchor, "at" | "source" | "network"> & { pair: string } | { error: string }> {
  const r = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!r.ok) return { error: `kraken: ${r.error}` };
  const h = sha(r.raw);
  const j = r.json as { error?: unknown[]; result?: Record<string, Record<string, string[]>> };
  if (Array.isArray(j.error) && j.error.length > 0) return { error: `kraken: ${JSON.stringify(j.error).slice(0, 140)}` };
  const row = j.result ? Object.values(j.result)[0] : undefined;
  if (!row?.a || !row?.b || !row?.c || !row?.v) return { error: "kraken: missing fields" };
  return { pair, bid: row.b[0], ask: row.a[0], last: row.c[0], volume24h: row.v[1], rawSha256: h };
}

// Bitstamp public v2: {bid, ask, last, volume}
async function fromBitstamp(pair: string): Promise<Omit<Anchor, "at" | "source" | "network"> & { pair: string } | { error: string }> {
  const r = await fetchJson(`https://www.bitstamp.net/api/v2/ticker/${pair}/`);
  if (!r.ok) return { error: `bitstamp: ${r.error}` };
  const h = sha(r.raw);
  const j = r.json as { bid?: string; ask?: string; last?: string; volume?: string };
  if (!j.bid || !j.ask || !j.last) return { error: "bitstamp: missing fields" };
  return { pair, bid: j.bid, ask: j.ask, last: j.last, volume24h: j.volume ?? "0", rawSha256: h };
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const at = new Date().toISOString();
  const anchors: Anchor[] = [];
  const failures: string[] = [];

  for (const b of BASKET) {
    // מקור-ראשי: Kraken; אם-נכשל → Bitstamp (גיבוי). שניהם-נכשלו → כשל-כן לרשת-זו.
    let row = await fromKraken(b.krakenPair);
    let source = "kraken";
    if ("error" in row) {
      failures.push(row.error);
      row = await fromBitstamp(b.bitstampPair);
      source = "bitstamp";
      if ("error" in row) {
        failures.push(row.error);
        console.log(`ORACLE-MISS ${b.network}: both sources failed (honest gap, no fabrication)`);
        continue;
      }
    }
    const anchor: Anchor = { at, source, network: b.network, ...row };
    anchors.push(anchor);
  }

  if (anchors.length > 0) {
    appendFileSync(ANCHORS_JSONL, anchors.map((a) => JSON.stringify(a)).join("\n") + "\n");
    // גיזום: שומר רק MAX_KEEP שורות-אחרונות
    try {
      const lines = readFileSync(ANCHORS_JSONL, "utf8").trim().split("\n");
      if (lines.length > MAX_KEEP) {
        const keep = lines.slice(-MAX_KEEP).join("\n") + "\n";
        const { writeFileSync } = await import("fs");
        writeFileSync(ANCHORS_JSONL, keep);
      }
    } catch {
      // גיזום לעולם לא שובר ריצה
    }
  }

  // טבלה-כנה: הראיה ביומן-העבודות
  console.log(`SOVEREIGN-ORACLE @ ${at} — anchors=${anchors.length}/${BASKET.length} sources=kraken,bitstamp(public,no-keys)`);
  for (const a of anchors) {
    console.log(`  ${a.network.padEnd(4)} ${a.source.padEnd(9)} ${a.pair.padEnd(9)} bid=${a.bid} ask=${a.ask} last=${a.last} vol24=${Number(a.volume24h).toFixed(2)} sha=${a.rawSha256.slice(0, 12)}…`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.log(`  honest-failure: ${f}`);
  }
  // כשל-כן: אפס-עוגנים = יציאה-1 (ה-watchdog והמדדים יראו זאת — אין-הסתרה)
  if (anchors.length === 0) {
    console.error("ORACLE-FAIL: zero anchors (no fabrication)");
    process.exit(1);
  }
  console.log("ORACLE-OK");
}

await main();
