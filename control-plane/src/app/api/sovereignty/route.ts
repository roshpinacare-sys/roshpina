import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const LEDGER = "http://127.0.0.1:3032";
const RUNNER_DATA = "/home/z/my-project/mini-services/fleet-runner/data";

// GET /api/sovereignty — חוקי-הריבונות + זיכרון-הבעלים + יומן-החלטות + המטריצה, מהקרקע בלבד.
// אין המצאה: כל-קובץ-שלא-נקרא מדווח כחסר, לא כריק.
export async function GET() {
  const missing: string[] = [];

  const ledgerSovereignty = await fetch(`${LEDGER}/state?tenantId=market`, {
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { sovereignty?: Record<string, unknown> } | null) => d?.sovereignty ?? null)
    .catch(() => null);
  if (!ledgerSovereignty) missing.push("ledger:/state sovereignty");

  let decisions: Array<Record<string, unknown>> = [];
  try {
    const raw = await readFile(join(RUNNER_DATA, "sovereign", "decisions.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    decisions = lines.slice(-5).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    missing.push("council-journal");
  }

  let capability: { pass: number; fail: number; gaps: number; at: string | null } = { pass: 0, fail: 0, gaps: 0, at: null };
  try {
    const m = JSON.parse(await readFile(join(RUNNER_DATA, "ai", "capability-matrix.json"), "utf8")) as {
      capabilities?: Array<{ result?: string }>;
      gaps?: unknown[];
      generatedAt?: string;
      at?: string;
    };
    const caps = m.capabilities ?? [];
    capability = {
      pass: caps.filter((c) => c.result === "PASS").length,
      fail: caps.filter((c) => c.result !== "PASS").length,
      gaps: (m.gaps ?? []).length,
      at: m.generatedAt ?? m.at ?? null,
    };
  } catch {
    missing.push("capability-matrix");
  }

  return NextResponse.json(
    { sovereignty: ledgerSovereignty, decisions, capability, missing, at: new Date().toISOString() },
    { status: missing.length === 3 ? 502 : 200, headers: NO_STORE },
  );
}
