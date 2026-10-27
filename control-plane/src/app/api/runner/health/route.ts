import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// GET /api/runner/health — דופק-ה-runner החי: watchdog, tick, uptime, ספירות-ראיות
export async function GET() {
  try {
    const res = await fetch(`${RUNNER}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
