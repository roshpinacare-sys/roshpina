/**
 * org-census.ts — מפקד-חיות שעתי על כל הגיט (40 ריפואים ב-org).
 *
 * מדידה-אמת מול GitHub API (לא טענות): לכל ריפו — אילו workflows קיימים,
 * מתי הריצה-המתוכננת (event=schedule) האחרונה הייתה, ומה מצב ה-workflow.
 * פסקי-דין: ALIVE / STARVED / IDLE.
 *
 * ריפו STARVED = יש לו workflows מתוכננים אבל הריצה-המתוכננת האחרונה זקנה
 * (או שה-workflow הושתק בשקט ע"י GitHub — disabled_inactivity). תרופת-שורש:
 * enable (הסיבה-האמיתית להשתקות) ואז dispatch (קבלה) — בסדר הזה, תמיד.
 *
 * הגנות-עצמי (הלקח מהלייבלוק שתוקן 2026-10-22):
 *  - cooldown על-פעולה-עצמית: מדוד מתי *אני* חילצתי את ${repo}/${wf} בפעם
 *    האחרונה (state בדיסק), לא את הרעש של אחרים סביבי. שעות-6.
 *  - enable לפני dispatch — אחרת ה-dispatch מת על 409/422 והחילוץ שקר.
 *  - fail-closed: exit 1 כל-עוד קיים ריפו STARVED (הלוח מסמן כישלון עד-שמתרפא).
 *  - §11: backoff מעריכי-עם-jitter על כל קריאת רשת; אפס-תלות-חיצונית.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

const ORG = "roshpinacare-sys";
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? "/home/z/my-project/upload/pat.env";
const AI_DIR = join(import.meta.dir, "..", "data", "ai");
const OUT_JSON = join(AI_DIR, "org-census.json");
const RESCUE_STATE = join(AI_DIR, "org-census-rescues.json");

const STALE_H = 6; // ריצה-מתוכננת אחרונה ישנה מזה → STARVED
const RESCUE_COOLDOWN_H = 6; // אל-תחלץ את אותו repo/wf יותר מדי-תכופות
const MAX_REPOS = 60; // גבול-בטיחות על גודל ה-org
const POOL = 5; // בריכה-מקבילה קטנה — מנומס מול ה-API

type RescueState = Record<string, string>; // `${repo}/${wf}` → ISO

// ─── §11: backoff מעריכי עם jitter ───────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithBackoff(url: string, init: RequestInit, what: string): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      // כבוד למגבלת-קצב אם היא מדווחת
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0" && !res.ok) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
        const waitMs = Math.max(1_000, Math.min(30_000, reset - Date.now()));
        console.log(`[org-census] rate-limited on ${what} — waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0") * 1000;
        const backoff = retryAfter || 500 * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(Math.min(backoff, 8_000));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(Math.min(backoff, 8_000));
    }
  }
  throw new Error(`${what}: exhausted after 4 attempts (last: ${String(lastErr).slice(0, 120)})`);
}

// ─── PAT: נקרא, לעולם לא נודפס ───────────────────────────────────────────────
function readToken(): string {
  if (!existsSync(TOKEN_FILE)) throw new Error(`PAT file missing: ${TOKEN_FILE}`);
  const m = readFileSync(TOKEN_FILE, "utf8").match(/gh[pousr]_[A-Za-z0-9_]+/);
  if (!m) throw new Error("no gh token found in PAT file");
  return m[0];
}

function apiHeaders(token: string): HeadersInit {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "saos-org-census",
  };
}

// ─── עזרי-מדידה ──────────────────────────────────────────────────────────────
function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function loadRescueState(): RescueState {
  try {
    if (!existsSync(RESCUE_STATE)) return {};
    return JSON.parse(readFileSync(RESCUE_STATE, "utf8")) as RescueState;
  } catch {
    return {};
  }
}

function saveRescueState(state: RescueState): void {
  const tmp = `${RESCUE_STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, RESCUE_STATE); // אטומי
}

// ─── טיפוסים ─────────────────────────────────────────────────────────────────
type RepoCensus = {
  repo: string;
  defaultBranch: string;
  workflows: number;
  scheduledWorkflows: number;
  lastScheduledRunAt: string | null;
  lastAnyRunAt: string | null;
  hoursSinceScheduled: number | null;
  verdict: "ALIVE" | "STARVED" | "IDLE";
  rescueDispatched: string[]; // `${wf}` שחולצו המחזור הזה
  skippedByCooldown: string[];
  note?: string;
};

type Workflow = { id: number; name: string; path: string; state: string };

async function ghJson<T>(token: string, path: string, what: string): Promise<T> {
  const res = await fetchWithBackoff(`https://api.github.com${path}`, { headers: apiHeaders(token) }, what);
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function rescueWorkflow(
  token: string,
  repo: string,
  wf: Workflow,
  branch: string,
  rescueState: RescueState,
  r: RepoCensus,
): Promise<void> {
  const key = `${repo}/${wf.path}`;
  const ownAge = hoursSince(rescueState[key]);
  if (ownAge !== null && ownAge < RESCUE_COOLDOWN_H) {
    r.skippedByCooldown.push(wf.path);
    return; // הגנת-עצמי: מדוד את *הפעולות-שלי*, לא את הרעש-סביבי
  }
  // תרופת-שורש 1: enable — כך GitHub משתיק cron בשקט (disabled_inactivity)
  try {
    const en = await fetchWithBackoff(
      `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/${wf.id}/enable`,
      { method: "PUT", headers: apiHeaders(token) },
      `${repo}/${wf.path}/enable`,
    );
    if (!en.ok && en.status !== 200 && en.status !== 204) {
      r.note = `enable ${wf.path}: HTTP ${en.status}`;
    }
  } catch (e) {
    r.note = `enable ${wf.path}: ${String(e).slice(0, 80)}`;
    return;
  }
  // תרופת-שורש 2: dispatch — הקבלה שהחילוץ באמת ירה
  try {
    const res = await fetchWithBackoff(
      `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/${wf.id}/dispatches`,
      { method: "POST", headers: apiHeaders(token), body: JSON.stringify({ ref: branch }) },
      `${repo}/${wf.path}/dispatch`,
    );
    if (res.status === 204) {
      r.rescueDispatched.push(wf.path);
      rescueState[key] = new Date().toISOString();
    } else {
      r.note = `dispatch ${wf.path}: HTTP ${res.status}`;
    }
  } catch (e) {
    r.note = `dispatch ${wf.path}: ${String(e).slice(0, 80)}`;
  }
}

async function censusRepo(token: string, repo: RepoLite, rescueState: RescueState): Promise<RepoCensus> {
  const r: RepoCensus = {
    repo: repo.name,
    defaultBranch: repo.default_branch,
    workflows: 0,
    scheduledWorkflows: 0,
    lastScheduledRunAt: null,
    lastAnyRunAt: null,
    hoursSinceScheduled: null,
    verdict: "IDLE",
    rescueDispatched: [],
    skippedByCooldown: [],
  };
  try {
    const wfs = await ghJson<{ total_count: number; workflows: Workflow[] }>(
      token, `/repos/${ORG}/${repo.name}/actions/workflows?per_page=50`, `${repo.name}/workflows`,
    );
    r.workflows = wfs.total_count;
    if (r.workflows === 0) { r.verdict = "IDLE"; return r; }

    const runs = await ghJson<{
      total_count: number;
      workflow_runs: { id: number; event: string; created_at: string; workflow_id: number }[];
    }>(token, `/repos/${ORG}/${repo.name}/actions/runs?per_page=30`, `${repo.name}/runs`);

    if (runs.total_count === 0) { r.verdict = "IDLE"; return r; }

    const anyAt = runs.workflow_runs[0]?.created_at ?? null;
    r.lastAnyRunAt = anyAt;
    const scheduledIds = new Set<number>();
    for (const run of runs.workflow_runs) {
      if (run.event === "schedule") {
        scheduledIds.add(run.workflow_id);
        if (r.lastScheduledRunAt === null || run.created_at > r.lastScheduledRunAt) {
          r.lastScheduledRunAt = run.created_at;
        }
      }
    }
    r.scheduledWorkflows = scheduledIds.size;
    if (scheduledIds.size === 0) { r.verdict = "IDLE"; return r; }

    const age = hoursSince(r.lastScheduledRunAt);
    r.hoursSinceScheduled = age === null ? null : Math.round(age * 10) / 10;

    if (age !== null && age < STALE_H) {
      r.verdict = "ALIVE";
      return r;
    }

    // STARVED — לחלץ את כל ה-workflows המתוכננים (מושתקים וגם ערים-מזמן)
    r.verdict = "STARVED";
    const toRescue = wfs.workflows.filter(
      (w) => scheduledIds.has(w.id) || w.state !== "active",
    );
    for (const w of toRescue) {
      await rescueWorkflow(token, repo.name, w, repo.default_branch, rescueState, r);
    }
    return r;
  } catch (e) {
    r.note = `error: ${String(e).slice(0, 100)}`;
    return r;
  }
}

type RepoLite = { name: string; default_branch: string; pushed_at: string };

async function main(): Promise<void> {
  const t0 = Date.now();
  const token = readToken();
  const rescueState = loadRescueState();

  // roshpinacare-sys הוא משתמש (type=User, 40 ריפואים) — לא /orgs/ (404 שנמדד 2026-10-23)
  const repos = await ghJson<RepoLite[]>(
    token, `/users/${ORG}/repos?per_page=100&sort=pushed&type=owner`, `${ORG}/repos`,
  );
  if (!Array.isArray(repos) || repos.length === 0) throw new Error("org repos list empty");
  const list = repos.slice(0, MAX_REPOS);

  const results: RepoCensus[] = [];
  for (let i = 0; i < list.length; i += POOL) {
    const batch = list.slice(i, i + POOL);
    const settled = await Promise.all(batch.map((repo) => censusRepo(token, repo, rescueState)));
    results.push(...settled);
  }

  const alive = results.filter((r) => r.verdict === "ALIVE").length;
  const starved = results.filter((r) => r.verdict === "STARVED");
  const idle = results.filter((r) => r.verdict === "IDLE").length;
  const rescues = results.flatMap((r) => r.rescueDispatched.map((wf) => `${r.repo}:${wf}`));
  const cool = results.flatMap((r) => r.skippedByCooldown.map((wf) => `${r.repo}:${wf}`));

  // הגנת-העצמי חייבת לשרוד את-הריצה: ללא-זאת ה-cooldown מת וכל-מחזור מחלץ מחדש
  // (נתפס-חי 2026-10-23: מחזור-2 מיחזר 9 חילוצים בגלל שה-state לא נשמר לדיסק)
  if (Object.keys(rescueState).length > 0) saveRescueState(rescueState);

  const out = {
    schema: "org-census@2",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    repos: results.length,
    alive, starved: starved.length, idle,
    rescuesThisCycle: rescues,
    cooldownSkipped: cool,
    detail: results,
  };
  const tmp = `${OUT_JSON}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, OUT_JSON);

  console.log(`org-census ${out.generatedAt} — ${out.repos} repos: ${alive} ALIVE / ${starved.length} STARVED / ${idle} IDLE (${out.durationMs}ms)`);
  for (const s of starved) {
    console.log(`  STARVED ${s.repo} — last-scheduled ${s.lastScheduledRunAt ?? "never"} (${s.hoursSinceScheduled ?? "?"}h) rescued=${s.rescueDispatched.length}${s.note ? ` note=${s.note}` : ""}`);
  }
  if (rescues.length) console.log(`  rescues this cycle: ${rescues.length} → ${rescues.slice(0, 12).join(", ")}${rescues.length > 12 ? " …" : ""}`);
  if (cool.length) console.log(`  cooldown-skipped: ${cool.length} (own-action ≤ ${RESCUE_COOLDOWN_H}h)`);

  // fail-closed: כל-עוד יש ריפו STARVED — הלוח מסמן כישלון עד-שהרשת מתרפאת
  if (starved.length > 0) {
    console.error(`FAIL-CLOSED: ${starved.length} repo(s) STARVED — rescue dispatched, next cycle must prove ALIVE`);
    process.exit(1);
  }
  console.log("org-census OK — every scheduled workflow in the org is breathing");
}

main().catch((e) => {
  console.error(`org-census FAILED: ${String(e).slice(0, 200)}`);
  process.exit(1);
});
