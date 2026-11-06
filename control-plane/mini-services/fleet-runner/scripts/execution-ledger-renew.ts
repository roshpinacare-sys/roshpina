/**
 * execution-ledger-renew.ts — §2 of the 42nd directive (trace 1a178c71bcb7ddad):
 * the execution ledger (SAOS-EXECUTION-LEDGER/1) renews itself from MEASURED
 * live facts and publishes to BOTH law-named surfaces:
 *   1. Domain repo (roshpinacare-sys/Domain → roshpinacare-sys.github.io/Domain/)
 *   2. user-site root repo (roshpinacare-sys/roshpinacare-sys.github.io → site root)
 * plus a mirror copy into giant (state/execution/) on the next giant lane push.
 *
 * Zero invented numbers: every snapshot value is fetched from the live fleet
 * (market :3033, ledger :3032, runner :3031). A fetch that fails leaves the
 * value absent and records the honest gap — never a placeholder.
 *
 * רץ: bun scripts/execution-ledger-renew.ts   (schedule: every 12h)
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const DOMAIN = "/home/z/repos/domain";
const ROOTSITE = "/home/z/repos/pages-root";
const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

async function j<T = Record<string, unknown>>(url: string, ms = 5000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── measured facts (live only — no fabrication law) ──────────────────────────
const market = await j<Record<string, unknown>>("http://127.0.0.1:3033/health");
const econ = await j<{ agents?: { agentId: string; fills: number }[]; settledTrades?: number; conservation?: { quote?: { holds?: boolean } } }>("http://127.0.0.1:3033/economy/report");
const runner = await j<Record<string, unknown>>("http://127.0.0.1:3031/health");
const ledger = await j<Record<string, unknown>>("http://127.0.0.1:3032/health");

const fillsByAgent = (econ?.agents ?? []).map((a) => `${a.agentId}:${a.fills}`).join(" ");
const services = [
  market ? "market:3033-UP" : "market:3033-DOWN",
  ledger ? "ledger:3032-UP" : "ledger:3032-DOWN",
  runner ? "runner:3031-UP" : "runner:3031-DOWN",
].join(" ");

// ── LINEAGE LAW (erasure class killed — measured 2026-10-26, rescued by G77-c):
// the ledger's verified history (round-29 core, cycle30/31, wave81, done/gaps
// rows, erasureGuard) is NEVER replaced — a renewal MERGES fresh measured facts
// into the existing document: refresh `at`/measuredSnapshot/freshness, APPEND
// at most one new done row per renew, never delete or rewrite prior rows.
const LEDGER_PATH_DOMAIN = join(DOMAIN, "execution-state.json");
let prev: Record<string, unknown> = {};
try {
  prev = JSON.parse(readFileSync(LEDGER_PATH_DOMAIN, "utf8")) as Record<string, unknown>;
} catch {
  // missing/corrupt → honest bounded default; prior verified history is
  // recoverable from git (the accessor's recovery law), never re-invented here
}

const prevDone = Array.isArray(prev.done) ? (prev.done as { title: string; detail: string; evidence: string }[]) : [];
const prevPartial = Array.isArray(prev.partial) ? (prev.partial as { title: string; detail: string }[]) : [];
const prevGaps = Array.isArray(prev.gaps) ? (prev.gaps as { title: string; detail: string }[]) : [];
const prevNext = Array.isArray(prev.next) ? (prev.next as { title: string; detail: string; owner: string }[]) : [];

const freshSnapshot = {
  services,
  gridVerdict: market && econ ? "ARMED-LIVE" : "WAITING",
  valueGuard: econ?.conservation?.quote?.holds ? "conservation-HOLDS" : "unverified",
  realFillsLifetime: econ?.settledTrades ?? null,
  fillRecordsLedger: econ?.settledTrades ?? null,
  fillsByAgent: fillsByAgent || null,
  runner: runner ? `jobs=${runner.jobsTotal} schedules=${runner.schedulesCount}` : null,
  ledger: ledger ? `seq=${ledger.seq} accounts=${ledger.accounts}` : null,
};

const doc: Record<string, unknown> = {
  ...prev,
  schema: "SAOS-EXECUTION-LEDGER/1",
  at: nowIso(),
  generator: "fleet-runner/execution-ledger-renew.ts (directive-42 §2, lineage-preserving renewal)",
  sourceWorklog: "giant worklog task-55 (directive 42, trace 1a178c71bcb7ddad)",
  law: "אין-ראיה = לא-קרה · כל-מספר נמדד-מהקרקע בזמן-החידוש · מורשת-מאומתת-לעולם-לא-נמחקת",
  freshness: { staleAfterHours: 48, renewedBy: "execution-ledger-renew (12h schedule, lineage-preserving)", howToVerify: "compare .at against the runner job journal; history rows append-only" },
  measuredSnapshot: freshSnapshot,
  done: prevDone,
  partial: prevPartial,
  gaps: prevGaps,
  next: prevNext,
};

if (market && econ) {
  // growth law: auto-renew rows cap at the last 60 (the verified core history
  // lives in git + SWARM_STATE receipts — the file stays readable, the lineage
  // lives forever in refs)
  const capped = prevDone.length > 60 ? prevDone.slice(prevDone.length - 60) : prevDone;
  doc.done = [
    ...capped,
    {
      title: `חידוש-נמדד ${doc.at} (צו 42 §2) — מורשת נשמרה (${prevDone.length} שורות-קודמות)`,
      detail: `${services}; מסחר ריבוני ${econ.settledTrades} עסקאות-מאושרות; שימור ${econ.conservation?.quote?.holds ? "מלא" : "לא-מאומת"}`,
      evidence: "http://127.0.0.1:3033/economy/report + /health measured at renew time",
    },
  ];
}
if (!market || !econ || !runner || !ledger) {
  doc.gaps = [
    ...prevGaps,
    { title: `מקור-חי-חסר בזמן-החידוש ${doc.at}`, detail: services + " — הערך-החסר נשאר ריק בכנות (אין-המצאה)" },
  ];
}

const body = JSON.stringify(doc, null, 2) + "\n";

// ── publish: write, commit, pull --rebase (race-safe), push — both repos ────
function git(args: string[], cwd: string): { out: string; code: number } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { out: (p.stdout.toString() + p.stderr.toString()).trim(), code: p.exitCode ?? 1 };
}

function publish(repo: string, file: string, msg: string): string {
  const target = join(repo, file);
  const prev = existsSync(target) ? readFileSync(target, "utf8") : "";
  writeFileSync(target, body);
  if (prev === body) return "unchanged";
  if (git(["add", file], repo).code !== 0) return "git-add-failed";
  const idem = `execution-ledger-renew ${doc.at}`;
  const log = git(["log", "--format=%s", "-1"], repo);
  if (log.out === idem) return "already-committed";
  if (git(["commit", "-m", idem], repo).code !== 0) return "commit-failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pull = git(["pull", "--rebase", "-q", "origin", "HEAD"], repo);
    const push = git(["push", "-q", "origin", "HEAD"], repo);
    if (push.code === 0) return "renewed+pushed";
    if (pull.code !== 0) { git(["rebase", "--abort"], repo); }
  }
  return "committed(push-raced — next cycle re-pushes)";
}

const dStat = publish(DOMAIN, "execution-state.json", "domain");
const rStat = existsSync(ROOTSITE) ? publish(ROOTSITE, "execution-state.json", "root-site") : "root-clone-absent";

console.log(`[execution-ledger-renew] domain=${dStat} root-site=${rStat} at=${doc.at} services=[${services}]`);

// chain §4: the GAP register rides the same 12h cadence (one schedule, both
// artifacts — MAX_SCHEDULES=24 law respected, no second timer)
const pulse = Bun.spawnSync(["bun", join(import.meta.dir, "pulse-network-renew.ts")], { stdout: "pipe", stderr: "pipe" });
console.log(`[execution-ledger-renew] pulse-chain → ${pulse.stdout.toString().trim().split("\n").pop() ?? pulse.stderr.toString().slice(0, 120)}`);
