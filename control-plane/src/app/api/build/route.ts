import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const BUILD_DIR = "/home/z/my-project/mini-services/fleet-runner/data/build";

// GET /api/build — מה-הרשת בנתה ומה-היא בונה עכשיו. הדוח נבנה ע"י ה-site-builder
// (preset אמיתי ב-runner) מהנתונים החיים בלבד; כאן רק קוראים קבצים — אפס-סודות.
export async function GET() {
  try {
    let report: Record<string, unknown> | null = null;
    if (existsSync(`${BUILD_DIR}/night-report.json`)) {
      try {
        report = JSON.parse(readFileSync(`${BUILD_DIR}/night-report.json`, "utf8")) as Record<string, unknown>;
      } catch {
        report = null;
      }
    }

    let plan: Record<string, unknown> | null = null;
    if (existsSync(`${BUILD_DIR}/plan.json`)) {
      try {
        plan = JSON.parse(readFileSync(`${BUILD_DIR}/plan.json`, "utf8")) as Record<string, unknown>;
      } catch {
        plan = null;
      }
    }

    let cycles: number | null = null;
    if (existsSync(`${BUILD_DIR}/cycle.txt`)) {
      const n = Number(readFileSync(`${BUILD_DIR}/cycle.txt`, "utf8").trim());
      cycles = Number.isFinite(n) ? n : null;
    }

    return NextResponse.json({ report, plan, cycles }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "build_status_unavailable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
