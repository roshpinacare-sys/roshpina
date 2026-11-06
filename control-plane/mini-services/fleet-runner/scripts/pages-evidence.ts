#!/usr/bin/env bun
/**
 * pages-evidence — גשר-הראיות: הארכיטקטורה הריבונית מפרסמת את עצמה ל-GitHub Pages.
 *
 * צו-מפעיל (trace 1a15ce0b8dbf6c71, R45): "אני רוצה שימוש בכל הכלים שיש לנו... האתרים
 * נופלים, לא נעקבים, מידע לא תמיד נכון" — התיקון: הרשת עצמה אוספת את הראיות החיות
 * שלה ודוחפת אותן ל-Domain/press/evidence.json על בסיס קבוע, בלי-סוכן, בלי-בקשה.
 *
 * מקורות (כולם ציבוריים-בטוחים, כל-מקור fail-soft עצמאי):
 *   מטריצת-יכולות (data/ai/capability-matrix.json)      — מה הארכיטקטורה יודעת באמת
 *   אוצרה (data/treasury/last.json)                      — עמלות-אמת, סטייק, התיישבויות
 *   עוגני-אורקל (data/oracle/anchors.jsonl)              — עוגן אחרון + גיל
 *   מועצה (data/sovereign/last-decision.json + count)    — ההחלטה הריבונית האחרונה
 *   שער-סודות (data/sovereign/secrets-gate.json)         — verdict קדם-דחיפה
 *   תזמונים (data/schedules.json)                        — האוטונומיה המתוזמנת במספרים
 *   פנקס (ROSHPINA data/ledger-net/journal.jsonl)        — seq/head/גיל + התיישבויות-24ש + עמלות
 *   שוק (:3033 /health /market/book /desk/state)         — ספר חי, ספרד, שולחנות-יצירת-שוק
 *   זיכרון-בעלים (ROSHPINA sovereignty/owner-memory.json) — ספירת-הנחיות + עקבה אחרונה
 *
 * חוקי-כנות (R28/R43):
 *   - מקור שנכשל → {available:false, reason} בכנות — לעולם לא מספר-מזויף.
 *   - הפלט עובר שער-סודות (scanBuffer) לפני-כתיבה — פגיעה אחת = exit 1, שום-דבר לא נדחף.
 *   - אימות-אחרי-פרסום: קריאת ה-URL החי; נרשם ב-yomna data/sovereign/pages-publish.jsonl (נשמר 400).
 *   - כתיבה אטומית + git pull --rebase לפני דחיפה (חוק-נחיתה של Domain/AGENTS.md) — אין דריסות.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scanBuffer } from "./secrets-gate.ts";

// הסקריפט חי תחת scripts/ — שורש-הראנר הוא רמה אחת מעלה (import.meta.dir מניב את scripts/)
const RUNNER_DIR = path.resolve(import.meta.dir, "..");
const DATA_DIR = `${RUNNER_DIR}/data`;
const ROSHPINA = "/home/z/repos/roshpina";
const DOMAIN = "/home/z/repos/domain";
const PAGES_URL = "https://roshpinacare-sys.github.io/Domain/press/evidence.json";
const KEEP = 400;

type Src = { available: boolean; reason?: string; at?: string } & Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const ageMin = (iso?: string) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// קורא-סובלני: קבצי-מצב שנפגעו מכתיבה-כפולה-קרועה (מסמכי-JSON מחוברים) — מחזיר את
// המסמך האחרון השלם-עד-סוף-הקובץ (הטרי). רגילים נקראים כרגיל.
function readJsonTolerant(p: string): unknown | null {
  let raw = "";
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch { /* torn — fall through to brace-scan */ }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    try {
      const v = JSON.parse(raw.slice(i));
      return v; // הסוגריים-הראשונים-משמאל שמהם כל-היתר מתפרש = שורש-המסמך האחרון
    } catch { /* not a root document — keep scanning */ }
  }
  return null;
}

async function jget(url: string, timeoutMs = 8000): Promise<unknown> {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "agent4-pages-evidence" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

/* ─── 1) מטריצת-יכולות ─────────────────────────────────────────────────────── */
function capMatrix(): Src {
  const d = readJson(`${DATA_DIR}/ai/capability-matrix.json`) as { at?: string; verdict?: string; summary?: { pass?: number; fail?: number; gaps?: number } } | null;
  if (!d) return { available: false, reason: "capability-matrix.json לא נקרא" };
  return { available: true, at: d.at, verdict: d.verdict, pass: d.summary?.pass ?? 0, fail: d.summary?.fail ?? 0, gaps: d.summary?.gaps ?? 0 };
}

/* ─── 2) אוצרה ─────────────────────────────────────────────────────────────── */
function treasury(): Src {
  const d = readJson(`${DATA_DIR}/treasury/last.json`) as { at?: string; fees?: string; settledTrades?: number; staked?: string; marketOk?: boolean; ledgerOk?: boolean } | null;
  if (!d) return { available: false, reason: "treasury/last.json לא נקרא" };
  // fees הם מיקרו-סנט (µ¢) — מומר לדולר לקריאות
  const feesUsd = num(d.fees) / 1e6;
  return { available: true, at: d.at, feesUsd: Math.round(feesUsd * 1e6) / 1e6, settledTrades: d.settledTrades ?? 0, stakedQuote: num(d.staked), marketOk: d.marketOk === true, ledgerOk: d.ledgerOk === true };
}

/* ─── 3) עוגני-אורקל ──────────────────────────────────────────────────────── */
function oracle(): Src {
  try {
    const p = `${DATA_DIR}/oracle/anchors.jsonl`;
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const ts = (last.ts ?? last.at) as string | undefined;
    return { available: true, at: ts ?? null, ageMin: ageMin(ts), source: last.source ?? null, network: last.network ?? null, pair: last.pair ?? null, price: last.last ?? null };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── 4) מועצת-הריבון ──────────────────────────────────────────────────────── */
function council(): Src {
  try {
    const last = readJsonTolerant(`${DATA_DIR}/sovereign/last-decision.json`) as { runAt?: string; decisions?: Array<{ at?: string; kind?: string }> } | null;
    let count = 0;
    try {
      count = readFileSync(`${DATA_DIR}/sovereign/decisions.jsonl`, "utf8").split("\n").filter(Boolean).length;
    } catch { /* count stays 0 */ }
    if (!last || !Array.isArray(last.decisions) || !last.decisions.length) {
      return { available: false, reason: "last-decision.json ריק/מבנה-לא-צפוי" };
    }
    const dec = last.decisions[last.decisions.length - 1];
    return { available: true, at: dec.at ?? last.runAt ?? null, kind: dec.kind ?? null, decisionsTotal: count };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── 5) שער-סודות ─────────────────────────────────────────────────────────── */
function secretsGate(): Src {
  const d = readJson(`${DATA_DIR}/sovereign/secrets-gate.json`) as { at?: string; verdict?: string; filesScanned?: number } | null;
  if (!d) return { available: false, reason: "secrets-gate.json לא נקרא" };
  return { available: true, at: d.at, verdict: d.verdict, filesScanned: d.filesScanned ?? 0 };
}

/* ─── 6) תזמונים ───────────────────────────────────────────────────────────── */
function schedules(): Src {
  const arr = readJson(`${DATA_DIR}/schedules.json`) as Array<{ enabled?: boolean; lastStatus?: string | null; runCount?: number; failCount?: number }> | null;
  if (!Array.isArray(arr)) return { available: false, reason: "schedules.json לא נקרא" };
  const enabled = arr.filter((s) => s.enabled);
  let runs = 0, fails = 0;
  for (const s of arr) { runs += num(s.runCount); fails += num(s.failCount); }
  return { available: true, total: arr.length, enabled: enabled.length, runsTotal: runs, failsTotal: fails, successRate: runs ? Math.round(((runs - fails) / runs) * 1000) / 10 : null };
}

/* ─── 7) הפנקס החתום ──────────────────────────────────────────────────────── */
function ledger(): Src {
  try {
    const p = `${ROSHPINA}/data/ledger-net/journal.jsonl`;
    const st = statSync(p);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (!lines.length) return { available: false, reason: "journal ריק" };
    const last = JSON.parse(lines[lines.length - 1]) as { seq?: number; ts?: string; prevHash?: string; rec?: { tx?: { memo?: string } } };
    // התיישבויות + עמלות ב-24 השעות האחרונות — ממיטבי-זיכרון של הזנב בלבד
    const tail = lines.slice(-600);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let settles24h = 0, fees24hMicro = 0;
    for (const line of tail) {
      try {
        const rec = JSON.parse(line) as { ts?: string; rec?: { tx?: { memo?: string } } };
        if (!rec.ts || Date.parse(rec.ts) < cutoff) continue;
        const memo = rec.rec?.tx?.memo ?? "";
        if (memo.startsWith("market settle")) settles24h++;
        const fee = /fees:usds \+([0-9.]+)/.exec(memo);
        if (fee) fees24hMicro += Math.round(num(fee[1]));
      } catch { /* torn line tolerated */ }
    }
    return {
      available: true,
      seq: last.seq ?? null,
      headPrevHash: (last.prevHash ?? "").slice(0, 12),
      lastTs: last.ts ?? null,
      ageMin: ageMin(last.ts),
      records: lines.length,
      settles24h,
      fees24hUsd: Math.round(fees24hMicro) / 1e6,
      mtimeIso: st.mtime.toISOString(),
    };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── 8) השוק החי (:3033) ──────────────────────────────────────────────────── */
async function market(): Promise<Src> {
  try {
    const health = (await jget("http://127.0.0.1:3033/health")) as { trades?: number; bids?: number; asks?: number; desk?: string; bootedAt?: string };
    const book = (await jget("http://127.0.0.1:3033/market/book")) as { bids?: Array<{ price?: string }>; asks?: Array<{ price?: string }> };
    let spreadBps: number | null = null;
    const bestBid = book.bids?.[0]?.price ? num(book.bids[0].price) : null;
    const bestAsk = book.asks?.[0]?.price ? num(book.asks[0].price) : null;
    if (bestBid && bestAsk && bestAsk > bestBid) spreadBps = Math.round(((bestAsk - bestBid) / bestBid) * 1e4 * 10) / 10;
    let desk: unknown = null;
    try {
      const d = (await jget("http://127.0.0.1:3033/desk/state")) as Record<string, unknown>;
      desk = { enabled: d.enabled === true, keys: Object.keys(d).slice(0, 8) };
    } catch { /* desk state optional */ }
    return { available: true, trades: health.trades ?? 0, bids: health.bids ?? 0, asks: health.asks ?? 0, spreadBps, deskOn: health.desk === "on", desk, bootedAt: health.bootedAt ?? null };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── 9) זיכרון-בעלים ──────────────────────────────────────────────────────── */
function ownerMemory(): Src {
  try {
    const d = readJson(`${ROSHPINA}/sovereignty/owner-memory.json`) as { directiveLog?: Array<{ trace?: string; at?: string }> } | null;
    const dl = d?.directiveLog ?? [];
    if (!dl.length) return { available: false, reason: "directiveLog ריק/חסר" };
    return { available: true, directives: dl.length, lastTrace: dl[dl.length - 1].trace ?? null, lastAt: dl[dl.length - 1].at ?? null };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── 10) גריל-האמת (צו 1a15f55f6d0395f9) — פסיקת-הביקורת-האדיברסרית ────────── */
function roastGrill(): Src {
  try {
    const d = readJson(`${DATA_DIR}/ai/roast-grill.json`) as { at?: string; verdict?: string; summary?: { pass?: number; fail?: number; gaps?: number; controls?: string }; painful?: string[] } | null;
    if (!d) return { available: false, reason: "roast-grill.json לא נקרא" };
    return { available: true, at: d.at, verdict: d.verdict, pass: d.summary?.pass ?? 0, fail: d.summary?.fail ?? 0, gaps: d.summary?.gaps ?? 0, controls: d.summary?.controls ?? "unknown", painfulTop: (d.painful ?? []).slice(0, 3) };
  } catch (e) {
    return { available: false, reason: String((e as Error).message).slice(0, 90) };
  }
}

/* ─── יומן-פרסום (נשמר 400) ───────────────────────────────────────────────── */
function appendVerdict(rec: Record<string, unknown>): void {
  try {
    const p = `${DATA_DIR}/sovereign/pages-publish.jsonl`;
    mkdirSync(path.dirname(p), { recursive: true });
    try {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
      if (lines.length >= KEEP) writeFileSync(p, lines.slice(lines.length - KEEP + 1).join("\n") + "\n");
    } catch { /* first write */ }
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch { /* evidence never breaks execution */ }
}

function git(args: string[], opts?: { cwd?: string }): string {
  return execFileSync("git", args, { cwd: opts?.cwd ?? DOMAIN, encoding: "utf8", timeout: 60_000 }).trim();
}

/* AGENT4-SELFHEAL BEGIN (agent4 · trace 1a15dbda28281651).
   נמדד 08:50: סביבת-העבודה נגזמה בין-ריצות (7× "not a git repository", הריצה מתה
   ב-100ms). ה-cure: הגשר מרפא את עצמו — אם .git חסר, משובט מחדש; אם התיקייה לא-ריקה,
   היא מוזזת הצידה ל-/tmp (לא-הרסני, ניתן-לשחזור). אין-נתונים ריבוניים כאן — כל-האמת
   בגיט; הארכיטקטורה חייבת לרוץ בלי אף-אחד, כולל בלי סביבה שנגזמה. */
function ensureDomainRepo(origin: string): void {
  if (existsSync(path.join(DOMAIN, ".git"))) return;
  try {
    execFileSync("git", ["clone", "--quiet", origin, DOMAIN], { cwd: "/tmp", encoding: "utf8", timeout: 120_000 });
    return;
  } catch {
    const aside = `/tmp/domain-gutted-${Date.now()}`;
    execFileSync("mv", [DOMAIN, aside], { cwd: "/tmp", encoding: "utf8", timeout: 30_000 });
    execFileSync("git", ["clone", "--quiet", origin, DOMAIN], { cwd: "/tmp", encoding: "utf8", timeout: 120_000 });
  }
}
/* AGENT4-SELFHEAL END */

/* ─── main ─────────────────────────────────────────────────────────────────── */
const startedIso = nowIso();
const sources = {
  capability: capMatrix(),
  treasury: treasury(),
  oracle: oracle(),
  council: council(),
  secretsGate: secretsGate(),
  schedules: schedules(),
  ledger: ledger(),
  market: await market(),
  ownerMemory: ownerMemory(),
  roastGrill: roastGrill(),
};

const evidence = {
  schema: "agent4.evidence.v1",
  generatedAt: startedIso,
  lane: "agent4/p2-sovereign-market",
  publisher: "fleet-runner:pages-evidence (הארכיטקטורה מפרסמת את עצמה — בלי-סוכן, בלי-בקשה)",
  honesty: "כל מקור נמדד בנפרד ברגע-האפייה; מקור שלא השיב מדווח available:false — אין אומדן ואין המצאה. אפס-סודות: התוכן עובר שער-סודות לפני-פרסום.",
  sources,
};

const json = JSON.stringify(evidence, null, 2);

/* שער-סודות על התוכן המדויק שעומד להידחף — fail-closed */
const gate = scanBuffer("press/evidence.json", Buffer.from(json));
if (gate.hits.length > 0) {
  appendVerdict({ ts: nowIso(), action: "pages-evidence", result: "SECRETS-GATE-ABORT", hits: gate.hits.length });
  console.log(JSON.stringify({ state: "fail-closed", reason: "secrets-gate hits", count: gate.hits.length }));
  process.exit(1);
}

/* טוקן + ריפוי-מרחב-עבודה לפני כל-כתיבה — נמדד 2026-10-21 16:19: הקובץ-הטרי נכתב אל העץ-הגרוע,
   ensureDomainRepo הזיז אותו הצידה ושיבט-נקי חזר — העדות-הטרייה אבדה עם ההזזה וה-verdict הכריז
   PUBLISHED על push-ריק. הסדר-הנכון: ריפוי → כתיבה → קומיט → דחיפה → הוכחה מרוחקת. */
const token = (() => {
  try {
    const env = readFileSync("/home/z/my-project/upload/pat.env", "utf8");
    return /(?:GITHUB_TOKEN|PAT)\s*=\s*([A-Za-z0-9_]+)/.exec(env)?.[1] ?? "";
  } catch { return ""; }
})();
if (!token) {
  appendVerdict({ ts: nowIso(), action: "pages-evidence", result: "NO-TOKEN-ABORT" });
  console.log(JSON.stringify({ state: "fail-closed", reason: "no push token" }));
  process.exit(1);
}
const origin = `https://x-access-token:${token}@github.com/roshpinacare-sys/Domain.git`;
ensureDomainRepo(origin); // AGENT4-SELFHEAL: gutted workspace healed BEFORE any write — the fresh evidence can never be moved aside again

/* כתיבה אטומית למוצב-Domain */
const abs = path.join(DOMAIN, "press", "evidence.json");
mkdirSync(path.dirname(abs), { recursive: true });
let prev = "";
try { prev = readFileSync(abs, "utf8"); } catch { /* first publish */ }
if (prev === json) {
  appendVerdict({ ts: nowIso(), action: "pages-evidence", result: "no-change" });
  console.log(JSON.stringify({ state: "ok", publish: "same" }));
  process.exit(0);
}
const tmp = `${abs}.tmp-${process.pid}`;
writeFileSync(tmp, json);
renameSync(tmp, abs);

/* דחיפה עם משמעת-מרוץ (AGENTS.md: pull --rebase לפני push) */
const dirty = (() => { try { return git(["status", "--porcelain", "press/evidence.json"]).length > 0; } catch { return false; } })();
if (dirty) {
  git(["add", "press/evidence.json"]);
  git(["-c", "user.name=agent4-runner", "-c", "user.email=agent4-runner@users.noreply.github.com", "commit", "-m", `agent4: sovereign evidence refresh ${startedIso} [skip ci]`]);
}
// לולאת-מרוץ: pull --rebase → push; כישלון = הצי הקדים אותנו — מתכנסים ומנסים שוב.
// הקומיט המקומי נשמר בין-ניסיונות (מחיקת-קומיט = אובדן-ראיות — אסור).
let pushed = false, pushErr = "";
for (let i = 1; i <= 3 && !pushed; i++) {
  try {
    git(["pull", "--rebase", "-q"]);
    git(["push", "--quiet", origin, "main"]);
    pushed = true;
  } catch (e) {
    pushErr = String((e as Error).message).slice(0, 160);
    console.log(JSON.stringify({ state: "push-race", attempt: i, msg: pushErr }));
    try { git(["rebase", "--abort"]); } catch { /* no rebase in progress */ }
    // AGENT4-JITTER: de-race the per-minute sibling storm (measured 08:50 collision window)
    await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
  }
}
if (!pushed) {
  appendVerdict({ ts: nowIso(), action: "pages-evidence", result: "PUSH-FAIL", msg: pushErr });
  console.log(JSON.stringify({ state: "fail-closed", reason: "push failed after 3 attempts" }));
  process.exit(1);
}

/* הוכחת-דחיפה (נמדד 2026-10-21 16:20: PUBLISHED הוכרז על push-ריק אחרי הזזה-הצידה שבלעה את
   העדות-הטרייה) — ה-HEAD המרוחק חייב להיות בדיוק ה-HEAD המקומי; אחרת כישלון-רועש, לא הצהרה */
let remoteSha = "";
try {
  const ls = execFileSync("git", ["ls-remote", origin, "refs/heads/main"], { cwd: DOMAIN, encoding: "utf8", timeout: 30_000 });
  remoteSha = ls.trim().split(/\s+/)[0] ?? "";
} catch { remoteSha = ""; }
const localSha = git(["rev-parse", "HEAD"]);
if (!remoteSha || remoteSha !== localSha) {
  appendVerdict({ ts: nowIso(), action: "pages-evidence", result: "PUSH-UNVERIFIED", remote: remoteSha.slice(0, 10), local: String(localSha).slice(0, 10) });
  console.log(JSON.stringify({ state: "fail-closed", reason: "remote main != local HEAD after push" }));
  process.exit(1);
}

/* אימות-אחרי-פרסום — ה-URL החי (Pages עשוי להתעדכן בתפוגה; מדווח בכנות) */
let verified = "pending-deploy";
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, 20_000));
  try {
    const live = (await jget(`${PAGES_URL}?t=${Date.now()}`)) as { generatedAt?: string };
    if (live.generatedAt === startedIso) { verified = "ok"; break; }
    verified = `stale:${live.generatedAt ?? "null"}`;
  } catch { verified = "unreachable"; }
}
appendVerdict({ ts: nowIso(), action: "pages-evidence", result: pushed ? "PUBLISHED" : "FAIL", sha: remoteSha.slice(0, 10), verified, sourcesAvailable: Object.entries(sources).filter(([, v]) => v.available).length });
console.log(JSON.stringify({ state: "ok", publish: "pushed", verified, sources: Object.keys(sources).length }));
