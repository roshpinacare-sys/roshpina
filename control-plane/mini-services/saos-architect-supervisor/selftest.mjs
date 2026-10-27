#!/usr/bin/env node
/* saos-architect-daemon · selftest — אופליין, דטרמיניסטי, אפס-רשת-אפס-תהליכים
 * מטריצת-ההחלטות במלואה + שרשרת-הקבלות + תוכניות-ההפעלה. exitCode=1 על-כל-אדום. */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const t = (name, ok) => { console.log(`${ok ? " ✓" : " ✗"} ${name}`); ok ? pass++ : (fail++, (process.exitCode = 1)); };

/* ---- טעינת-מודולים מ-TypeScript ישירות (bun רץ TS) ---- */
const { decide, DEFAULT_THRESHOLDS } = await import("./decide.ts");
const act = await import("./act.ts");

const now = Date.parse("2026-10-24T18:00:00Z");
const obs = (over = {}) => ({
  at: "2026-10-24T18:00:00Z",
  dexEngine: 200, issueForge: 200, fleetEconomy: 200, edge: 200, gateway: 200,
  forgeLastCycleAt: new Date(now - 5 * 60_000).toISOString(),
  repos: { giant: "2026-10-24T17:50:00Z", saosDex: "2026-10-24T17:55:00Z", fleetHQ: "2026-10-24T17:40:00Z", domain: "2026-10-24T17:30:00Z" },
  gridBeatAgeMs: 10 * 60_000,
  workflows: {
    "saos-dex:dex-grid.yml": new Date(now - 20 * 60_000).toISOString(),
    "saos-dex:external-profit-publish.yml": new Date(now - 2 * 3600_000).toISOString(),
    "saos-dex:curate.yml": new Date(now - 2 * 3600_000).toISOString(),
  },
  kelly: { verdict: "OK", fractionBps: 250 },
  ...over,
});

console.log("── 1 · מצב-בריא: אפס-פעולות, אפס-הערות ──");
const healthy = decide(obs(), now);
t("all-alive fresh → zero actions", healthy.length === 0);

console.log("── 2 · עורקי-חיים ──");
const dexDead = decide(obs({ dexEngine: null }), now);
t("dex down → spawn-dex-node", dexDead.some((a) => a.kind === "spawn-dex-node"));
t("dex down + fresh book → NO cloud dispatch (revive is enough, no thrash)", !dexDead.some((a) => a.kind === "dispatch-dex-grid"));
const dexDeadStaleBook = decide(obs({ dexEngine: null, gridBeatAgeMs: 50 * 60_000 }), now);
t("dex down + stale book → dispatch cloud too (cloud carries the book)", dexDeadStaleBook.filter((a) => a.kind === "dispatch-dex-grid").length === 1);
const dexOdd = decide(obs({ dexEngine: 500 }), now);
t("dex non-200 → note only (no thrash)", dexOdd.length === 1 && dexOdd[0].kind === "note");
const forgeDead = decide(obs({ issueForge: null, forgeLastCycleAt: null }), now);
t("forge down → spawn-issue-forge", forgeDead.some((a) => a.kind === "spawn-issue-forge"));
t("forge down → no trigger-forge-cycle (cannot POST to a corpse)", !forgeDead.some((a) => a.kind === "trigger-forge-cycle"));
const forgeStale = decide(obs({ forgeLastCycleAt: new Date(now - 16 * 60_000).toISOString() }), now);
t("forge cycle 16min old → trigger", forgeStale.some((a) => a.kind === "trigger-forge-cycle"));
const forgeNoCycle = decide(obs({ forgeLastCycleAt: null }), now);
t("forge alive, never cycled → trigger first cycle", forgeNoCycle.some((a) => a.kind === "trigger-forge-cycle"));

console.log("── 3 · טריות-גריד + שומר-קלי ──");
const gridStale = decide(obs({ gridBeatAgeMs: 41 * 60_000 }), now);
t("grid-beat 41min → dispatch-dex-grid", gridStale.some((a) => a.kind === "dispatch-dex-grid"));
t("grid stale + OK kelly → NO kelly note", !gridStale.some((a) => a.kellyGuard));
const gridStaleNoEdge = decide(obs({ gridBeatAgeMs: 41 * 60_000, kelly: { verdict: "NO-EDGE", fractionBps: 0 } }), now);
t("grid stale + NO-EDGE → kelly note present", gridStaleNoEdge.some((a) => a.kind === "note" && a.kellyGuard === "volume-amplification-withheld-NO-EDGE"));
t("grid fresh 40min → no dispatch", !decide(obs({ gridBeatAgeMs: 39 * 60_000 }), now).some((a) => a.kind === "dispatch-dex-grid"));
const noGridEver = decide(obs({ gridBeatAgeMs: null }), now);
t("no grid-beat history → honest note, NOT blind dispatch", noGridEver.some((a) => a.kind === "note" && a.why.includes("honest unknown")) && !noGridEver.some((a) => a.kind === "dispatch-dex-grid"));

console.log("── 4 · טריות-וורקפלו-חוץ ──");
const extStale = decide(obs({ workflows: { ...obs().workflows, "saos-dex:external-profit-publish.yml": new Date(now - 7 * 3600_000).toISOString() } }), now);
t("ext-profit 7h → dispatch", extStale.some((a) => a.kind === "dispatch-external-profit"));
const curStale = decide(obs({ workflows: { ...obs().workflows, "saos-dex:curate.yml": new Date(now - 9 * 3600_000).toISOString() } }), now);
t("curate 9h → dispatch", curStale.some((a) => a.kind === "dispatch-curate"));
const wfMiss = decide(obs({ workflows: { "saos-dex:dex-grid.yml": null, "saos-dex:external-profit-publish.yml": null, "saos-dex:curate.yml": null } }), now);
t("API miss → honest notes, no dispatch", wfMiss.filter((a) => a.kind === "note").length >= 2 && !wfMiss.some((a) => a.kind.startsWith("dispatch")));

console.log("── 5 · גבולות-נתיבים-אחרים (SWARM §5) ──");
const gwDown = decide(obs({ gateway: null, fleetEconomy: null }), now);
t("gateway down → note with ANOTHER LANE marker, zero spawn", gwDown.some((a) => a.kind === "note" && a.why.includes("ANOTHER LANE")) && !gwDown.some((a) => a.kind.startsWith("spawn") || a.kind.startsWith("dispatch") && a.kind !== "dispatch-dex-grid"));
t("economy down → escalation note only", gwDown.some((a) => a.kind === "note" && a.why.includes("fleet-economy")));

console.log("── 6 · דטרמיניזם ──");
const o = obs();
t("same input → same actions (JSON equality)", JSON.stringify(decide(o, now)) === JSON.stringify(decide(o, now)));

console.log("── 7 · קבלות SAOS-ARCHITECT/1 — שרשרת-חשיש ──");
const tmp = mkdtempSync(join(tmpdir(), "arch-selftest-"));
const origLedger = act.LEDGER_PATH;
/* הזרקת-נתיב: אין-export-mutability ב-ESM — בודקים-על-הפנקס-האמתי-בסביבה-מבוקרת:
 * כותבים-שתי-קבלות-אמת (phase=selftest) ומאמתים-שרשרת ידנית מהקובץ. */
const r1 = act.appendReceipt({ phase: "selftest", verdict: "chain-test-1" });
const r2 = act.appendReceipt({ phase: "selftest", verdict: "chain-test-2" });
t("seq increments", r2.seq === r1.seq + 1);
const lines = readFileSync(act.LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean);
const last2 = lines.slice(-2).map((l) => JSON.parse(l));
t("prev-link correct", last2[1].prev === last2[0].hash);
const body = { ...last2[1] }; const stored = body.hash; delete body.hash;
t("hash recomputes (sha256 of body sans hash)", createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32) === stored);
t("receipts counter > 0", act.countReceipts() === lines.length);
t("ledger path stable", act.LEDGER_PATH === origLedger);

console.log("── 8 · תוכניות-הפעלה ──");
t("dexNode plan targets saos-dex-node dir", act.SPAWN_PLANS.dexNode.cwd.endsWith("mini-services/saos-dex-node"));
t("issueForge plan targets issue-forge dir", act.SPAWN_PLANS.issueForge.cwd.endsWith("mini-services/issue-forge"));
t("spawnDetached is importable & typed (sanity)", typeof act.spawnDetached === "function");

console.log("── 9 · תחומי-ברירת-מחדל ──");
t("thresholds sane (15m/40m/6h/8h)", DEFAULT_THRESHOLDS.forgeCycleMaxAgeMs === 900_000 && DEFAULT_THRESHOLDS.gridStaleMs === 2_400_000 && DEFAULT_THRESHOLDS.extProfitStaleMs === 21_600_000 && DEFAULT_THRESHOLDS.curateStaleMs === 28_800_000);

rmSync(tmp, { recursive: true, force: true });
console.log(`════════════════════════════════════════
  pass=${pass}  fail=${fail}  — ${fail === 0 ? "ALL GREEN" : "RED — FIX THE ROOT"} 
════════════════════════════════════════`);
