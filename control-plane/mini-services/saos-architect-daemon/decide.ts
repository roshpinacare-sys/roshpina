/* saos-architect-daemon · decide.ts — מוח-הארכיטקט (טהור, דטרמיניסטי, נבדק-במלואו)
 * קלט: תצפית. פלט: רשימת-פעולות-מסודרת-עם-נימוקים. אפס-IO — אפס-הפתעות.
 * חוק-קלי (§2 STRICT KELLY-SAFE): נוכחות-ספר-נשמרת גם-ב-NO-EDGE (עשיית-שוק =
 * תפקיד), אבל הגדלת-נפח על-שוליים-שליליים נמנעת-מפורשות ומתועדת. */
import type { Observation } from "./observe";

export type ActionKind =
  | "spawn-dex-node"          // מפקח-הדקס (ריפוי-עצמי-מהגיט, מסרב-כפילות)
  | "spawn-issue-forge"       // לולאת-issue-to-PR (§4)
  | "trigger-forge-cycle"     // POST /cycle אם-המחזור-ישן
  | "dispatch-dex-grid"       // וורקפלו-ענן כשהגריד-ישן
  | "dispatch-external-profit"
  | "dispatch-curate"
  | "note";                   // תצפית/אסקלציה — בלי-יד (נתיב-אחר)

export interface Action {
  kind: ActionKind;
  why: string;
  kellyGuard?: "volume-amplification-withheld-NO-EDGE";
}

export interface Thresholds {
  forgeCycleMaxAgeMs: number;   // ברירת-מחדל 15 דק'
  gridStaleMs: number;          // ברירת-מחדל 40 דק'
  extProfitStaleMs: number;     // ברירת-מחדל 6 שע'
  curateStaleMs: number;        // ברירת-מחדל 8 שע'
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  forgeCycleMaxAgeMs: 15 * 60_000,
  gridStaleMs: 40 * 60_000,
  extProfitStaleMs: 6 * 3600_000,
  curateStaleMs: 8 * 3600_000,
};

export function decide(o: Observation, now = Date.now(), th: Thresholds = DEFAULT_THRESHOLDS): Action[] {
  const out: Action[] = [];

  /* 1 · עורקי-חיים: מנוע-הדקס קודם (כל-השאר ניזון-ממנו) */
  if (o.dexEngine === null) out.push({ kind: "spawn-dex-node", why: "dex engine :3010 unreachable — revive supervisor (self-heal-from-git, duplicate-refusing)" });
  else if (o.dexEngine !== 200) out.push({ kind: "note", why: `dex engine answered ${o.dexEngine} (non-200) — observing next beat before action (avoid thrash)` });

  /* 2 · לולאת-הבנייה-העצמית (§4) */
  if (o.issueForge === null) out.push({ kind: "spawn-issue-forge", why: "issue-forge :3046 down — spawn detached (port 3046)" });
  else {
    const t = o.forgeLastCycleAt ? Date.parse(o.forgeLastCycleAt) : NaN;
    if (!Number.isFinite(t)) out.push({ kind: "trigger-forge-cycle", why: "issue-forge alive but no cycle recorded — kick first cycle" });
    else if (now - t > th.forgeCycleMaxAgeMs) out.push({ kind: "trigger-forge-cycle", why: `last forge cycle ${Math.round((now - t) / 60000)}min ago > ${th.forgeCycleMaxAgeMs / 60000}min — trigger bounded cycle` });
  }

  /* 3 · טריות-הגריד (§2): ספר-חי = חובה; הגדלת-נפח כפופה-לקלי */
  if (o.gridBeatAgeMs === null) out.push({ kind: "note", why: "no grid-beat commit found in saos-dex — honest unknown (first-run or history gone); not dispatching blind" });
  else if (o.gridBeatAgeMs > th.gridStaleMs) {
    out.push({ kind: "dispatch-dex-grid", why: `last grid-beat ${Math.round(o.gridBeatAgeMs / 60000)}min ago > ${th.gridStaleMs / 60000}min — dispatch cloud grid` + (o.dexEngine === null ? " (engine also down — cloud carries the book)" : "") });
    if (o.kelly?.verdict === "NO-EDGE") out.push({ kind: "note", why: `Kelly verdict NO-EDGE (fractionBps=${o.kelly.fractionBps}) — volume amplification withheld; grid keeps policy cadence only, sizing kernel refuses negative edge`, kellyGuard: "volume-amplification-withheld-NO-EDGE" });
  }

  /* 4 · מדידה-וקיורציה-חוץ (N4/N5) */
  const wf = (k: string) => {
    const iso = o.workflows[k];
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? now - t : null;
  };
  const extAge = wf("saos-dex:external-profit-publish.yml");
  if (extAge === null) out.push({ kind: "note", why: "external-profit-publish last-run unknown (API miss) — will retry next beat" });
  else if (extAge > th.extProfitStaleMs) out.push({ kind: "dispatch-external-profit", why: `last external-profit run ${Math.round(extAge / 3600000)}h ago > ${th.extProfitStaleMs / 3600000}h — dispatch measurement` });
  const curAge = wf("saos-dex:curate.yml");
  if (curAge === null) out.push({ kind: "note", why: "curate last-run unknown (API miss) — will retry next beat" });
  else if (curAge > th.curateStaleMs) out.push({ kind: "dispatch-curate", why: `last curate run ${Math.round(curAge / 3600000)}h ago > ${th.curateStaleMs / 3600000}h — dispatch curation beat` });

  /* 5 · תצפיות-נתיבים-אחרים — איסור-מגע (SWARM §5/§8) */
  if (o.gateway === null) out.push({ kind: "note", why: "sovereign-gateway :3140 down — ANOTHER LANE'S claim (saos-control-center); observation only, no touch" });
  if (o.fleetEconomy === null) out.push({ kind: "note", why: "fleet-economy :3016 unreachable — organism/instrumentation lane owns resurrection; escalating in receipt only" });

  return out;
}
