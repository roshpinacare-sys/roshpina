import { NextResponse } from "next/server";

const MARKET = "http://127.0.0.1:3033";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// GET /api/economy — דוח-הכלכלה הריבונית החי מצומת-השוק (קריאה-בלבד, אפס-סודות)
export async function GET() {
  try {
    const res = await fetch(`${MARKET}/economy/report`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "market_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
