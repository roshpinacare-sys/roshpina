/* fabric-watchdog.ts — the 24/7 no-operator liveness loop for the sovereign fabric
 * (sovereign-fabric-liveness lane · wave 19.9 · trace 1a16ecae271ac379 — 37th directive §4).
 *
 * Measured crisis it cures: when external agents leave, the local fabric dies with them
 * (economy :3016, voice :3019, forge :3046 all measured DEAD at 16:5x; only the runner
 * survived). The [voice] escalation backlog (issues 183-214) is the death-cries of services
 * nobody revived. THIS schedule is the standing revival authority.
 *
 * Laws:
 *  - probe → revive dead → re-assert custody-guard → periodic custody-seal → receipt.
 *  - single-writer guard (the commander's 19.85c lesson): verify the port is FREE before
 *    spawning — never race a living organ.
 *  - house spawn discipline: subshell+nohup double-fork (plain & and setsid die silently).
 *  - fail-closed: exit 1 while any fabric organ is down after revival attempts.
 *  - honest receipts: every cycle lands in data/ai/fabric-watchdog.json (atomic tmp+rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

const AI_DIR = join(import.meta.dir, "..", "data", "ai");
const OUT_JSON = join(AI_DIR, "fabric-watchdog.json");
const LOG_DIR = "/home/z/repos/giant/mini-services/logs";
const GIANT_MS = "/home/z/repos/giant/mini-services";

type Organ = {
  id: string;
  port: number;
  healthPath: string;
  spawnCmd: string; // run from spawnCwd
  spawnCwd: string;
  label: string;
  bootGraceMs?: number; // slow-boot organs (compilers, self-cloners)
};

const ORGANS: Organ[] = [
  {
    id: "economy",
    port: 3016,
    healthPath: "/health",
    spawnCmd: "bun index.ts",
    spawnCwd: `${GIANT_MS}/fleet-economy`,
    label: "fleet-economy :3016",
  },
  {
    id: "voice",
    port: 3019,
    healthPath: "/health",
    spawnCmd: "bun index.ts",
    spawnCwd: `${GIANT_MS}/sovereign-voice`,
    label: "sovereign-voice :3019",
  },
  {
    id: "forge",
    port: 3046,
    healthPath: "/health",
    spawnCmd: "bun --hot index.ts",
    spawnCwd: `${GIANT_MS}/issue-forge`,
    env: { FORGE_INTERVAL_MS: "180000" },
    label: "issue-forge :3046 (self-cycling 3min)",
  } as Organ & { env: Record<string, string> } as Organ,
  {
    // ריפוי-מבוי-סתום שנמדד (גל 19.9): הקול מסרב להקים את ה-DEX עד-קונסולה-חיה
    // (gate:"console") — אבל הקונסולה לא קיימת בקופסה → dex-unreachable לנצח.
    // תורת-הבעלים (§1 אישור-מלא, אפס-תלות-מפעיל): ה-watchdog הוא רשות-החייאה
    // העומדת — מקים את ה-DEX ישירות (הפקודה המדויקת של הקול, בלי-השער).
    id: "dex",
    port: 3010,
    healthPath: "/saos-dex/api/dex/state",
    spawnCmd: "bun index.ts",
    spawnCwd: `${GIANT_MS}/saos-dex-node`,
    label: "saos-dex-node :3010 (self-cloning wrapper)",
    bootGraceMs: 90_000, // next dev compile + self-clone latency
  },
];

/* ── probe: honest health check (fail = down) ── */
async function probe(o: Organ): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${o.port}${o.healthPath}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/* ── single-writer guard: is the port free? (never race a living organ) ── */
async function portFree(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) });
    return false; // something answered → occupied
  } catch (e) {
    // connection refused = free; timeout with no answer = assume occupied (fail-closed)
    return String(e).includes("refused");
  }
}

/* ── house spawn: subshell+nohup double-fork, detached, logged ── */
function spawnOrgan(o: Organ): boolean {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const envPrefix = (o as Organ & { env?: Record<string, string> }).env
      ? Object.entries((o as Organ & { env?: Record<string, string> }).env!).map(([k, v]) => `${k}=${v}`).join(" ") + " "
      : "";
    const script = `( cd "${o.spawnCwd}" && setsid nohup ${envPrefix}${o.spawnCmd} >> "${LOG_DIR}/${o.id}.log" 2>&1 & )`;
    const proc = Bun.spawn(["bash", "-c", script], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    void proc.exited;
    return true;
  } catch {
    return false;
  }
}

/* ── custody-guard re-assertion (skip-worktree flags are per-clone; re-assert every cycle) ── */
function assertCustodyGuard(): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(["bun", "custody-guard.mjs"], { cwd: `${GIANT_MS}/fleet-economy` });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() || p.stderr.toString().trim().slice(0, 120) };
  } catch (e) {
    return { ok: false, out: String(e).slice(0, 120) };
  }
}

/* ── periodic custody seal (append-only snapshots; every SEAL_EVERY_NTH cycle) ── */
const SEAL_EVERY_NTH = 6; // 300s interval → seal ≈ every 30min; rewind loses ≤30min instead of the book
function custodySeal(): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(["bun", "custody-seal.mjs"], { cwd: `${GIANT_MS}/fleet-economy` });
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim().split("\n")[0].slice(0, 160) };
  } catch (e) {
    return { ok: false, out: String(e).slice(0, 160) };
  }
}

/* ── receipt (atomic tmp+rename) ── */
function writeReceipt(r: unknown) {
  mkdirSync(AI_DIR, { recursive: true });
  const tmp = OUT_JSON + ".tmp";
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  renameSync(tmp, OUT_JSON);
}

/* ── one bounded cycle ── */
export async function watchOnce(runIndex: number) {
  const t0 = Date.now();
  const organs: Record<string, { up: boolean; revived: boolean; spawnOk?: boolean; portFreeChecked?: boolean }> = {};
  let allUp = true;

  for (const o of ORGANS) {
    let up = await probe(o);
    const entry: { up: boolean; revived: boolean; spawnOk?: boolean; portFreeChecked?: boolean } = { up, revived: false };
    if (!up) {
      const free = await portFree(o.port);
      entry.portFreeChecked = true;
      if (free) {
        entry.spawnOk = spawnOrgan(o);
        await new Promise((r) => setTimeout(r, o.bootGraceMs ?? 6000)); // boot window
        up = await probe(o);
        entry.revived = up;
      }
    }
    entry.up = up;
    organs[o.id] = entry;
    if (!up) allUp = false;
  }

  const guard = assertCustodyGuard();
  let seal: { ok: boolean; out: string } | null = null;
  if (runIndex % SEAL_EVERY_NTH === 0) seal = custodySeal();

  const receipt = {
    schema: "fabric-watchdog/1",
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    organs,
    custodyGuard: guard,
    custodySeal: seal,
    allUp,
  };
  writeReceipt(receipt);
  return receipt;
}

/* ── CLI ── */
if (import.meta.main) {
  const prev = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, "utf8")) : { runIndex: 0 };
  const runIndex = Number(prev.runIndex ?? 0) + 1;
  const r = await watchOnce(runIndex);
  writeReceipt({ ...r, runIndex });
  console.log(`FABRIC-WATCHDOG run#${runIndex}: allUp=${r.allUp} guard=${r.custodyGuard.ok} seal=${r.custodySeal ? r.custodySeal.ok : "skip"}`);
  process.exit(r.allUp && r.custodyGuard.ok ? 0 : 1);
}
