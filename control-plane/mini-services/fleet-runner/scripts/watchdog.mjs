/**
 * watchdog.mjs — השגחה מתועדת (task 58): מי משגיח על-המשגיח? הראיה ביומן.
 *
 * מודד ומתעד (לא מרפא — זה תפקיד night-heartbeat.sh v3 + start-nodes):
 *   1. חיות-הליבה-החיצונית: pidfile של night-heartbeat + טריות-הלוג שלו
 *   2. runner /health · web :3000 · ledger · market (4 פרובות)
 *   3. טריות-יומן-העבודות (רשומת-END אחרונה ב-jobs.jsonl)
 *   4. היסטוריית-החייאות מהלוג (הוכחת-החייאות-העצמית)
 * פלטים: data/heartbeat.json (אטומי) + data/watchdog.jsonl (append-only, ניתוח).
 * SUPERVISION-BROKEN ⇒ exit 1 fail-closed. יומן-דומם >180ד׳ בזמן-runner-חי ⇒
 * הפעלה-עצמית של ai-sentinel (פעילות-סוכן-נראית). אפס-תיקונים — רק מדידה-כנה.
 * רץ: bun scripts/watchdog.mjs
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir.replace(/\/scripts$/, "");
const DATA = join(ROOT, "data");
const PID_FILE = "/tmp/fleet-heartbeat.pid";
const HB_LOG = join(ROOT, "logs/heartbeat.log");
const JOBS = join(DATA, "jobs.jsonl");
const ageSec = (ms) => Math.round((Date.now() - ms) / 1000);

const at = new Date().toISOString();
const probes = { heartbeatPid: false, heartbeatLog: false, runner: false, web: false, ledger: false, market: false };

// 1. ליבה-חיצונית: pid חי + לוג-טרי (≤5 דקות = הלופ-בן-ה-30שנ׳ באמת פועם)
let pid = null;
try { pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10); } catch {}
probes.heartbeatPid = (() => { try { if (pid) process.kill(pid, 0); return !!pid; } catch { return false; } })();
try { probes.heartbeatLog = ageSec(statSync(HB_LOG).mtimeMs) < 300; } catch { probes.heartbeatLog = false; }

// 2. פרובות-HTTP (runner/web/ledger/market) — 3שנ' timeout לכל-אחת
async function probe(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
[probes.runner, probes.web, probes.ledger, probes.market] = await Promise.all([
  probe("http://127.0.0.1:3031/health"),
  probe("http://127.0.0.1:3000/"),
  probe("http://127.0.0.1:3032/health"),
  probe("http://127.0.0.1:3033/health"),
]);

// 3. טריות-יומן-העבודות (ראיה ראשונית: END אחרון)
let lastEndAgeMin = null;
try {
  const lines = readFileSync(JOBS, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"phase":"end"')) continue;
    try { const r = JSON.parse(lines[i]); if (r.finishedAt) { lastEndAgeMin = Math.round(ageSec(Date.parse(r.finishedAt)) / 60); break; } } catch {}
  }
} catch {}

// 4. היסטוריית-החייאות (הוכחה-ציבורית שההחייאה-העצמית קורית באמת)
let revive = { count: 0, last: null };
try {
  const log = readFileSync(HB_LOG, "utf8");
  const hits = log.split("\n").filter((l) => l.includes("REVIVE"));
  revive = { count: hits.length, last: hits.length ? hits[hits.length - 1].slice(0, 120) : null };
} catch {}

const coreAlive = probes.heartbeatPid && probes.heartbeatLog;
const nodesAlive = probes.runner && probes.web && probes.ledger && probes.market;
const verdict = coreAlive && nodesAlive ? "SUPERVISION-OK" : "SUPERVISION-BROKEN";
const record = { at, verdict, pid, pidAlive: probes.heartbeatPid, heartbeatLogFreshSec: probes.heartbeatLog ? "<300" : "stale/none", probes, lastEndAgeMin, revive };
const tmp = join(DATA, "heartbeat.json.tmp");
writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
renameSync(tmp, join(DATA, "heartbeat.json"));
appendFileSync(join(DATA, "watchdog.jsonl"), JSON.stringify(record) + "\n");

console.log(`WATCHDOG: ${verdict} · pid=${pid?.toString() ?? "none"}(${probes.heartbeatPid ? "alive" : "dead"}) · hb-log=${probes.heartbeatLog ? "fresh" : "stale"} · runner=${probes.runner} web=${probes.web} ledger=${probes.ledger} market=${probes.market} · journal-lastEND=${lastEndAgeMin ?? "none"}min · revives=${revive.count}${revive.last ? ` (last: ${revive.last})` : ""}`);

// הפעלה-עצמית: יומן-דומם >180ד׳ בזמן-runner-חי = אין-פעילות-נראית — מעירים סוכן
if (probes.runner && lastEndAgeMin !== null && lastEndAgeMin > 180) {
  try {
    const r = await fetch("http://127.0.0.1:3031/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset: "ai-sentinel" }) });
    console.log(`WATCHDOG: self-activation — journal silent ${lastEndAgeMin}min while runner alive → ai-sentinel fired (${r.status})`);
  } catch (e) { console.error(`WATCHDOG: self-activation failed — ${String(e).slice(0, 120)}`); }
}

if (verdict === "SUPERVISION-BROKEN") {
  console.error("SUPERVISION-BROKEN: השגחה שבורה נמדדה — רועש בכוונה (fail-closed)");
  process.exit(1);
}
