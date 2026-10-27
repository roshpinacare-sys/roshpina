/**
 * site-builder.ts — הידיים של הרשת: ה-preset שבונה בפועל.
 *
 * כל-מחזור: מגייס את האמת החיה מכל-הצמתים (שוק/ספר/runner/תזמונים), קורא את
 * תוכנית-הבניין העדכנית של האדריכל (data/build/plan.json), את הניתוח האחרון
 * של הסנטינל, ואת ההיסטוריה האמיתית מיומן-הראיות — ובונה מזה תוכן אמיתי
 * שהאתר מציג: data/build/night-report.json (מקור-האמת) + עותק מאומת לאתר
 * (src/data/sovereign-build.json) כדי שמטוס-הבקרה יתעדכן לבד, בלי-אדם.
 *
 * כנות: צומת UNREACHABLE מסומן ככזה — לא מסתירים. אם אין שום-אמת חיה
 * (כל-הצמתים למטה) → exit 1 ולא שוללים תוכן-טוב בזבל.
 * רץ: bun scripts/site-builder.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

const RUNNER_DIR = import.meta.dir.replace(/\/scripts$/, "");
const MY_PROJECT = "/home/z/my-project";
const ROSHPINA = "/home/z/repos/roshpina";
const BUILD_DIR = `${RUNNER_DIR}/data/build`;
const MARKET = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const RUNNER = "http://127.0.0.1:3031";

const get = async (url: string, ms = 4000): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const µ = (v: unknown): string => {
  if (v == null) return "—";
  try {
    const n = BigInt(String(v));
    const sign = n < 0n ? "-" : "";
    const abs = (n < 0n ? -n : n).toString().padStart(3, "0");
    return `${sign}${abs.slice(0, -2) || "0"}.${abs.slice(-2)}`;
  } catch {
    return String(v);
  }
};

// ─── live truth ───────────────────────────────────────────────────────────────

console.log("SITE-BUILDER: gathering live truth…");
const [marketH, econ, ledgerH, runnerH, schedulesRes] = await Promise.all([
  get(`${MARKET}/health`),
  get(`${MARKET}/economy/report`),
  get(`${LEDGER}/health`),
  get(`${RUNNER}/health`),
  get(`${RUNNER}/schedules`),
]);

if (!marketH && !ledgerH && !runnerH) {
  console.error("SITE-BUILDER-FAIL: all nodes unreachable — refusing to build content from nothing (fail-closed)");
  process.exit(1);
}

// ─── evidence journal: what the network REALLY did in the last 24h ───────────

type EndRec = { preset: string; status: string; startedAt: string; durationMs: number | null; trigger: string };
const last24 = new Map<string, { ok: number; fail: number; last: string }>();
const jobsFile = `${RUNNER_DIR}/data/jobs.jsonl`;
if (existsSync(jobsFile)) {
  const since = Date.now() - 24 * 3600 * 1000;
  const lines = readFileSync(jobsFile, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: EndRec & { phase?: string; kind?: string };
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if ((j.phase ?? j.kind) !== "end") continue;
    const ts = Date.parse(j.startedAt);
    if (!Number.isFinite(ts) || ts < since) continue; // journal is append-ordered: once older, stop
    const row = last24.get(j.preset) ?? { ok: 0, fail: 0, last: "" };
    if (j.status === "succeeded") row.ok++;
    else row.fail++;
    row.last = j.startedAt;
    last24.set(j.preset, row);
  }
}

// real engineering acts: the last commits of the fleet's repos
const gitLog = (dir: string): string[] => {
  try {
    const out = Bun.spawnSync(["git", "-C", dir, "log", "--oneline", "-4", "--format=%h %s (%cr)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder().decode(out.stdout).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const roshpinaCommits = gitLog(ROSHPINA);
const controlCommits = gitLog(MY_PROJECT);

// plan + brain
const readJson = <T,>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};
type PlanTask = { id: string; title: string; why?: string; action: string; status?: string };
type Plan = { generatedAt?: string; model?: string; mission?: string; tasks?: PlanTask[] };
const plan = readJson<Plan>(`${BUILD_DIR}/plan.json`);
type AiRec = { generatedAt?: string; model?: string; analysis?: string };
const ai = readJson<AiRec>(`${RUNNER_DIR}/data/ai/latest-analysis.json`);

// schedules health
type SchedRow = { presetId: string; intervalSec: number; enabled: boolean; runCount: number; failCount: number; lastStatus: string };
const scheds = ((schedulesRes?.schedules as SchedRow[]) ?? []).sort((a, b) => a.presetId.localeCompare(b.presetId));
const green = scheds.filter((s) => s.enabled && s.lastStatus === "succeeded").length;
const enabledCount = scheds.filter((s) => s.enabled).length;

// ─── compose the honest report ───────────────────────────────────────────────

const agentRows = ((econ?.agents as { agentId: string; usds: string; usdsLocked: string; usdsStaked?: string; saos: string; saosLocked: string; fills: number }[]) ?? []);
const q = (econ?.conservation as Record<string, Record<string, unknown>> | undefined)?.quote;
const stakedTotal = agentRows.reduce((acc, a) => acc + BigInt(a.usdsStaked ?? "0"), 0n);
const wd = (runnerH?.watchdog as { healCount?: number } | undefined) ?? {};

const whatWasBuilt: string[] = [];
for (const [preset, r] of [...last24.entries()].filter(([, r]) => r.ok > 0).sort((a, b) => b[1].ok - a[1].ok).slice(0, 8)) {
  whatWasBuilt.push(`${preset}: ${r.ok} ריצות-מוצלחות ב-24h${r.fail ? ` (${r.fail} כישלונות-כנים)` : ""}`);
}
if (roshpinaCommits.length) whatWasBuilt.push(`הנדסה אמיתית שנדחפה לגיט (roshpina): ${roshpinaCommits[0].split(" (")[0]}`);
if (controlCommits.length) whatWasBuilt.push(`מטוס-הבקרה מגובה: ${controlCommits[0].split(" (")[0]}`);

const builtAt = new Date().toISOString();
const cycleFile = `${BUILD_DIR}/cycle.txt`;
const cycle = Number(readJson<string>(cycleFile) ?? readFileSyncSafe(cycleFile) ?? "0") + 1;

const report = {
  builtAt,
  cycle,
  live: {
    market: marketH
      ? { trades: Number(marketH.trades ?? 0), bids: Number(marketH.bids ?? 0), asks: Number(marketH.asks ?? 0) }
      : "UNREACHABLE",
    ledger: ledgerH ? { seq: Number(ledgerH.seq ?? 0), accounts: Number(ledgerH.accounts ?? 0) } : "UNREACHABLE",
    runner: runnerH
      ? { jobs: Number(runnerH.jobsTotal ?? 0), schedules: `${green}/${enabledCount} ירוקים`, ticks: Number(runnerH.tickCount ?? 0), heals: Number(wd.healCount ?? 0) }
      : "UNREACHABLE",
    economy: econ
      ? { agents: agentRows.length, treasury: µ(q?.fees), staked: µ(stakedTotal.toString()), conservation: (q?.holds ? "מוחזק" : "נפר") }
      : "UNREACHABLE",
  },
  stats: {
    trades: Number(marketH?.trades ?? 0),
    ledgerSeq: Number(ledgerH?.seq ?? 0),
    agents: agentRows.length,
    jobsTotal: Number(runnerH?.jobsTotal ?? 0),
    schedulesGreen: green,
    schedulesEnabled: enabledCount,
  },
  whatWasBuilt,
  plan: plan
    ? {
        generatedAt: plan.generatedAt ?? null,
        model: plan.model ?? null,
        mission: plan.mission ?? null,
        tasks: (plan.tasks ?? []).slice(0, 6).map((t) => ({ id: t.id, title: t.title, why: t.why ?? "", action: t.action })),
      }
    : null,
  insight: ai?.analysis
    ? { at: ai.generatedAt ?? null, model: ai.model ?? null, text: ai.analysis.slice(0, 1600) }
    : null,
  commits: { roshpina: roshpinaCommits, control: controlCommits },
};

// ─── validate (fail-closed on our own output) + atomic write ────────────────

const json = JSON.stringify(report, null, 2);
const reparsed = JSON.parse(json) as typeof report;
if (!reparsed.builtAt || !Array.isArray(reparsed.whatWasBuilt)) {
  console.error("SITE-BUILDER-FAIL: self-validation failed — refusing to write");
  process.exit(1);
}

mkdirSync(BUILD_DIR, { recursive: true });
const tmp = `${BUILD_DIR}/night-report.json.tmp`;
writeFileSync(tmp, json);
renameSync(tmp, `${BUILD_DIR}/night-report.json`);

// append-only build log (evidence)
writeFileSync(`${BUILD_DIR}/build-log.jsonl`, JSON.stringify({ builtAt, cycle, trades: report.stats.trades, ledgerSeq: report.stats.ledgerSeq, jobs: report.stats.jobsTotal }) + "\n", { flag: "a" });
writeFileSync(cycleFile, String(cycle));

// the site's live copy: only through validation, atomic, never breaks the page
const siteDataDir = `${MY_PROJECT}/src/data`;
try {
  mkdirSync(siteDataDir, { recursive: true });
  const siteTmp = `${siteDataDir}/sovereign-build.json.tmp`;
  writeFileSync(siteTmp, json);
  renameSync(siteTmp, `${siteDataDir}/sovereign-build.json`);
} catch (e) {
  console.error(`SITE-BUILDER-WARN: site copy failed (${String(e).slice(0, 120)}) — runner copy still authoritative`);
}

console.log(`SITE-BUILDER-OK: cycle=${cycle} · trades=${report.stats.trades} · ledgerSeq=${report.stats.ledgerSeq} · schedules=${green}/${enabledCount} · built items=${whatWasBuilt.length}`);
console.log(json.slice(0, 1200));

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}
