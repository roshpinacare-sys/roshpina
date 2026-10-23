/**
 * code-executor.ts — מבצע-הקוד המוגן: הרשת כותבת קוד אמיתי, בגבולות-קשיחים.
 *
 * הצעד-הטבעי-הבא אחרי plan-executor (שמבצע תוכן): האדריכל יכול להציע משימות
 * action:"code" — והמבצע-הזה מבצע אותן **רק** תחת שכבות-הגנה מלאות:
 *
 *   1. רשימה-לבנה-נתיבים אסולוטית (roshpina בלבד + מסלול-אתר מבוקר אחד):
 *        agent-lab/*.ts     — מודולי-מעבדה: קוד אמיתי שאף-צומת-חי לא מייבא (אפס-רדיוס-פיצוץ)
 *        docs/**            — תיעוד
 *        broadcasts/**      — שידורי-רשת
 *        site-data://sovereign-net.json — מסלול-האתר: JSON מאומת-סכמה שמוצג חי באתר
 *          (הקובץ היחיד שהרשת רשאית לכתוב מחוץ-ל-roshpina; שער-אתר-חי בנוסף)
 *   2. סריקה-סטטית: אפס-סודות, אפס-exec/eval/spawn/fetch/child_process,
 *      אפס-ייבוא מחוץ-ל-whitelist, תקרת-גודל.
 *   3. שער-ייבוא-חי: מודול-lab חדש/ששונה חייב להיטען בהצלחה בתהליך-בן
 *      (`bun -e import`) — קוד-שנשבר לא מוכנס לגיט.
 *   4. שער-גרעין: סוויטת-הגרעין חייבת להישאר 47/47 אחרי-השינוי.
 *   5. revert-אוטומטי: כל-כישלון-שער → הקובץ חוזר-לתוכן-הקודם (או-נמחק אם-חדש)
 *      + רישום-סירוב-כן ביומן. אף-שער-לא-מדולג. לא-מזויף.
 *   6. יומן-ראיות: data/ai/code-executions.jsonl — append-only, כל-ניסיון.
 *   7. idempotency: executed.json (אותו-מפתח כמו plan-executor).
 *   8. תקרה: 2 משימות-קוד לריצה.
 *
 * רץ: bun scripts/code-executor.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join, posix as posixPath } from "path";

const RUNNER_DIR = import.meta.dir.replace(/\/scripts$/, "");
const BUILD_DIR = `${RUNNER_DIR}/data/build`;
const AI_DIR = `${RUNNER_DIR}/data/ai`;
const EVIDENCE = `${AI_DIR}/code-executions.jsonl`;
const ROSHPINA = "/home/z/repos/roshpina";
const LAB_DIR = `${ROSHPINA}/agent-lab`;

// ─── hard whitelist — nothing outside these prefixes is ever touched ─────────

const WHITELIST: { prefix: string; kind: "lab-ts" | "doc" | "broadcast" }[] = [
  { prefix: "agent-lab/", kind: "lab-ts" },
  { prefix: "docs/", kind: "doc" },
  { prefix: "broadcasts/", kind: "broadcast" },
];

// ─── the site lane — one fixed, schema-validated file on the live site ───────

const SITE_NET_DATA = "/home/z/my-project/src/data/sovereign-net.json";
const SITE_NET_URL = "http://localhost:3000/api/net-data";

const SITE_KINDS = new Set(["broadcast", "note", "milestone", "commitment"]);
const SECRET_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /BEGIN [A-Z ]*PRIVATE KEY|-----BEGIN/, why: "private-key-like material" },
  { re: /nvapi-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}/, why: "secret-like token" },
];

/** Strict schema validation for the site lane — the site renders whatever passes this. */
const validateSiteNet = (raw: string): { items: SiteNetItem[] } | { error: string } => {
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) return { error: "site payload too large (>16KB)" };
  for (const s of SECRET_PATTERNS) if (s.re.test(raw)) return { error: `forbidden pattern: ${s.why}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "site payload is not valid JSON" };
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    return { error: "site payload must contain items[1..20]" };
  }
  for (const it of items) {
    const o = it as Record<string, unknown>;
    const id = String(o.id ?? "");
    const title = String(o.title ?? "");
    const body = String(o.body ?? "");
    const kind = String(o.kind ?? "");
    const createdAt = String(o.createdAt ?? "");
    if (!id || id.length > 40) return { error: "item.id required (≤40 chars)" };
    if (title.length < 5 || title.length > 160) return { error: "item.title must be 5..160 chars" };
    if (body.length < 50 || body.length > 4000) return { error: "item.body must be 50..4000 chars" };
    if (!SITE_KINDS.has(kind)) return { error: `item.kind must be one of ${[...SITE_KINDS].join("/")}` };
    if (Number.isNaN(Date.parse(createdAt))) return { error: "item.createdAt must be a valid date" };
  }
  return { items: items as SiteNetItem[] };
};

type SiteNetItem = { id: string; title: string; body: string; kind: string; createdAt: string };

/** Live site gate: the running site itself must serve the new payload — evidence, not hope. */
const siteGate = async (expectedCount: number): Promise<string | null> => {
  try {
    const res = await fetch(SITE_NET_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return `site gate failed: /api/net-data HTTP ${res.status}`;
    const body = (await res.json()) as { items?: { id: string }[] };
    if (!Array.isArray(body.items) || body.items.length !== expectedCount) {
      return `site gate failed: served ${body.items?.length ?? 0} items, expected ${expectedCount}`;
    }
    return null;
  } catch (e) {
    return `site gate failed: ${String(e).slice(0, 120)}`;
  }
};

const FORBIDDEN_CONTENT: { re: RegExp; why: string }[] = [
  { re: /BEGIN [A-Z ]*PRIVATE KEY|-----BEGIN/, why: "private-key-like material" },
  { re: /nvapi-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}/, why: "secret-like token" },
  { re: /\beval\s*\(|new\s+Function\s*\(/, why: "dynamic code execution" },
  { re: /child_process|Bun\.spawn|node:child_process/, why: "process spawning" },
  { re: /\bfetch\s*\(|WebSocket|XMLHttpRequest/, why: "network calls are not allowed in lab modules" },
  { re: /process\.exit|process\.kill/, why: "process lifecycle manipulation" },
  { re: /rm\s+-rf|writeFileSync\([^)]*\.\.\//, why: "destructive path patterns" },
];

const MAX_FILE_BYTES = 24 * 1024;

const readJson = <T,>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

type PlanTask = { id: string; title: string; why?: string; action: string; detail?: string; path?: string; content?: string };
type Plan = { generatedAt: string; model: string; mission: string; tasks: PlanTask[] };

const plan = readJson<Plan>(`${BUILD_DIR}/plan.json`);
if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
  console.log("CODE-EXECUTOR: no live plan — nothing to execute (exit 0, honest).");
  process.exit(0);
}

type Executed = { executions: Record<string, { executedAt: string; result: string; file: string }> };
const executed = readJson<Executed>(`${BUILD_DIR}/executed.json`) ?? { executions: {} };
const key = (taskId: string) => `${plan.generatedAt}::${taskId}`;

type CodeTask = PlanTask & { path: string };
const codeTasks = plan.tasks.filter(
  (t): t is CodeTask => t.action === "code" && typeof t.path === "string" && !executed.executions[key(t.id)]
);

console.log(
  `CODE-EXECUTOR: plan @${plan.generatedAt} mission="${plan.mission}" — ` +
    `${plan.tasks.length} tasks, ${codeTasks.length} code tasks pending`
);
if (codeTasks.length === 0) {
  console.log("CODE-EXECUTOR-OK: no pending code tasks (exit 0, honest).");
  process.exit(0);
}

// ─── evidence journal (append-only) ──────────────────────────────────────────

mkdirSync(AI_DIR, { recursive: true });
const journal = (rec: Record<string, unknown>): void => {
  appendFileSync(EVIDENCE, JSON.stringify({ ts: new Date().toISOString(), plan: plan.generatedAt, ...rec }) + "\n");
};

// ─── gates ───────────────────────────────────────────────────────────────────

const resolveWhitelisted = (rel: string): { abs: string; kind: string } | { error: string } => {
  // the site lane — exact fixed target only, no sub-paths, no negotiation
  if (rel === "site-data://sovereign-net.json") return { abs: SITE_NET_DATA, kind: "site-json" };
  if (rel.startsWith("site-data://")) return { error: "site lane has exactly one writable target: site-data://sovereign-net.json" };
  const clean = posixPath.normalize(rel.replace(/\\/g, "/")).replace(/^\.?\//, "");
  if (clean.includes("..") || posixPath.isAbsolute(clean)) return { error: "path traversal refused" };
  const hit = WHITELIST.find((w) => clean === w.prefix.replace(/\/$/, "") || clean.startsWith(w.prefix));
  if (!hit) return { error: `path "${clean}" is outside the code whitelist [${WHITELIST.map((w) => w.prefix).join(", ")}, site-data://sovereign-net.json]` };
  if (hit.kind === "lab-ts" && !clean.endsWith(".ts")) return { error: "agent-lab files must be .ts" };
  if ((hit.kind === "doc" || hit.kind === "broadcast") && !/\.(md|json|txt)$/.test(clean)) return { error: "docs/broadcasts must be .md/.json/.txt" };
  return { abs: join(ROSHPINA, clean), kind: hit.kind };
};

const scanContent = (content: string, kind: string): string | null => {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return `file too large (${Buffer.byteLength(content)} > ${MAX_FILE_BYTES})`;
  if (content.length < 40) return "content too short to be a real deliverable";
  if (kind === "lab-ts") {
    for (const f of FORBIDDEN_CONTENT) if (f.re.test(content)) return `forbidden pattern: ${f.why}`;
  }
  return null;
};

/** Live import gate for lab modules: a fresh child process must import cleanly. */
const importGate = (relPath: string): string | null => {
  const probe = `const m = await import("/home/z/repos/roshpina/${relPath}"); if (!m || typeof m !== "object") { console.error("IMPORT-GATE-FAIL: module shape"); process.exit(1); } console.log("IMPORT-GATE-OK");`;
  const proc = Bun.spawnSync(["bun", "-e", probe], { cwd: ROSHPINA, stdout: "pipe", stderr: "pipe" });
  const err = new TextDecoder().decode(proc.stderr).slice(0, 300);
  if (proc.exitCode !== 0) return `import gate failed (exit ${proc.exitCode}): ${err}`;
  return null;
};

/** Kernel suite must stay green after ANY accepted change. */
const kernelGate = (): { ok: boolean; detail: string } => {
  const proc = Bun.spawnSync(["bun", "test", "kernel/"], { cwd: ROSHPINA, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  const m = out.match(/(\d+) pass/);
  return { ok: proc.exitCode === 0, detail: proc.exitCode === 0 ? `${m?.[1] ?? "?"} pass` : out.slice(0, 200) };
};

// ─── execute pending code tasks (cap 2) ──────────────────────────────────────

let accepted = 0;
let refused = 0;

/** Permanent refusals (whitelist/content) are marked resolved — they will
 *  NEVER succeed by retrying; retrying would waste runs forever. Transient
 *  failures (import/kernel gate after a real write) stay pending for retry. */
const markPermanentRefusal = (taskId: string, rel: string, reason: string): void => {
  executed.executions[key(taskId)] = { executedAt: new Date().toISOString(), result: `refused: ${reason.slice(0, 120)}`, file: rel };
};

for (const task of codeTasks.slice(0, 2)) {
  const rel = String(task.path);
  console.log(`CODE-EXECUTOR: task ${task.id} → ${rel} "${task.title}"`);
  journal({ taskId: task.id, path: rel, phase: "attempt", title: task.title.slice(0, 120) });

  // gate 1: path whitelist (permanent refusal — never becomes allowed)
  const target = resolveWhitelisted(rel);
  if ("error" in target) {
    console.error(`CODE-EXECUTOR: ${task.id} REFUSED — ${target.error}`);
    journal({ taskId: task.id, path: rel, phase: "refused", reason: target.error });
    markPermanentRefusal(task.id, rel, target.error);
    refused++;
    continue;
  }

  // gate 2: content — explicit content field wins; otherwise the task detail IS the content (docs)
  const content = typeof task.content === "string" && task.content.trim().length > 0 ? task.content : `${task.detail ?? ""}`;
  // site lane: schema gate replaces the generic content scan (JSON, not code)
  if (target.kind === "site-json") {
    const verdict = validateSiteNet(content);
    if ("error" in verdict) {
      console.error(`CODE-EXECUTOR: ${task.id} REFUSED — site schema: ${verdict.error}`);
      journal({ taskId: task.id, path: rel, phase: "refused", reason: `site-schema: ${verdict.error}` });
      markPermanentRefusal(task.id, rel, `site-schema: ${verdict.error}`);
      refused++;
      continue;
    }
  } else {
    const contentReject = scanContent(content, target.kind);
    if (contentReject) {
      console.error(`CODE-EXECUTOR: ${task.id} REFUSED — ${contentReject}`);
      journal({ taskId: task.id, path: rel, phase: "refused", reason: contentReject });
      markPermanentRefusal(task.id, rel, contentReject);
      refused++;
      continue;
    }
  }

  // snapshot for honest revert
  const existed = existsSync(target.abs);
  const before = existed ? readFileSync(target.abs, "utf8") : null;

  // apply
  try {
    mkdirSync(join(target.abs, ".."), { recursive: true });
    const tmp = `${target.abs}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, target.abs);
  } catch (e) {
    console.error(`CODE-EXECUTOR: ${task.id} REFUSED — write failed: ${String(e).slice(0, 120)}`);
    journal({ taskId: task.id, path: rel, phase: "refused", reason: "write-failed" });
    refused++;
    continue;
  }

  // gate 3: live verification per lane — lab: import in a child; site: the live site must serve it
  if (target.kind === "lab-ts") {
    const importFail = importGate(rel);
    if (importFail) {
      if (before === null) rmSync(target.abs, { force: true });
      else writeFileSync(target.abs, before);
      console.error(`CODE-EXECUTOR: ${task.id} REVERTED — ${importFail}`);
      journal({ taskId: task.id, path: rel, phase: "reverted", reason: importFail });
      refused++;
      continue;
    }
  }

  if (target.kind === "site-json") {
    const verdict = validateSiteNet(content);
    const expected = "items" in verdict ? verdict.items.length : 0;
    const siteFail = await siteGate(expected);
    if (siteFail) {
      if (before === null) rmSync(target.abs, { force: true });
      else writeFileSync(target.abs, before);
      console.error(`CODE-EXECUTOR: ${task.id} REVERTED — ${siteFail}`);
      journal({ taskId: task.id, path: rel, phase: "reverted", reason: siteFail });
      refused++;
      continue;
    }
  }

  // gate 4: the kernel suite is the invariant of the whole repo (site lane is kernel-untouched)
  let gateDetail = "site-gate ok (kernel untouched)";
  if (target.kind !== "site-json") {
    const kg = kernelGate();
    gateDetail = `kernel ${kg.detail}`;
    if (!kg.ok) {
      if (before === null) rmSync(target.abs, { force: true });
      else writeFileSync(target.abs, before);
      console.error(`CODE-EXECUTOR: ${task.id} REVERTED — kernel gate: ${kg.detail}`);
      journal({ taskId: task.id, path: rel, phase: "reverted", reason: `kernel-gate: ${kg.detail}` });
      refused++;
      continue;
    }
  }

  // accepted — mark executed
  accepted++;
  executed.executions[key(task.id)] = { executedAt: new Date().toISOString(), result: "accepted", file: rel };
  journal({ taskId: task.id, path: rel, phase: "accepted", bytes: Buffer.byteLength(content), gate: gateDetail });
  console.log(`CODE-EXECUTOR: ${task.id} → ACCEPTED (${Buffer.byteLength(content)}B, ${gateDetail})`);
}

// persist idempotency manifest
const execTmp = `${BUILD_DIR}/executed.json.tmp`;
writeFileSync(execTmp, JSON.stringify(executed, null, 2) + "\n");
renameSync(execTmp, `${BUILD_DIR}/executed.json`);

if (accepted === 0) {
  console.error(`CODE-EXECUTOR-FAIL: 0 accepted, ${refused} refused/reverted — nothing faked (fail-closed)`);
  process.exit(1);
}
console.log(`CODE-EXECUTOR-OK: ${accepted} accepted, ${refused} refused/reverted`);
