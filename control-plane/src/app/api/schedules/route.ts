import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// GET /api/schedules — כל התזמונים מה-runner
export async function GET() {
  try {
    const res = await fetch(`${RUNNER}/schedules`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}

// POST /api/schedules — יצירת תזמון {preset, intervalSec} — ה-runner מאמת fail-closed
// Owner gate נאכף ב-runner; ה-console מעביר את ה-token בלבד.
export async function POST(req: Request) {
  try {
    const body = await req.text();
    const ownerToken = req.headers.get("x-owner-token");
    const res = await fetch(`${RUNNER}/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ownerToken ? { "x-owner-token": ownerToken } : {}) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
