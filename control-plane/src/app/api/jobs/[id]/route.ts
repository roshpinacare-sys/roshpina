import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

// GET /api/jobs/:id — full job record: real stdout/stderr, exit code, duration
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${RUNNER}/jobs/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}
