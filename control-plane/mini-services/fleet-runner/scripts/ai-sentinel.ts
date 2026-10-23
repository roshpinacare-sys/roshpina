/**
 * ai-sentinel.ts — המוח-האינטליגנטי של הרשת הריבונית, מונע-NVIDIA NIM.
 *
 * קורא את מפתח-ה-API מהכספת-המקומית (data/vault/nim-api.env — אטום-בגיט,
 * נפתח-אוטונומית דרך vault-unseal.sh), מגייס את מצב-הרשת החי מכל-הצמתים
 * (שוק/ספר/runner/תזמונים), ושולח לנמוטרון לניתוח-מודיעיני אמיתי:
 * הערכה · סיכונים · אנומליות · המלצות. הפלט = ראיה מלאה (stdout) +
 * data/ai/latest-analysis.json עבור מטוס-הבקרה.
 *
 * fail-closed: אין-מפתח → exit 1 עם הודעה ברורה (הרשת ממשיכה בלי-AI, לא מדמה).
 * רץ: bun scripts/ai-sentinel.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const RUNNER_DIR = import.meta.dir.replace(/\/scripts$/, "");
const VAULT_FILE = `${RUNNER_DIR}/data/vault/nim-api.env`;
const AI_DIR = `${RUNNER_DIR}/data/ai`;
const MARKET = process.env.ECONOMY_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const RUNNER = "http://127.0.0.1:3031";

// ─── vault (fail-closed) ─────────────────────────────────────────────────────

if (!existsSync(VAULT_FILE)) {
  console.error("AI-SENTINEL-FAIL: vault sealed/absent — data/vault/nim-api.env לא נמצא.");
  console.error("  שחזור: bash scripts/vault-unseal.sh nim-api.env  (מהגיט, אוטונומית)");
  process.exit(1);
}
const env: Record<string, string> = {};
for (const line of readFileSync(VAULT_FILE, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const API_KEY = env.NVIDIA_API_KEY ?? "";
const BASE = env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
// Model order measured 2026-10-20 (super-120b 404 ×3; nano-omni succeeded) — see ai-architect.ts
const MODEL_PRIMARY = env.NVIDIA_MODEL_PRIMARY ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const MODEL_FALLBACK = env.NVIDIA_MODEL_FALLBACK ?? "nvidia/nemotron-3.5-lightning-30b-a3b"; // measured-alive 2026-10-21 (task 52 grill: super-120b 404-for-account ×2, lightning 200 ×1)
if (!API_KEY.startsWith("nvapi-")) {
  console.error("AI-SENTINEL-FAIL: vault key invalid (expected nvapi-* prefix) — fail-closed");
  process.exit(1);
}

// ─── live network state (honest gathering; partial truth is labeled) ────────

const get = async (url: string, ms = 4000): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

console.log(`AI-SENTINEL: gathering live network state…`);
const marketH = await get(`${MARKET}/health`);
const econ = await get(`${MARKET}/economy/report`);
const ledgerH = await get(`${LEDGER}/health`);
const runnerH = await get(`${RUNNER}/health`);
const schedules = await get(`${RUNNER}/schedules`);

const µ = (v: unknown): string => {
  if (v == null) return "—";
  try {
    const n = BigInt(String(v));
    const sign = n < 0n ? "-" : "";
    const abs = (n < 0n ? -n : n).toString().padStart(3, "0");
    return `${sign}${abs.slice(0, -2) || "0"}.${abs.slice(-2)}`;
  } catch {
    return String(v);
  }
};

const stateLines: string[] = [];
stateLines.push(`time: ${new Date().toISOString()}`);

if (marketH) {
  stateLines.push(`market(:3033): trades=${marketH.trades} bids=${marketH.bids} asks=${marketH.asks} phantomsSkipped=${marketH.phantomsSkipped ?? 0}`);
} else stateLines.push("market(:3033): UNREACHABLE");

type AgentRow = { agentId: string; usds: string; usdsLocked: string; usdsStaked?: string; saos: string; saosLocked: string; fills: number };
if (econ) {
  const q = (econ.conservation as Record<string, Record<string, unknown>> | undefined)?.quote;
  const b = (econ.conservation as Record<string, Record<string, unknown>> | undefined)?.base;
  const agents = (econ.agents as AgentRow[] | undefined) ?? [];
  const ops = (econ.epochOps as { kind: string; agentId: string; amount: string }[] | undefined) ?? [];
  stateLines.push(`economy: agents=${agents.length} treasury=${µ(q?.fees)} µ-USDS conservation: quote=${q?.holds ? "HOLDS" : "VIOLATED"} base=${b?.holds ? "HOLDS" : "VIOLATED"}`);
  for (const a of agents) {
    const total = BigInt(a.usds) + BigInt(a.usdsLocked) + BigInt(a.usdsStaked ?? "0");
    stateLines.push(`  agent ${a.agentId}: USDS ${µ(total.toString())} (staked ${µ(a.usdsStaked ?? "0")}) · SAOS ${µ((BigInt(a.saos) + BigInt(a.saosLocked)).toString())} · fills=${a.fills}`);
  }
  const recent = ops.slice(-6);
  if (recent.length) stateLines.push(`  epoch-ops (recent): ${recent.map((o) => `${o.kind}:${o.agentId}:${µ(o.amount)}`).join(" · ")}`);
} else stateLines.push("economy: UNREACHABLE");

if (ledgerH) {
  stateLines.push(`ledger(:3032): seq=${ledgerH.seq} accounts=${ledgerH.accounts} operatorKeys=${ledgerH.operatorKeys}`);
} else stateLines.push("ledger(:3032): UNREACHABLE");

if (runnerH) {
  const wd = runnerH.watchdog as { healCount?: number; lastResult?: string } | undefined;
  stateLines.push(`runner(:3031): jobs=${runnerH.jobsTotal} schedules=${runnerH.schedulesCount} tick=${runnerH.tickCount} tickError=${runnerH.tickError ?? "none"} watchdog-heals=${wd?.healCount ?? "?"}`);
} else stateLines.push("runner(:3031): UNREACHABLE");

if (schedules) {
  const list = (schedules.schedules as { presetId: string; intervalSec: number; enabled: boolean; runCount: number; failCount: number; skippedCount: number; lastStatus: string }[] | undefined) ?? [];
  for (const s of list) {
    stateLines.push(`  schedule ${s.presetId}/${s.intervalSec}s: enabled=${s.enabled} runs=${s.runCount} fails=${s.failCount} skipped=${s.skippedCount} last=${s.lastStatus}`);
  }
} else stateLines.push("schedules: UNREACHABLE");

const state = stateLines.join("\n");
console.log("--- network state ---\n" + state + "\n---------------------");

// ─── NVIDIA NIM call (OpenAI-compatible; primary → fallback) ────────────────

const SYSTEM = `אתה הסנטינל של צי-ריבוני אוטונומי (SAOS) — רשת סוכנים שסוחרת בשוק-פנימי חתום, עם ספר-מתמיד, מיסים, שכר, סטייקינג, תזמונים-עצמיים וגיבויים-עצמיים לגיט.
תפקידך: ניתוח-מודיעיני קצר, חד וכנה של מצב-הרשת מהנתונים החיים שמסרו לך.
ענה בעברית, במבנה קבוע בדיוק כך:
הערכה: <2-3 משפטים — מה מצב הרשת עכשיו>
סיכונים: <עד 3, מדורגים, קונקרטיים לנתונים; אם אין — "אין סיכונים בולטים">
אנומליות: <משהו שנראה חריג במספרים — או "לא זוהו">
המלצות: <עד 3 פעולות מעשיות לשיפור/הרחבה>
היו כנים: אם צומת UNREACHABLE — זה בעצמו ממצא. אל תמציא נתונים שאינם לפניך.`;

const callNIM = async (model: string, maxTokens: number): Promise<{ content: string; latencyMs: number }> => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `מצב-הרשת החי עכשיו:\n\n${state}` },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`http ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("empty content (reasoning budget exhausted?)");
  return { content, latencyMs: Date.now() - t0 };
};

let analysis = "";
let model = MODEL_PRIMARY;
let latencyMs = 0;
try {
  console.log(`AI-SENTINEL: calling NVIDIA NIM (${MODEL_PRIMARY})…`);
  const r = await callNIM(MODEL_PRIMARY, 2600);
  analysis = r.content;
  latencyMs = r.latencyMs;
} catch (e) {
  console.error(`AI-SENTINEL: primary model failed (${String(e).slice(0, 160)}) — falling back to ${MODEL_FALLBACK}`);
  try {
    model = MODEL_FALLBACK;
    const r = await callNIM(MODEL_FALLBACK, 1400);
    analysis = r.content;
    latencyMs = r.latencyMs;
  } catch (e2) {
    console.error(`AI-SENTINEL-FAIL: both models failed — ${String(e2).slice(0, 200)}`);
    process.exit(1);
  }
}

console.log(`AI-SENTINEL-OK: model=${model} latency=${latencyMs}ms`);
console.log("--- analysis ---");
console.log(analysis);
console.log("--- end ---");

mkdirSync(AI_DIR, { recursive: true });
const record = {
  generatedAt: new Date().toISOString(),
  model,
  latencyMs,
  vaultSealed: true,
  analysis,
  networkState: state,
};
writeFileSync(`${AI_DIR}/latest-analysis.json`, JSON.stringify(record, null, 2) + "\n");
console.log(`AI-SENTINEL: evidence saved → data/ai/latest-analysis.json`);
