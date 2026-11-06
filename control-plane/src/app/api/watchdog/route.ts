import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const HB = "/home/z/my-project/mini-services/fleet-runner/data/heartbeat.json";
const WD_JOURNAL = "/home/z/my-project/mini-services/fleet-runner/data/watchdog.jsonl";

// GET /api/watchdog — משגיח-החוץ (task 58, שיקום 63): דיסק-אמת בלבד.
// קורא את המדידה-האחרונה + ריכוז-החייאות מהיומן. אפס-סודות, אפס-חישוב-צד-לקוח.
export async function GET() {
  try {
    if (!existsSync(HB)) {
      return NextResponse.json({ error: "no_heartbeat_yet" }, { status: 404, headers: NO_STORE });
    }
    const hb = JSON.parse(readFileSync(HB, "utf8")) as Record<string, unknown>;
    // היסטוריית-החייאות: ספירה-מצטברת + האחרונה (מהמדידות-הקודמות — הראיה-הציבורית)
    let reviveCount = 0;
    let reviveLast: string | null = null;
    try {
      const lines = readFileSync(WD_JOURNAL, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as { revive?: { count?: number; last?: string | null } };
          if (typeof r.revive?.count === "number" && r.revive.count > reviveCount) {
            reviveCount = r.revive.count;
            reviveLast = r.revive.last ?? reviveLast;
          }
        } catch { /* שורה-פגומה */ }
      }
    } catch { /* אין-יומן עדיין */ }
    const revive = (hb.revive as { count?: number; last?: string | null } | undefined) ?? {};
    return NextResponse.json(
      {
        at: hb.at,
        verdict: hb.verdict,
        pid: hb.pid ?? null,
        pidAlive: hb.pidAlive ?? false,
        heartbeatLogFreshSec: hb.heartbeatLogFreshSec ?? "unknown",
        probes: hb.probes ?? {},
        lastEndAgeMin: hb.lastEndAgeMin ?? null,
        revive: { count: Math.max(reviveCount, revive.count ?? 0), last: revive.last ?? reviveLast },
      },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500, headers: NO_STORE });
  }
}
