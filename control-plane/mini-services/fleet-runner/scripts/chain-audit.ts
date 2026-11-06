/**
 * chain-audit — ביקורת-שרשרת בלתי-תלויה של הפנקס הריבוני.
 *
 * למה: הפנקס מאמת את עצמו באתחול (verify:"full" ב-serve.ts), אבל זו בדיקה
 * עצמית. החוק של הבעלים: "אל תסמוך על הטענות שלך" — אז מישהו אחר חייב לבדוק
 * אותה שרשרת, מהדיסק, במימוש נפרד. הסקריפט הזה הוא ה"מישהו אחר".
 *
 * מה נעשה (אפס-אמון בתהליך החי):
 *   1. קריאת journal.meta.json (baseSeq) + journal.jsonl מהדיסק המתמיד.
 *   2. חישוב-מחדש עצמאי לגמרי (מימוש canonicalJson מקומי — בלי לייבא את הקרנל)
 *      של sha256({seq, prevHash, ts, rec}) לכל רשומה, מול ה-hash החתום בקובץ.
 *   3. אימות שרשרת-prevHash (כל רשומה מצביעה על קודמת) + עיגון-snapshot:
 *      snapshot.json.seq == baseSeq && snapshot.head == prevHash-של-הראשונה.
 *   4. צליבה מול הצומת החי /health: lastSeq == live.seq && lastHash == live.head.
 *
 * fail-closed: כל פער, ריק, שבר-שרשרת, זנב-קרוע או צומת-שקרי = exit 1 רועש.
 * ראיות: data/ai/chain-audit.jsonl (append-only, trim 500).
 * רץ: bun scripts/chain-audit.ts
 */

import { appendFileSync, existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";

const LEDGER_DIR = process.env.CHAIN_AUDIT_DIR ?? "/home/z/repos/roshpina/data/ledger-net";
const LEDGER_URL = process.env.CHAIN_AUDIT_URL ?? "http://127.0.0.1:3032";
const EVIDENCE = `${import.meta.dir.replace(/\/scripts$/, "")}/data/ai/chain-audit.jsonl`;
const MAX_EVIDENCE = 500;

const fail = (msg: string): never => {
  console.error(`CHAIN-AUDIT-FAIL: ${msg}`);
  process.exit(1);
};

// ── מימוש canonicalJson עצמאי (חייב להתאים בדיוק ל-kernel/common/canonical-json) ──
// מפתחות ממוינים רקורסיבית; BigInt → {"$bigint":"..."}; undefined מושמט.
function canonicalSerialise(val: unknown, active: Set<object>): string | undefined {
  if (val === undefined) return undefined;
  if (val === null) return "null";
  if (typeof val === "bigint") return '{"$bigint":' + JSON.stringify(val.toString()) + "}";
  if (typeof val !== "object") return JSON.stringify(val);
  if (active.has(val)) return undefined;
  active.add(val);
  try {
    if (Array.isArray(val)) {
      return "[" + val.map((item) => canonicalSerialise(item, active) ?? "null").join(",") + "]";
    }
    const o = val as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const pairs: string[] = [];
    for (const k of keys) {
      const s = canonicalSerialise(o[k], active);
      if (s !== undefined) pairs.push(JSON.stringify(k) + ":" + s);
    }
    return "{" + pairs.join(",") + "}";
  } finally {
    active.delete(val);
  }
}
const canonicalJson = (obj: unknown): string => canonicalSerialise(obj, new Set<object>()) ?? "null";
const hashOf = (env: { seq: unknown; prevHash: unknown; ts: unknown; rec: unknown }): string =>
  createHash("sha256").update(canonicalJson({ seq: env.seq, prevHash: env.prevHash, ts: env.ts, rec: env.rec })).digest("hex");

// ── 0) קלט מהדיסק — אפס-ריקים ────────────────────────────────────────────────
for (const p of [`${LEDGER_DIR}/journal.jsonl`, `${LEDGER_DIR}/journal.meta.json`]) {
  if (!existsSync(p)) fail(`missing ${p} — the persistent ledger is not where reality lives`);
}
const meta = JSON.parse(readFileSync(`${LEDGER_DIR}/journal.meta.json`, "utf8")) as { baseSeq?: number };
if (typeof meta.baseSeq !== "number") fail("journal.meta.json has no numeric baseSeq");

let raw = readFileSync(`${LEDGER_DIR}/journal.jsonl`, "utf8");
let lines = raw.split("\n").filter((l) => l.trim().length > 0);
let parsed: { seq: number; prevHash: string; ts: string; rec: unknown; hash: string }[] = [];
let tornTail = false;
try {
  parsed = lines.map((l) => JSON.parse(l));
} catch {
  tornTail = true;
}
if (tornTail) {
  // זנב קרוע = קריעת-קריאה בזמן-כתיבה; ניסיון אחד נוסף אחרי המתנה — ואז רועש.
  await Bun.sleep(700);
  raw = readFileSync(`${LEDGER_DIR}/journal.jsonl`, "utf8");
  lines = raw.split("\n").filter((l) => l.trim().length > 0);
  try {
    parsed = lines.map((l) => JSON.parse(l));
  } catch {
    fail("journal tail is torn after retry — refusing to certify a chain we cannot fully read");
  }
}
if (parsed.length === 0) fail("journal.jsonl parsed to ZERO records — an empty chain is not evidence");

// ── 1) עיגון-snapshot והמבנה הרציף ──────────────────────────────────────────
// חוק-העיגון האמיתי (נלמד בריצה-הראשונה של המבקר הזה, 2026-10-20): אחרי
// ה-rebase של 2026-10-18 היומן מתחיל מחדש משורש GENESIS ב-baseSeq+1 — וה-
// snapshot.json הוא נקודת-קיפול מאוחרת בתוך טווח-היומן, שחייבת להיות נעוצה
// ב-(seq, head) של הרשומה באותו-seq בדיוק. שקר כאן = קיפול-מזויף.
let anchored = "no-snapshot";
const snapPath = `${LEDGER_DIR}/snapshot.json`;
if (existsSync(snapPath)) {
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { seq?: number; head?: string };
  const sSeq = snap.seq;
  const sHead = snap.head ?? "";
  if (typeof sSeq !== "number" || !sHead) fail("snapshot.json missing numeric seq/head");
  const lastJournalSeq = parsed[parsed.length - 1].seq;
  if (sSeq === meta.baseSeq) {
    if (sHead !== parsed[0].prevHash) {
      fail(`snapshot-at-base anchor mismatch: snap.head=${sHead.slice(0, 12)}… vs first-prevHash=${parsed[0].prevHash.slice(0, 12)}…`);
    }
    anchored = "base";
  } else if (sSeq > meta.baseSeq && sSeq <= lastJournalSeq) {
    const idx = sSeq - (meta.baseSeq + 1);
    if (parsed[idx].seq !== sSeq) fail(`internal index math broke: journal[${idx}].seq=${parsed[idx].seq} ≠ snapshot seq ${sSeq}`);
    if (parsed[idx].hash !== sHead) {
      fail(`fold anchor mismatch: snap.head=${sHead.slice(0, 12)}… ≠ journal hash at seq ${sSeq} = ${parsed[idx].hash.slice(0, 12)}… (folded state does not sit on this chain)`);
    }
    anchored = `fold@${sSeq}`;
  } else {
    fail(`snapshot seq ${sSeq} outside journal span [${meta.baseSeq + 1}..${lastJournalSeq}] — state and journal disagree`);
  }
}
if (parsed[0].seq !== meta.baseSeq + 1) {
  fail(`first record seq ${parsed[0].seq} ≠ baseSeq+1 (${meta.baseSeq + 1}) — chain does not sit on its anchor`);
}

// ── 2) הליכת-שרשרת מלאה: hash-מחושב-מחדש + prevHash + רצף-seq ───────────────
let prev = "";
for (let i = 0; i < parsed.length; i++) {
  const e = parsed[i];
  if (typeof e.seq !== "number" || typeof e.prevHash !== "string" || typeof e.ts !== "string" || typeof e.hash !== "string") {
    fail(`record ${i + 1}: missing core fields (seq/prevHash/ts/hash)`);
  }
  if (e.seq !== meta.baseSeq + 1 + i) fail(`record ${i + 1}: seq ${e.seq} ≠ expected ${meta.baseSeq + 1 + i} — sequence gap`);
  if (i > 0 && e.prevHash !== prev) {
    fail(`record ${i + 1}: chain break — prevHash ${e.prevHash.slice(0, 12)}… ≠ previous hash ${prev.slice(0, 12)}…`);
  }
  const computed = hashOf(e);
  if (computed !== e.hash) fail(`record ${i + 1}: hash mismatch — recomputed ${computed.slice(0, 12)}… ≠ sealed ${e.hash.slice(0, 12)}… (tampered record)`);
  prev = e.hash;
}
const lastSeq = parsed[parsed.length - 1].seq;
const lastHash = parsed[parsed.length - 1].hash;

// ── 3) צליבה מול הצומת החי — הדיסק חייב להיות בדיוק ההווה ───────────────────
const live = await fetch(`${LEDGER_URL}/health`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.json() as Promise<{ ok?: boolean; seq?: number; head?: string }>)
  .catch(() => null);
if (!live?.ok || typeof live.seq !== "number" || typeof live.head !== "string") {
  fail(`live node ${LEDGER_URL} not healthy/honest — disk says seq=${lastSeq}; refusing to certify against a stranger`);
}
if (live.seq !== lastSeq) fail(`seq divergence: disk=${lastSeq} vs live=${live.seq}`);
if (live.head !== lastHash) fail(`head divergence: disk=${lastHash.slice(0, 12)}… vs live=${live.head.slice(0, 12)}…`);

// ── 4) ראיות ────────────────────────────────────────────────────────────────
const bytes = statSync(`${LEDGER_DIR}/journal.jsonl`).size;
const evidence = {
  at: new Date().toISOString(),
  ok: true,
  baseSeq: meta.baseSeq,
  records: parsed.length,
  lastSeq,
  lastHash: lastHash.slice(0, 16),
  liveSeq: live.seq,
  liveHead: live.head.slice(0, 16),
  anchored,
  journalBytes: bytes,
};
try {
  appendFileSync(EVIDENCE, JSON.stringify(evidence) + "\n");
  const all = existsSync(EVIDENCE) ? readFileSync(EVIDENCE, "utf8").trim().split("\n") : [];
  if (all.length > MAX_EVIDENCE) {
    const keep = all.slice(-MAX_EVIDENCE).join("\n") + "\n";
    const { writeFileSync } = await import("fs");
    writeFileSync(EVIDENCE, keep);
  }
} catch { /* evidence write must not mask a pass */ }

console.log("CHAIN-AUDIT-OK — the ledger's chain is real, re-verified by an independent engine");
console.log(`chain: baseSeq=${meta.baseSeq} records=${parsed.length} lastSeq=${lastSeq} head=${lastHash.slice(0, 16)}…`);
console.log(`anchor: snapshot-${anchored} · live: seq=${live.seq} head=${live.head.slice(0, 16)}… · journal ${(bytes / 1024).toFixed(1)} KB`);
