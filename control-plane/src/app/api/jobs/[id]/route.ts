import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

// GET /api/jobs/:id — full job record: real stdout/stderr, exit code, duration
// Full output is owner-only at the runner (may carry secrets from logs);
// the console forwards the x-owner-token when the operator unlocked.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ownerToken = req.headers.get("x-owner-token");
  try {
    const res = await fetch(`${RUNNER}/jobs/${encodeURIComponent(id)}`, {
      headers: ownerToken ? { "x-owner-token": ownerToken } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}
