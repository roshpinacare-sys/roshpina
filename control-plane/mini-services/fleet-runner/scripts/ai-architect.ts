/**
 * ai-architect.ts — האדריכל של הרשת: מתכנן בנייה אמיתית, לא רק בודק.
 *
 * מגייס את המצב החי (צמתים, תזמונים, כישלונות אחרונים מהיומן, התוכנית הקודמת,
 * הדוח האחרון), שולח לנמוטרון ומקבל תוכנית-בניין מובנית: 3-5 משימות בנייה
 * ממוקדות שהרשת יכולה לבצע בעצמה בבטחה (תוכן, ניתוחים, שיפורי-איכות, תיעוד).
 *
 * חוקי-הבטיחות: התוכנית רק מפעולות-ביצוע-בטוחות (content/insight/note) —
 * שינויי-קוד וכסף לעולם לא מבוצעים אוטונומית בלי-אישור-מפעיל. JSON לא-תקין
 * → exit 1 (לא מדמים תוכנית).
 * רץ: bun scripts/ai-architect.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";

const RUNNER_DIR = import.meta.dir.replace(/\/scripts$/, "");
const VAULT_FILE = `${RUNNER_DIR}/data/vault/nim-api.env`;
const BUILD_DIR = `${RUNNER_DIR}/data/build`;
const MARKET = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const RUNNER = "http://127.0.0.1:3031";

// ─── vault (fail-closed) ─────────────────────────────────────────────────────

if (!existsSync(VAULT_FILE)) {
  console.error("AI-ARCHITECT-FAIL: vault sealed/absent — data/vault/nim-api.env לא נמצא.");
  console.error("  שחזור: bash scripts/vault-unseal.sh nim-api.env");
  process.exit(1);
}
const env: Record<string, string> = {};
for (const line of readFileSync(VAULT_FILE, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const API_KEY = env.NVIDIA_API_KEY ?? "";
const BASE = env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
// Model order from measured evidence 2026-10-20T14:57–16:57: super-120b 404'd 3×
// consecutively ("Function not found for account"), nano-omni succeeded 17:58.
// nano first; super kept as fallback in case NVIDIA restores the function.
const MODEL_PRIMARY = env.NVIDIA_MODEL_PRIMARY ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const MODEL_FALLBACK = env.NVIDIA_MODEL_FALLBACK ?? "nvidia/nemotron-3.5-lightning-30b-a3b"; // measured-alive 2026-10-21 (task 52 grill: super-120b 404-for-account ×2, lightning 200 ×1)
if (!API_KEY.startsWith("nvapi-")) {
  console.error("AI-ARCHITECT-FAIL: vault key invalid — fail-closed");
  process.exit(1);
}

const get = async (url: string, ms = 4000): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const readJson = <T,>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

// ─── live state ──────────────────────────────────────────────────────────────

console.log("AI-ARCHITECT: gathering live state…");
const [marketH, econ, ledgerH, runnerH, schedulesRes] = await Promise.all([
  get(`${MARKET}/health`),
  get(`${MARKET}/economy/report`),
  get(`${LEDGER}/health`),
  get(`${RUNNER}/health`),
  get(`${RUNNER}/schedules`),
]);

const stateLines: string[] = [`time: ${new Date().toISOString()}`];
stateLines.push(marketH ? `market: trades=${marketH.trades} bids=${marketH.bids} asks=${marketH.asks}` : "market: UNREACHABLE");
stateLines.push(ledgerH ? `ledger: seq=${ledgerH.seq} accounts=${ledgerH.accounts}` : "ledger: UNREACHABLE");
if (runnerH) {
  const wd = runnerH.watchdog as { healCount?: number } | undefined;
  stateLines.push(`runner: jobs=${runnerH.jobsTotal} schedules=${runnerH.schedulesCount} tick=${runnerH.tickCount} heals=${wd?.healCount ?? "?"}`);
} else stateLines.push("runner: UNREACHABLE");
type SchedRow = { presetId: string; intervalSec: number; enabled: boolean; runCount: number; failCount: number; lastStatus: string };
for (const s of ((schedulesRes?.schedules as SchedRow[]) ?? [])) {
  stateLines.push(`  schedule ${s.presetId}/${s.intervalSec}s: runs=${s.runCount} fails=${s.failCount} last=${s.lastStatus}${s.enabled ? "" : " DISABLED"}`);
}
if (econ) {
  const agents = (econ.agents as { agentId: string; fills: number }[]) ?? [];
  stateLines.push(`economy: agents=${agents.length} fills=${agents.map((a) => `${a.agentId}:${a.fills}`).join(",")}`);
}

// recent failures from the evidence journal (honest pain, not assumptions)
const jobsFile = `${RUNNER_DIR}/data/jobs.jsonl`;
const failures: string[] = [];
if (existsSync(jobsFile)) {
  const lines = readFileSync(jobsFile, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0 && failures.length < 8; i--) {
    let j: { phase?: string; kind?: string; preset?: string; status?: string; startedAt?: string };
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if ((j.phase ?? j.kind) === "end" && j.status && j.status !== "succeeded") {
      failures.push(`${j.preset}: ${j.status} @${String(j.startedAt).slice(11, 19)}`);
    }
  }
}
stateLines.push(`recent failures (evidence): ${failures.length ? failures.join(" · ") : "none"}`);

const prevPlan = readJson<{ generatedAt?: string; tasks?: { id: string; title: string; action: string }[] }>(`${BUILD_DIR}/plan.json`);
if (prevPlan) stateLines.push(`previous plan (${prevPlan.generatedAt}): ${(prevPlan.tasks ?? []).map((t) => `${t.id}=${t.title}`).join(" · ")}`);
const prevReport = readJson<{ builtAt?: string; cycle?: number }>(`${BUILD_DIR}/night-report.json`);
if (prevReport) stateLines.push(`last site build: cycle=${prevReport.cycle} @${prevReport.builtAt}`);
// site lane (Task 20): has the network ever published to its own site?
// A broadcast older than 2h is STALE — the architect is told honestly, so the
// site never lies by showing old "live" facts as if they were current.
const SITE_DATA = "/home/z/my-project/src/data/sovereign-net.json";
if (existsSync(SITE_DATA)) {
  const ageH = (Date.now() - statSync(SITE_DATA).mtimeMs) / 3_600_000;
  stateLines.push(ageH > 2
    ? `site lane: sovereign-net.json is STALE (${ageH.toFixed(1)}h old) — prefer exactly one action:"code" task with path site-data://sovereign-net.json this round, refreshing it with the real live facts below`
    : "site lane: sovereign-net.json published recently — refresh only when there is real news");
} else {
  stateLines.push("site lane: NEVER published — prefer exactly one action:\"code\" task with path site-data://sovereign-net.json this round (a real broadcast from the live state below)");
}

const state = stateLines.join("\n");
console.log("--- state ---\n" + state + "\n-------------");

// ─── NIM call: a structured BUILD PLAN ───────────────────────────────────────

const SYSTEM = `אתה האדריכל של רשת-ריבונית אוטונומית (SAOS). הרשת: סוכנים חתומים סוחרים בשוק פנימי, ספר-מתמיד, כלכלה (מיסים/שכר/סטייקינג), מתזמן עצמי, גיבויים עצמיים לגיט, סנטינל-AI, ומטוס-בקרה בעברית.
תפקידך: לתכנן את סבב-הבנייה הבא — משימות שהרשת תבצע בעצמה כדי שהמוצר ישתפר ויתעדכן כל-הזמן, ולא רק יבדוק את עצמו.
כללי-בטיחות אבסולוטיים: מותר רק action מהרשימה: "content" (תוכן אמיתי לאתר), "insight" (ניתוח/מסקנה), "note" (תיעוד), "code" (כתיבת-קוד מוגנת — רק בתוך agent-lab/, docs/ או broadcasts/ בריפו roshpina, או מסלול-האתר הקבוע site-data://sovereign-net.json; לעולם לא kernel/, serve.ts, market-serve.ts, scripts/ או כל-קוד-תשתית).
אם בחרת action:"code" חובה לציין גם:
  - "path": נתיב-יחסי בתוך-הרשימה-הלבנה (לדוגמה: "agent-lab/market-notes.ts" או "docs/2026-10-18-era-notes.md"), או בדיוק "site-data://sovereign-net.json" כדי לפרסם שידור-רשת ישירות-לאתר.
  - "content": התוכן המלא של הקובץ. בקובצי .ts ב-agent-lab: מודול טהור — export בלבד, ללא fetch, ללא spawn, ללא eval, ללא סודות, עד 24KB. הקוד יעבור שער-ייבוא-חי ושער-גרעין; קוד-שנשבר יוחזר-אוטומטית.
  - מסלול-האתר site-data://sovereign-net.json: "content" חייב להיות JSON תקין במבנה המדויק: {"items":[{"id":"מזהה-קצר","title":"כותרת 5..160 תווים בעברית","body":"גוף 50..4000 תווים בעברית — מידע אמיתי מהמצב-החי, ללא סודות","kind":"broadcast|note|milestone|commitment","createdAt":"תאריך-ISO"}]} — 1..20 פריטים. הפריטים יוצגו חי באתר תחת "שידורי-הרשת". הפרסום עובר שער-אתר-חי; פלט-שבור יוחזר-אוטומטית. כתוב רק עובדות מהנתונים שלפניך (עסקאות, ספר, תזמונים, תוכניות) — אסור להמציא.
הרשת מבצעת אוטונומית רק את הרשימה — כל-חריגה נדחה בכנות.
אם המצב-החי אומר לך שמסלול-האתר מעולם לא פורסם — העדף בסבב זה בדיוק משימת-קוד אחת לנתיב site-data://sovereign-net.json (שידור-רשת חי לאתר, מהעובדות שלפניך בלבד).
ענה **ב-JSON תקין בלבד** (בלי-טקסט מסביב), במבנה:
{"mission":"משפט אחד — המטרה של הסבב","tasks":[{"id":"t1","title":"כותרת קצרה בעברית","why":"למה זה חשוב עכשיו (מהנתונים)","action":"content|insight|note|code","detail":"מה בדיוק לבנות/לכתוב","path":"חובה-רק-ל-code","content":"חובה-רק-ל-code"}],"risks":["סיכון או חוסר בנתונים אם יש"]}
3-5 משימות, כל-אחת קונקרטית וברת-ביצוע עכשיו. לכל-היותר משימת-קוד אחת בסבב. אל תמציא נתונים שאינם לפניך; UNREACHABLE = ממצא.`;

const callNIM = async (model: string, maxTokens: number): Promise<string> => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `מצב-הרשת החי עכשיו:\n\n${state}` },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`http ${res.status} — ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("empty content");
  return content;
};

// Balanced-scan extraction v2 (candidate scan) — measured failure 2026-10-21T02:19:
// the nano reasoning model emits prose BEFORE the JSON, and prose may contain
// its own brace chatter, so the FIRST "{" is not necessarily the plan's; the
// output may also be truncated mid-JSON (max_tokens) or trailed by prose.
// Strategy: try every "{" as a candidate start; for each, find the EXACT span
// of the first balanced object (skipping prose before/after); prefer the first
// candidate that parses to plan shape (mission+tasks); fall back to the first
// that merely parses; if the span runs off the end (truncation) close it and
// flag repaired:true so the record stays honest. No fabrication anywhere.
const looksLikePlan = (v: unknown): v is { mission: unknown; tasks: unknown } =>
  typeof v === "object" && v !== null &&
  typeof (v as Record<string, unknown>).mission === "string" &&
  Array.isArray((v as Record<string, unknown>).tasks);

const extractJsonAttempt = (raw: string): { value: unknown; repaired: boolean } => {
  const opens: number[] = [];
  for (let i = raw.indexOf("{"); i >= 0; i = raw.indexOf("{", i + 1)) opens.push(i);
  if (opens.length === 0) throw new Error("no JSON object in model output");

  // scan tracks the OPEN STACK (not counters) — closing a truncated object must
  // reverse the real nesting order ('}' for '{', ']' for '['); batch-appending
  // counters produced ]}} for }]  (golden-caught 2026-10-21).
  const scan = (s: string, from: number): { end: number; stack: string[]; inStr: boolean } => {
    const stack: string[] = [];
    let inStr = false, esc = false;
    for (let i = from; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") inStr = true;
      else if (ch === "{") stack.push("{");
      else if (ch === "[") stack.push("[");
      else if (ch === "}") { if (stack[stack.length - 1] === "{") stack.pop(); }
      else if (ch === "]") { if (stack[stack.length - 1] === "[") stack.pop(); }
      if (stack.length === 0 && !inStr && i > from) return { end: i, stack, inStr: false };
    }
    return { end: s.length, stack, inStr };
  };

  let fallback: { value: unknown; repaired: boolean } | null = null;
  let lastErr = "no candidate parsed";
  for (const start of opens) {
    const { end, stack, inStr } = scan(raw, start);
    if (stack.length === 0 && !inStr && end < raw.length) {
      // exact balanced span (prose before/after tolerated)
      try {
        const v = JSON.parse(raw.slice(start, end + 1)) as unknown;
        if (looksLikePlan(v)) return { value: v, repaired: false };
        if (!fallback) fallback = { value: v, repaired: false };
        continue;
      } catch (e) { lastErr = String(e).slice(0, 160); }
    }
    // truncated mid-object: close in REVERSE nesting order
    let repair = raw.slice(start, end);
    if (inStr) repair += "\"";
    repair = repair.replace(/,\s*$/, ""); // trailing comma before implicit close
    repair += [...scan(repair, 0).stack].reverse().map((c) => (c === "{" ? "}" : "]")).join("");
    try {
      const v = JSON.parse(repair) as unknown;
      if (looksLikePlan(v)) return { value: v, repaired: true };
      if (!fallback) fallback = { value: v, repaired: true };
    } catch (e) { lastErr = String(e).slice(0, 160); }
  }
  if (fallback) return fallback;
  throw new Error(lastErr);
};

// Ladder: primary → primary with a higher token-cap (reasoning models burn
// budget on thinking — truncation is the root cause of broken JSON) → fallback.
// HTTP/network failures of every attempt still exit 1 (real infra failure).
type Attempt = { model: string; maxTokens: number; label: string };
const attempts: Attempt[] = [
  { model: MODEL_PRIMARY, maxTokens: 3200, label: "primary" },
  { model: MODEL_PRIMARY, maxTokens: 4600, label: "primary+higher-cap" },
  { model: MODEL_FALLBACK, maxTokens: 3200, label: "fallback" },
];
let raw = "";
let model = "";
let repaired = false;
let gotContent = false;
let lastErr = "";
let parsed: {
  mission?: string;
  tasks?: { id?: string; title?: string; why?: string; action?: string; detail?: string; path?: string; content?: string }[];
  risks?: string[];
} | null = null;
for (const a of attempts) {
  try {
    console.log(`AI-ARCHITECT: calling NVIDIA NIM (${a.model}, cap=${a.maxTokens}, ${a.label})…`);
    raw = await callNIM(a.model, a.maxTokens);
    gotContent = true;
    const r = extractJsonAttempt(raw);
    parsed = r.value as NonNullable<typeof parsed>;
    model = a.model;
    repaired = r.repaired;
    if (repaired) console.warn("AI-ARCHITECT: model output was truncated mid-JSON — closed and parsed; flagged honestly in the plan record");
    break;
  } catch (e) {
    lastErr = String(e).slice(0, 200);
    console.error(`AI-ARCHITECT: ${a.label} attempt failed — ${lastErr}`);
  }
}
if (!parsed) {
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(`${BUILD_DIR}/plan-skip.json`, JSON.stringify({ at: new Date().toISOString(), gotContent, lastErr, rawSample: raw.slice(0, 800) }, null, 2) + "\n");
  console.error(gotContent
    ? "AI-ARCHITECT-FAIL: all 3 attempts returned malformed JSON (evidence: data/build/plan-skip.json) — previous plan retained, nothing faked"
    : `AI-ARCHITECT-FAIL: all attempts failed (${lastErr}) — fail-closed`);
  process.exit(1);
}

const allowedActions = new Set(["content", "insight", "note", "code"]);
const tasks = (parsed.tasks ?? [])
  .filter((t) => t.title && allowedActions.has(String(t.action)))
  .filter((t) => t.action !== "code" || (typeof t.path === "string" && t.path.length > 0)) // code needs a path
  .slice(0, 5)
  .map((t, i) => ({
    id: String(t.id ?? `t${i + 1}`).slice(0, 24),
    title: String(t.title).slice(0, 120),
    why: String(t.why ?? "").slice(0, 400),
    action: String(t.action),
    detail: String(t.detail ?? "").slice(0, 600),
    path: t.action === "code" ? String(t.path).slice(0, 200) : undefined,
    content: t.action === "code" && typeof t.content === "string" ? t.content.slice(0, 24_000) : undefined,
  }));
if (!parsed.mission || tasks.length === 0) {
  console.error("AI-ARCHITECT-FAIL: plan rejected — no mission or no safe tasks (fail-closed, not faking)");
  console.error(raw.slice(0, 500));
  process.exit(1);
}

const planRecord = {
  generatedAt: new Date().toISOString(),
  model,
  jsonRepaired: repaired,
  mission: String(parsed.mission).slice(0, 300),
  tasks,
  risks: (parsed.risks ?? []).slice(0, 4).map((r) => String(r).slice(0, 240)),
  stateSnapshot: state.slice(0, 3000),
};
mkdirSync(BUILD_DIR, { recursive: true });
const tmp = `${BUILD_DIR}/plan.json.tmp`;
writeFileSync(tmp, JSON.stringify(planRecord, null, 2) + "\n");
renameSync(tmp, `${BUILD_DIR}/plan.json`);

console.log(`AI-ARCHITECT-OK: model=${model} mission="${planRecord.mission}"`);
for (const t of tasks) console.log(`  [${t.action}] ${t.id}: ${t.title}`);
console.log("AI-ARCHITECT: plan saved → data/build/plan.json");
