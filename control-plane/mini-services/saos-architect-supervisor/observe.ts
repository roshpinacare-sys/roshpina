/* saos-architect-daemon · observe.ts — עיני-הארכיטקט (MASTER DIRECTIVE §1, מחזור 31)
 * קריאה-בלבד: דפיקות-צי, גילאי-קומיטים, טריות-וורקפלו-ענן, פסק-קלי.
 * כל-מקור ניתן-להזרקה (DI) ל-selftest אופליין. אפס-סוד-בלוג. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export const TOKEN_PATH = "/home/z/my-project/upload/גיטראש.txt";
export const REPOS = {
  giant: "/home/z/my-project",
  saosDex: "/home/z/work/saos-dex",
  fleetHQ: "/home/z/estate/FleetHQ",
  domain: "/home/z/estate/Domain",
};
const PING_TIMEOUT = 2000;

export async function ping(url: string, f: typeof fetch = fetch): Promise<number | null> {
  try { const r = await f(url, { signal: AbortSignal.timeout(PING_TIMEOUT) }); return r.status; }
  catch { return null; }
}

export function gitLastCommitIso(dir: string, ex: typeof execFile = execFile): Promise<string | null> {
  return new Promise((res) => {
    ex("git", ["-C", dir, "log", "-1", "--format=%cI"], { timeout: 4000 }, (err, stdout) => {
      if (err) return res(null);
      res(String(stdout).trim() || null);
    });
  });
}

export function lastGridBeatAgeMs(dir: string, ex: typeof execFile = execFile): Promise<number | null> {
  return new Promise((res) => {
    ex("git", ["-C", dir, "log", "-1", "--format=%cI %s", "--grep=^grid-beat:"], { timeout: 4000 }, (err, stdout) => {
      if (err) return res(null);
      const iso = String(stdout).trim().split(" ")[0];
      const t = iso ? Date.parse(iso) : NaN;
      res(Number.isFinite(t) ? Date.now() - t : null);
    });
  });
}

function ghToken(f = readFileSync): string {
  return f(TOKEN_PATH, "utf8").trim();
}

/** ריצת-וורקפלו-אחרונה (created_at ISO) — null על-שגיאה (fail-honest). */
export async function lastWorkflowRun(repo: string, workflow: string, f: typeof fetch = fetch): Promise<string | null> {
  let token = "";
  try { token = ghToken(); } catch { return null; }
  try {
    const r = await f(`https://api.github.com/repos/roshpinacare-sys/${repo}/actions/workflows/${workflow}/runs?per_page=1`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "saos-architect-daemon" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json() as { workflow_runs?: { created_at?: string }[] };
    return j.workflow_runs?.[0]?.created_at ?? null;
  } catch { return null; }
}

export interface Observation {
  at: string;
  dexEngine: number | null;        // :3010 /saos-dex/api/dex/state
  issueForge: number | null;       // :3046 /health
  fleetEconomy: number | null;     // :3016 /health
  edge: number | null;             // :3000
  gateway: number | null;          // :3140 (נתיב-אחר — תצפית-בלבד)
  forgeLastCycleAt: string | null;
  repos: Record<string, string | null>;
  gridBeatAgeMs: number | null;
  workflows: Record<string, string | null>; // key: repo:workflow → created_at ISO
  kelly: { verdict: string; fractionBps: number } | null; // מ-grids/state/kelly-sizing.json
}

export async function observe(f: typeof fetch = fetch, ex: typeof execFile = execFile): Promise<Observation> {
  const [dexEngine, issueForge, fleetEconomy, edge, gateway] = await Promise.all([
    ping("http://127.0.0.1:3010/saos-dex/api/dex/state", f),
    ping("http://127.0.0.1:3046/health", f),
    ping("http://127.0.0.1:3016/health", f),
    ping("http://127.0.0.1:3000/", f),
    ping("http://127.0.0.1:3140/health", f),
  ]);
  const repoEntries = await Promise.all(Object.entries(REPOS).map(async ([k, d]) => [k, await gitLastCommitIso(d, ex)] as const));
  let forgeLastCycleAt: string | null = null;
  if (issueForge !== null) {
    try {
      const r = await f("http://127.0.0.1:3046/health", { signal: AbortSignal.timeout(PING_TIMEOUT) });
      const j = await r.json() as { lastCycle?: { at?: string } };
      forgeLastCycleAt = j.lastCycle?.at ?? null;
    } catch { /* fail-honest */ }
  }
  let kelly: Observation["kelly"] = null;
  try {
    const j = JSON.parse(readFileSync("/home/z/work/saos-dex/grids/state/kelly-sizing.json", "utf8"));
    if (j?.protocol === "SAOS-KELLY/1") kelly = { verdict: String(j.verdict), fractionBps: Number(j.fractionBps) };
  } catch { /* אין-פסק-קלי עדיין — כן */ }
  const [dexGrid, extProfit, curate] = await Promise.all([
    lastWorkflowRun("saos-dex", "dex-grid.yml", f),
    lastWorkflowRun("saos-dex", "external-profit-publish.yml", f),
    lastWorkflowRun("saos-dex", "curate.yml", f),
  ]);
  return {
    at: new Date().toISOString(),
    dexEngine, issueForge, fleetEconomy, edge, gateway, forgeLastCycleAt,
    repos: Object.fromEntries(repoEntries),
    gridBeatAgeMs: await lastGridBeatAgeMs(REPOS.saosDex, ex),
    workflows: { "saos-dex:dex-grid.yml": dexGrid, "saos-dex:external-profit-publish.yml": extProfit, "saos-dex:curate.yml": curate },
    kelly,
  };
}
