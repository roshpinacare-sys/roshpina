import { NextRequest, NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

// GET /api/jobs — recent runs (summary) + available presets
export async function GET() {
  try {
    const [jobsRes, presetsRes] = await Promise.all([
      fetch(`${RUNNER}/jobs`, { cache: "no-store", signal: AbortSignal.timeout(8000) }),
      fetch(`${RUNNER}/presets`, { cache: "no-store", signal: AbortSignal.timeout(8000) }),
    ]);
    if (!jobsRes.ok || !presetsRes.ok) {
      return NextResponse.json({ error: "runner_unhealthy" }, { status: 502 });
    }
    const jobs = await jobsRes.json();
    const presets = await presetsRes.json();
    return NextResponse.json({ ...jobs, ...presets }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}

// POST /api/jobs { preset } — submit a real whitelisted job (fail-closed: presets only)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.preset !== "string") {
      return NextResponse.json({ error: "preset_required" }, { status: 400 });
    }
    const res = await fetch(`${RUNNER}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: body.preset }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}
