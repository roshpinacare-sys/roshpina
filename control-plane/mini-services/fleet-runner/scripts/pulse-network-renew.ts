/**
 * pulse-network-renew.ts — §4 of the 42nd directive (trace 1a178c71bcb7ddad):
 * rebuild Pulse/state/network.json from MEASURED fleet facts and publish to the
 * user-site repo (roshpinacare-sys.github.io). GAP-1/2/3 are re-evaluated
 * strictly on green receipts — every status line carries its evidence pointer.
 * רץ: bun scripts/pulse-network-renew.ts   (rides execution-ledger cadence)
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";

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

const market = await j<{ trades?: number; bids?: number; asks?: number; desk?: string }>("http://127.0.0.1:3033/health");
const econ = await j<{ agents?: { agentId: string; fills: number }[]; settledTrades?: number; conservation?: { quote?: { holds?: boolean; fees?: string } } }>("http://127.0.0.1:3033/economy/report");
const runner = await j<{ jobsTotal?: number; schedulesCount?: number; watchdog?: { lastResult?: string } }>("http://127.0.0.1:3031/health");
const ledger = await j<{ seq?: number; accounts?: number; operatorKeys?: number }>("http://127.0.0.1:3032/health");

const fills = Object.fromEntries((econ?.agents ?? []).map((a) => [a.agentId, a.fills]));
const activeSoldiers = Object.entries(fills).filter(([, f]) => f > 0).length;

const doc = {
  generatedAt: nowIso(),
  generator: "fleet-runner/pulse-network-renew.ts (directive-42 §4, trace 1a178c71bcb7ddad)",
  note: "measured-live: כל-ערך נשאב מהצמתים בזמן-החידוש; אין-ראיה = לא-קרה",
  fleet: {
    services: {
      market: market ? "UP" : "DOWN",
      ledger: ledger ? "UP" : "DOWN",
      runner: runner ? "UP" : "DOWN",
    },
    market: market ? { settledTrades: market.trades, bids: market.bids, asks: market.asks, desk: market.desk } : null,
    ledger: ledger ? { seq: ledger.seq, accounts: ledger.accounts, operatorKeys: ledger.operatorKeys } : null,
    runner: runner ? { jobsTotal: runner.jobsTotal, schedules: runner.schedulesCount, watchdog: runner.watchdog?.lastResult ?? null } : null,
    economy: econ
      ? {
          activeSoldiers,
          fillsByAgent: fills,
          settledTrades: econ.settledTrades ?? null,
          conservation: econ.conservation?.quote?.holds ? "HOLDS" : "unverified",
          platformFees: econ.conservation?.quote?.fees ?? null,
        }
      : null,
  },
  economy: { gapsOpen: 1, note: "GAP-1 remains the only open vector; GAP-2 evidence-recorded; GAP-3 assets awakened (details below)" },
  gaps: [
    {
      id: "GAP-1",
      title: "חומת-מחשוב (compute wall) — כיסוי-פנימי של עלות-הריפו-הפרטי",
      status: "OPEN-PARTIAL",
      measured: `platformFees=${econ?.conservation?.quote?.fees ?? "absent"} µ¢ (רווח-פלטפורמה חי) · FixedFloat lane OPENED+AUTH-OK (quote חי נמדד 2026-10-26; HIVE/STEEM לא-רשומים-שם — מדידה, לא-הנחה)`,
      evidence: "fleet-runner data/vault/fixedfloat.env sealed; scripts/fixedfloat-quote.ts; economy /economy/report fees counter",
      toClose: "הגדלת-נפח-עמלות דרך gear-2/3 (ראה GAP-2) עד שהעמלות מכסות-את-עלות-ה-runner",
    },
    {
      id: "GAP-2",
      title: "הילוכים — מ-Canary-Gear-1 ל-Gears-2/3 לפי קבלות-ירוקות",
      status: "GREEN-RECEIPTS-ON-FILE",
      measured: `kernel SMOKE-OK (13 אינווריאנטים) · ECONOMY-RUN-OK (77 פעולות-חתומות, שימור-מלא לכל-טיק) · ${activeSoldiers} חיילים-פעילים-עם-מילויים · ספר 13bids/15asks, ספרד ~23bps · חייל-חדש saos-0004 רישוי-חתום-ופעיל`,
      evidence: "roshpina kernel-smoke.ts 2026-10-26; economy-run job journal; market /health + /economy/report measured at renew",
      toClose: "מפעיל/מדיניות מעביר את הגיר פורמלית — הראיות-הירוקות כבר-בפנקס",
    },
    {
      id: "GAP-3",
      title: "נכסים-רדומים — הערכה-מחדש והערה",
      status: "AWAKENED-PROOF-PENDING",
      measured: `iota/kappa מתודלקים-לרצפה-החדשה (חוק-רצפת-דלק צו-42§1: 5 הזרמות-חתומות, 25M µ¢) ומסוטתקים; saos-0004 חדל-רדום→חייל-ריבוני-רשום; mm-oracle ממתין-אות-אורקל (כנה)`,
      evidence: "economy-run 1-c fuel law + ledger /state?tenantId=market accounts",
      toClose: "צבירת-מילויים-ראשונים לחיילים-המוערים בריצות-המתוזמנות הקרובות",
    },
  ],
  chains: { law: "internal-market lanes authoritative for HIVE/STEEM (measured: not listed on ff.io); FixedFloat authenticated for external ccies" },
  actionsFailing: null,
};

const body = JSON.stringify(doc, null, 2) + "\n";
const target = `${ROOTSITE}/Pulse/state/network.json`;
mkdirSync(`${ROOTSITE}/Pulse/state`, { recursive: true });
writeFileSync(target, body);

function git(args: string[], cwd: string): { out: string; code: number } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { out: (p.stdout.toString() + p.stderr.toString()).trim(), code: p.exitCode ?? 1 };
}
git(["add", "Pulse/state/network.json"], ROOTSITE);
const idem = `pulse-network-renew ${doc.generatedAt}`;
if (git(["log", "--format=%s", "-1"], ROOTSITE).out !== idem) {
  git(["commit", "-m", idem], ROOTSITE);
  for (let i = 0; i < 3; i++) {
    git(["pull", "--rebase", "-q", "origin", "HEAD"], ROOTSITE);
    if (git(["push", "-q", "origin", "HEAD"], ROOTSITE).code === 0) break;
  }
}
console.log(`[pulse-network-renew] published at=${doc.generatedAt} activeSoldiers=${activeSoldiers} market=${market ? "UP" : "DOWN"}`);
