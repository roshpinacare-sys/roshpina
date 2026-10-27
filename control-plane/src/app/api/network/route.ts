import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

// GET /api/network — real probe of every node in the execution network (via fleet-runner)
export async function GET() {
  try {
    const res = await fetch(`${RUNNER}/nodes`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return NextResponse.json({ error: "runner_unhealthy", status: res.status }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}
