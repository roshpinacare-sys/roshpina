import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// PATCH /api/schedules/:id — הפעלה/השבתה {enabled: boolean}
// Owner gate נאכף ב-runner; ה-console מעביר את ה-token בלבד.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.text();
    const ownerToken = req.headers.get("x-owner-token");
    const res = await fetch(`${RUNNER}/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
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

// DELETE /api/schedules/:id — מחיקת תזמון
// Owner gate נאכף ב-runner; ה-console מעביר את ה-token בלבד.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ownerToken = req.headers.get("x-owner-token");
  try {
    const res = await fetch(`${RUNNER}/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: ownerToken ? { "x-owner-token": ownerToken } : {},
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
