/* saos-architect-daemon · index.ts — ראש-הארכיטקטורה-הקנוני (MASTER DIRECTIVE §1, מחזור 31)
 * פורט 3047 · לולאה רציפה (ARCHITECT_INTERVAL_MS, ברירת-מחדל 120ש׳) · single-flight.
 * observe → decide → act → receipt. /cycle = מחזור-אחד-תחום (ל-CI/cron). */
import { observe, type Observation } from "./observe";
import { decide, type Action } from "./decide";
import { executeActions, appendReceipt, countReceipts } from "./act";

const PORT = Number(process.env.ARCHITECT_PORT ?? 3047);
const INTERVAL = Math.max(30_000, Number(process.env.ARCHITECT_INTERVAL_MS ?? 120_000));

let running = false;
let lastObservation: Observation | null = null;
let lastActions: Action[] = [];
let lastCycleAt: string | null = null;
let cycles = 0;

export async function runCycle(opts: { dry?: boolean } = {}): Promise<{ ok: boolean; verdict: string; actions: Action[]; results?: unknown; acted?: number }> {
  if (running && !opts.dry) return { ok: false, verdict: "already-running", actions: [] };
  running = true;
  try {
    const o = await observe();
    lastObservation = o;
    const actions = decide(o);
    lastActions = actions;
    if (opts.dry) {
      const r = await executeActions(actions, { dry: true });
      const wouldAct = actions.filter((a) => a.kind !== "note").length;
      return { ok: true, verdict: `dry: would-act=${wouldAct} notes=${actions.filter((a) => a.kind === "note").length}`, actions, results: r.results };
    }
    const r = await executeActions(actions);
    lastCycleAt = new Date().toISOString();
    cycles++;
    return { ok: true, verdict: `acted=${r.acted} notes=${actions.filter((a) => a.kind === "note").length}`, actions, results: r.results, acted: r.acted };
  } catch (e) {
    const err = String(e instanceof Error ? e.message : e).slice(0, 200);
    if (!opts.dry) appendReceipt({ phase: "cycle-error", verdict: "fail-honest", detail: { err } });
    return { ok: false, verdict: `error: ${err}`, actions: [] };
  } finally { running = false; }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true, daemon: "saos-architect/1", port: PORT, intervalMs: INTERVAL,
        cycles, receipts: countReceipts(), lastCycleAt, running,
      });
    }
    if (url.pathname === "/state") {
      return Response.json({ observation: lastObservation, actions: lastActions, cycles, lastCycleAt });
    }
    if (url.pathname === "/cycle" && req.method === "POST") {
      const dry = url.searchParams.get("dry") === "1";
      return Response.json(await runCycle({ dry }));
    }
    return new Response("saos-architect-daemon: /health /state POST /cycle[?dry=1]\n", { status: 404 });
  },
});

console.info(`[saos-architect] עלה על :${server.port} · לולאה כל ${INTERVAL / 1000}ש׳ · single-flight · receipts=SAOS-ARCHITECT/1`);

/* הלולאה-הרציפה: מחזור-תחום כל-INTERVAL; single-flight נאכף ב-runCycle. */
let timer: ReturnType<typeof setInterval> | null = setInterval(() => { void runCycle(); }, INTERVAL);
process.on("SIGTERM", () => { if (timer) clearInterval(timer); process.exit(0); });
