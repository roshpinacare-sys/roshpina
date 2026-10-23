import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// PATCH /api/schedules/:id — הפעלה/השבתה {enabled: boolean}
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.text();
    const res = await fetch(`${RUNNER}/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}

// DELETE /api/schedules/:id — מחיקת תזמון
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(`${RUNNER}/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
