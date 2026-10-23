import { NextResponse } from "next/server";

const RUNNER = "http://127.0.0.1:3031";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const AGENT_ID_PATTERN = "^[a-z][a-z0-9]{1,15}$";

// POST /api/agents/license — רישוי-סוכן חדש דרך ה-runner: זהות מקומית + רישום-חתום מול-השוק החי
export async function POST(req: Request) {
  let agentId = "";
  try {
    const body = (await req.json()) as { agentId?: string };
    agentId = String(body.agentId ?? "").trim();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  if (!new RegExp(AGENT_ID_PATTERN).test(agentId)) {
    return NextResponse.json({ error: "invalid_agent_id", pattern: AGENT_ID_PATTERN }, { status: 400, headers: NO_STORE });
  }
  try {
    const res = await fetch(`${RUNNER}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "agent-license", args: { agentId } }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: "runner_unreachable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
