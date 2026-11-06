/* ═══ saos-architect-daemon · lock.ts — single-flight discipline ════════════
 * O_EXCL lockfile {pid, at}. A stale lock (>30min by the injected clock) is
 * broken honestly (recorded on the handle — never silent). Fail-closed: two
 * live acquires can never coexist. (House law: single-flight, W48 runner.)
 */
import fs from "node:fs";

export interface LockHandle {
  path: string;
  pid: number;
  staleBroken: boolean;
}

export const STALE_LOCK_MS = 30 * 60 * 1000;

export function acquireLock(
  lockPath: string,
  pid: number,
  now: () => number = Date.now,
): LockHandle {
  if (fs.existsSync(lockPath)) {
    let info: { pid?: number; at?: number } = {};
    try {
      info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      info = {}; // corrupt lock → treat as stale (recorded)
    }
    const age = now() - (typeof info.at === "number" ? info.at : 0);
    if (age <= STALE_LOCK_MS) {
      throw new Error(`lock-held: ${lockPath} pid=${info.pid ?? "?"} age=${age}ms — single-flight refuses double cycle`);
    }
    // stale: broken HONESTLY — the new handle records it
    const h: LockHandle = { path: lockPath, pid, staleBroken: true };
    fs.writeFileSync(lockPath, JSON.stringify({ pid, at: now() }));
    return h;
  }
  const fd = fs.openSync(lockPath, "wx"); // O_EXCL — fail-closed on race
  fs.writeSync(fd, JSON.stringify({ pid, at: now() }));
  fs.closeSync(fd);
  return { path: lockPath, pid, staleBroken: false };
}

export function releaseLock(h: LockHandle): void {
  try {
    const info = JSON.parse(fs.readFileSync(h.path, "utf8"));
    if (info.pid === h.pid) fs.unlinkSync(h.path); // only release your own lock
  } catch {
    /* already gone — fine */
  }
}
