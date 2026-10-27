/* saos-architect-supervisor · act.ts — ידי-הארכיטקט: ביצוע-פעולות-תחומות + קבלות-חתומות
 * כל-פעולה מייצרת קבלה SAOS-ARCHITECT/1 (append-only, שרשרת-חשיש prev→hash — חוק-הצי). */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { TOKEN_PATH } from "./observe";
import type { Action } from "./decide";

export const GIANT = "/home/z/my-project";
export const LEDGER_PATH = `${GIANT}/mini-services/saos-architect-supervisor/state/architect-ledger.jsonl`;

export function hashRec(r: object): string {
  return createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 32);
}

export function lastReceiptHash(): string {
  try {
    const lines = readFileSync(LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]!); if (r?.hash) return r.hash; } catch { /* קו-פגום — ממשיכים-אחורה */ }
    }
  } catch { /* פנקס-חדש */ }
  return "";
}

export function appendReceipt(rec: { phase: string; actions?: unknown; verdict?: string; detail?: unknown }): { seq: number; hash: string } {
  mkdirSync(`${GIANT}/mini-services/saos-architect-supervisor/state`, { recursive: true });
  const prev = lastReceiptHash();
  const seq = countReceipts() + 1;
  const body = { schema: "SAOS-ARCHITECT/1", seq, at: new Date().toISOString(), prev, ...rec };
  const hash = hashRec(body);
  appendFileSync(LEDGER_PATH, JSON.stringify({ ...body, hash }) + "\n");
  return { seq, hash };
}

export function countReceipts(): number {
  try {
    return readFileSync(LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean).length;
  } catch { return 0; }
}

/** הפעלה-מנותקת: תהליך-בן-חי-בפני-עצמו (stdio ignore + unref) — שורד-את-האב. */
export function spawnDetached(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
}

export const SPAWN_PLANS = {
  dexNode: { cmd: "bun", args: ["index.ts"], cwd: `${GIANT}/mini-services/saos-dex-node` },
  issueForge: { cmd: "bun", args: ["index.ts"], cwd: `${GIANT}/mini-services/issue-forge` },
} as const;

export function executeSpawn(kind: keyof typeof SPAWN_PLANS): void {
  const p = SPAWN_PLANS[kind];
  spawnDetached(p.cmd, [...p.args], p.cwd);
}

export async function triggerForgeCycle(f: typeof fetch = fetch): Promise<{ ok: boolean; verdict?: string; err?: string }> {
  try {
    const r = await f("http://127.0.0.1:3046/cycle", { method: "POST", signal: AbortSignal.timeout(120_000) });
    const j = await r.json().catch(() => ({})) as { verdict?: string; ok?: boolean };
    return { ok: r.ok, verdict: j.verdict };
  } catch (e) { return { ok: false, err: String(e instanceof Error ? e.message : e).slice(0, 120) }; }
}

export async function dispatchWorkflow(repo: string, workflow: string, f: typeof fetch = fetch): Promise<{ ok: boolean; status?: number; err?: string }> {
  let token = "";
  try { token = readFileSync(TOKEN_PATH, "utf8").trim(); } catch (e) { return { ok: false, err: "token-missing" }; }
  try {
    const r = await f(`https://api.github.com/repos/roshpinacare-sys/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "saos-architect-supervisor" },
      body: JSON.stringify({ ref: "main" }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: r.ok || r.status === 204, status: r.status };
  } catch (e) { return { ok: false, err: String(e instanceof Error ? e.message : e).slice(0, 120) }; }
}

/** מגש-ביצוע-מלא לפעולות-מחזור. מוחזרת קבלה-אחת-מסכמת. */
export async function executeActions(actions: Action[], opts: { fetch?: typeof fetch; dry?: boolean } = {}): Promise<{ acted: number; results: unknown[] }> {
  const f = opts.fetch ?? fetch;
  const results: unknown[] = [];
  let acted = 0;
  for (const a of actions) {
    let res: unknown;
    switch (a.kind) {
      case "spawn-dex-node": if (!opts.dry) executeSpawn("dexNode"); acted++; res = { kind: a.kind, spawned: !opts.dry }; break;
      case "spawn-issue-forge": if (!opts.dry) executeSpawn("issueForge"); acted++; res = { kind: a.kind, spawned: !opts.dry }; break;
      case "trigger-forge-cycle": res = { kind: a.kind, ...(opts.dry ? { dry: true } : await triggerForgeCycle(f)) }; if (!opts.dry) acted++; break;
      case "dispatch-dex-grid": res = { kind: a.kind, ...(opts.dry ? { dry: true } : await dispatchWorkflow("saos-dex", "dex-grid.yml", f)) }; if (!opts.dry) acted++; break;
      case "dispatch-external-profit": res = { kind: a.kind, ...(opts.dry ? { dry: true } : await dispatchWorkflow("saos-dex", "external-profit-publish.yml", f)) }; if (!opts.dry) acted++; break;
      case "dispatch-curate": res = { kind: a.kind, ...(opts.dry ? { dry: true } : await dispatchWorkflow("saos-dex", "curate.yml", f)) }; if (!opts.dry) acted++; break;
      case "note": res = { kind: a.kind, why: a.why }; break;
    }
    results.push(res);
  }
  if (!opts.dry) appendReceipt({ phase: "cycle", actions: actions.map((a) => a.kind), verdict: `acted=${acted}`, detail: results });
  return { acted, results };
}
