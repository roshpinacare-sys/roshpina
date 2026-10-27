/**
 * plan-executor.ts — המבצע של הרשת: לוקח את תוכנית-הבניין של האדריכל
 * (data/build/plan.json) ומבצע אותה בפועל — לא רק מדווח עליה.
 *
 * הלולאה המלאה: סנטינל (רואה) → אדריכל (מתכנן) → בנאי (מדווח) → מבצע (עושה).
 *
 * עבור כל משימה בתוכנית שטרם בוצעה, עם action ברשימה-הלבנה
 * {content, insight, note}:
 *   1. שולח לנמוטרון (מהכספת) את פרטי-המשימה + מצב-הרשת החי, ומקבל
 *      פריט-ידע מובנה בעברית (כותרת + גוף).
 *   2. מאמת את הפלט: אורך-חוקי, אפס-סודות, אפס-הוראות-קוד-בריצה.
 *   3. כותב data/insights/<taskId>.json (פריט-ידע עם מטא-מלא) + מעדכן
 *      את data/insights/index.json (אמת-מקור) ואת עותק-האתר
 *      src/data/sovereign-insights.json (מה שמטוס-הבקרה מציג).
 *   4. רושם ב-executed.json (idempotency) — משימה מבוצעת לא חוזרת,
 *      גם-אם התוכנית נשמרת שוב.
 *
 * כנות וכשל: אין-תוכנית → exit 0 ("אין-מה-לבצע"). אין-כספת → exit 1.
 * כשל-LLM על משימה → המשימה לא מסומנת-מבוצעת (תינסה שוב), הבאות ממשיכות.
 * רץ: bun scripts/plan-executor.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";

const RUNNER_DIR = import.meta.dir.replace(/\/scripts$/, "");
const VAULT_FILE = `${RUNNER_DIR}/data/vault/nim-api.env`;
const BUILD_DIR = `${RUNNER_DIR}/data/build`;
const INSIGHTS_DIR = `${RUNNER_DIR}/data/insights`;
const MY_PROJECT = "/home/z/my-project";
const MARKET = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const RUNNER = "http://127.0.0.1:3031";

const SAFE_ACTIONS = new Set(["content", "insight", "note"]);
const SECRET_PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{10,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN/,
];
const MIN_BODY = 350; // chars — פריט-ידע אמיתי, לא צ'אט
const MAX_BODY = 4500;

// ─── vault (fail-closed) ─────────────────────────────────────────────────────

if (!existsSync(VAULT_FILE)) {
  console.error("PLAN-EXECUTOR-FAIL: vault sealed/absent — data/vault/nim-api.env לא נמצא.");
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
// Model order measured 2026-10-20 (super-120b 404 ×3; nano-omni succeeded) — see ai-architect.ts
const MODEL_PRIMARY = env.NVIDIA_MODEL_PRIMARY ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const MODEL_FALLBACK = env.NVIDIA_MODEL_FALLBACK ?? "nvidia/nemotron-3.5-lightning-30b-a3b"; // measured-alive 2026-10-21 (task 52 grill: super-120b 404-for-account ×2, lightning 200 ×1)
if (!API_KEY.startsWith("nvapi-")) {
  console.error("PLAN-EXECUTOR-FAIL: vault key invalid — fail-closed");
  process.exit(1);
}

const readJson = <T,>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

// ─── inputs: the plan + the idempotency manifest ────────────────────────────

type PlanTask = { id: string; title: string; why?: string; action: string; detail?: string };
type Plan = { generatedAt: string; model: string; mission: string; tasks: PlanTask[] };
const plan = readJson<Plan>(`${BUILD_DIR}/plan.json`);
if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
  console.log("PLAN-EXECUTOR: no live plan — nothing to execute (exit 0, honest).");
  process.exit(0);
}

type Executed = { executions: Record<string, { executedAt: string; model: string; insightFile: string }> };
const executed = readJson<Executed>(`${BUILD_DIR}/executed.json`) ?? { executions: {} };
const key = (taskId: string) => `${plan.generatedAt}::${taskId}`;

const pending = plan.tasks.filter(
  (t) => t.title && SAFE_ACTIONS.has(String(t.action)) && !executed.executions[key(t.id)]
);
console.log(
  `PLAN-EXECUTOR: plan @${plan.generatedAt} mission="${plan.mission}" — ` +
    `${plan.tasks.length} tasks, ${plan.tasks.length - pending.length} done, ${pending.length} pending`
);
if (pending.length === 0) {
  console.log("PLAN-EXECUTOR-OK: every safe task already executed — idempotent no-op.");
  process.exit(0);
}

// ─── live context (same truth the sentinel sees) ────────────────────────────

const get = async (url: string, ms = 4000): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const [marketH, ledgerH, runnerH] = await Promise.all([
  get(`${MARKET}/health`),
  get(`${LEDGER}/health`),
  get(`${RUNNER}/health`),
]);
const liveCtx = [
  `time: ${new Date().toISOString()}`,
  marketH ? `market: trades=${marketH.trades} bids=${marketH.bids} asks=${marketH.asks}` : "market: UNREACHABLE",
  ledgerH ? `ledger: seq=${ledgerH.seq} accounts=${ledgerH.accounts}` : "ledger: UNREACHABLE",
  runnerH ? `runner: jobs=${runnerH.jobsTotal} schedules=${runnerH.schedulesCount}` : "runner: UNREACHABLE",
].join("\n");

// ─── NIM call: the actual deliverable ────────────────────────────────────────

const SYSTEM = `אתה המבצע של רשת-ריבונית אוטונומית (SAOS): האדריכל נתן תוכנית, ואתה כותב את הפריט-עצמו שהרשת תפרסם במטוס-הבקרה שלה.
תפוקתך: פריט-ידע אמיתי, מדויק, בעברית ברורה, מבוסס **רק** על הנתונים החיים שלפניך ועל פרטי-המשימה. אסור להמציא מספרים שאינם לפניך.
פורמט: פסקאות פרוזה קצרות (400-900 מילים). אפשר כותרות-משנה כשורות שמתחילות ב-"## ". אין JSON, אין תיבות-קוד ריצה, אין פקודות, אין סודות.
כנות: אם חסר לך נתון — כתוב במפורש מה חסר. סיים בסעיף "## מסקנות לרשת" עם 2-4 מסקנות בנות-ביצוע.`;

const callNIM = async (model: string, task: PlanTask, maxTokens: number): Promise<string> => {
  const user = `מצב-הרשת החי:\n${liveCtx}\n\nתוכנית-הבניין (mission: ${plan.mission}):\n\nמשימה ${task.id}: ${task.title}\nלמה עכשיו: ${task.why ?? "(לא צוין)"}\nסוג: ${task.action}\nמה לכתוב: ${task.detail ?? task.title}`;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`http ${res.status} — ${(await res.text().catch(() => "")).slice(0, 140)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("empty content");
  return content;
};

const cleanBody = (raw: string): string => {
  // strip code fences & tool-call wrappers the model may add around prose
  let body = raw
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .trim();
  return body;
};

const validate = (body: string): string | null => {
  if (body.length < MIN_BODY) return `too short (${body.length} < ${MIN_BODY})`;
  if (body.length > MAX_BODY) return `too long (${body.length} > ${MAX_BODY})`;
  for (const re of SECRET_PATTERNS) if (re.test(body)) return "secret-like pattern rejected";
  if (/```/.test(body)) return "code fence rejected";
  return null;
};

// ─── execute pending tasks ───────────────────────────────────────────────────

mkdirSync(INSIGHTS_DIR, { recursive: true });
type InsightRec = {
  taskId: string;
  planGeneratedAt: string;
  title: string;
  why: string;
  action: string;
  mission: string;
  body: string;
  model: string;
  executedAt: string;
  cycle: number;
};
const published: InsightRec[] = [];
let failed = 0;

for (const task of pending.slice(0, 3)) { // cap per run: 3 — bounded, no runaway
  let body = "";
  let model = MODEL_PRIMARY;
  try {
    console.log(`PLAN-EXECUTOR: executing ${task.id} "${task.title}" (${task.action})…`);
    body = await callNIM(MODEL_PRIMARY, task, 2600);
  } catch (e) {
    console.error(`PLAN-EXECUTOR: primary failed on ${task.id} (${String(e).slice(0, 120)}) — fallback`);
    model = MODEL_FALLBACK;
    try {
      body = await callNIM(MODEL_FALLBACK, task, 1800);
    } catch (e2) {
      console.error(`PLAN-EXECUTOR: fallback also failed on ${task.id} (${String(e2).slice(0, 120)}) — task stays pending`);
      failed++;
      continue;
    }
  }

  const cleaned = cleanBody(body);
  const reject = validate(cleaned);
  if (reject) {
    console.error(`PLAN-EXECUTOR: ${task.id} rejected (${reject}) — task stays pending, not faked`);
    failed++;
    continue;
  }

  const rec: InsightRec = {
    taskId: task.id,
    planGeneratedAt: plan.generatedAt,
    title: task.title.slice(0, 120),
    why: String(task.why ?? "").slice(0, 400),
    action: task.action,
    mission: plan.mission.slice(0, 300),
    body: cleaned,
    model,
    executedAt: new Date().toISOString(),
    cycle: readJson<number>(`${BUILD_DIR}/cycle.txt`) ?? 0,
  };

  const file = `${INSIGHTS_DIR}/${task.id}.json`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, file);
  published.push(rec);
  executed.executions[key(task.id)] = { executedAt: rec.executedAt, model, insightFile: file };
  console.log(`PLAN-EXECUTOR: ${task.id} → published (${cleaned.length} chars, model=${model})`);
}

// ─── persist index + site copy + idempotency manifest ───────────────────────

if (published.length > 0) {
  // runner-authoritative index: all insights, newest first, cap 24
  const all: InsightRec[] = existsSync(`${INSIGHTS_DIR}/index.json`)
    ? readJson<InsightRec[]>(`${INSIGHTS_DIR}/index.json`) ?? []
    : [];
  const byKey = new Map<string, InsightRec>();
  for (const r of all) byKey.set(`${r.planGeneratedAt}::${r.taskId}`, r);
  for (const r of published) byKey.set(`${r.planGeneratedAt}::${r.taskId}`, r);
  const merged = [...byKey.values()].sort((a, b) => b.executedAt.localeCompare(a.executedAt)).slice(0, 24);

  const writeAtomic = (p: string, data: string) => {
    const t = `${p}.tmp`;
    writeFileSync(t, data);
    renameSync(t, p);
  };

  writeAtomic(`${INSIGHTS_DIR}/index.json`, JSON.stringify(merged, null, 2) + "\n");

  // site copy — what the control plane displays (validated, atomic)
  try {
    mkdirSync(`${MY_PROJECT}/src/data`, { recursive: true });
    writeAtomic(`${MY_PROJECT}/src/data/sovereign-insights.json`, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    console.error(`PLAN-EXECUTOR-WARN: site copy failed (${String(e).slice(0, 120)}) — runner copy authoritative`);
  }
}

const execTmp = `${BUILD_DIR}/executed.json.tmp`;
writeFileSync(execTmp, JSON.stringify(executed, null, 2) + "\n");
renameSync(execTmp, `${BUILD_DIR}/executed.json`);

if (published.length === 0) {
  console.error(`PLAN-EXECUTOR-FAIL: 0 published, ${failed} failed — nothing faked (fail-closed)`);
  process.exit(1);
}
console.log(`PLAN-EXECUTOR-OK: ${published.length} published, ${failed} pending-retry, total done=${Object.keys(executed.executions).length}`);
