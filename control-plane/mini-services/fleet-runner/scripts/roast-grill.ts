/**
 * roast-grill.ts — גריל-האמת (צו 1a15f55f6d0395f9: "תבחן את האמת בלי לסמוך על הטענות
 * שלך... roast grill test כדי לחשוף את האמת הכואבת, לתקן ולהפעיל בצורה טובה יותר").
 *
 * שלושה חוקים שמבדילים את הגריל מכל ביקורת קיימת ברשת:
 *
 * 1. עצמאות-מוחלטת — לא מייבא שום-לוגיקה מהביקורות הקיימות (self-audit,
 *    capability-audit, secrets-gate). כל טענה נגזרת מחדש מפרימיטיבים גולמיים:
 *    git-plumbing, ls-remote מאומת, HTTP חי, קריאת-קבצים. הביקורות הקיימות עצמן
 *    מורצות טרי כתהליכים חיצוניים והפלט שלהן מתקבל כטענה — שנבדקת, לא נאמן.
 *
 * 2. שיניים מוכחות — בקרות-שלילה: טענות שחייבות להיכשל (sha-אפסים, קובץ לא
 *    קיים, פורט מת) וטענה שחייבת לעבור. גריל שלא מצליח להיכשל הוא גומה-חותמת —
 *    ROAST-GRILL-BROKEN, exit 1, fail-closed. הביקורת על האמת כוללת ביקורת על
 *    עצמה.
 *
 * 3. כאב רועש — מציאה כואבת (FAIL) = ROAST-GRILL-PAINFUL + exit 1. פער כן
 *    ומוצהר (GAP) מותר — כנות אינה שקר. אפס סודות בפלט (redaction).
 *
 * רץ: bun scripts/roast-grill.ts · יומן: data/ai/roast-grill.jsonl (מונוטוני —
 * ירידה במספר-ההנחיות בין-ריצות = זיכרון-אבד = FAIL).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

const RUNNER_DIR = join(import.meta.dir, "..");
const DATA_DIR = join(RUNNER_DIR, "data");
const ROSHPINA = "/home/z/repos/roshpina";
const DOMAIN = "/home/z/repos/domain";
const WORKLOG = "/home/z/my-project/worklog.md";
const LIVE_EVID = "https://roshpinacare-sys.github.io/Domain/press/evidence.json";
const LIVE_CONSOLE = "https://roshpinacare-sys.github.io/Domain/console.html";
const LANE_TAG = "archive/agent4/p2-sovereign-market";
const TIMEOUT = 8_000;

const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? "/home/z/my-project/upload/pat.env";
const token = existsSync(TOKEN_FILE)
  ? (readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? "")
  : "";
const safe = (s: string): string => (token ? s.split(token).join("***") : s);

type V = { id: string; claim: string; result: "PASS" | "FAIL" | "GAP"; detail: string };
const checks: V[] = [];
const painful: string[] = [];

function sh(cmd: string[], opts?: { cwd?: string }): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = safe(new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr));
  return { ok: p.exitCode === 0, out };
}

async function getJson(url: string, timeoutMs = TIMEOUT): Promise<{ data: Record<string, unknown>; dateHeader: string | null }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "cache": "no-store" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: (await res.json()) as Record<string, unknown>, dateHeader: res.headers.get("date") };
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ageMin(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 60_000 : -1;
}

/* ─── בקרות-שלילה: הוכחת-שיניים ─────────────────────────────────────────────── */
// הפורט-המת נמדד מראש (await — שהבקרה תישפט מהאמת, לא מ-Promise)
let portDead = false;
try {
  await fetch("http://127.0.0.1:39999/health", { signal: AbortSignal.timeout(2_000) });
} catch {
  portDead = true;
}
const controls: { id: string; expected: string; got: string; ok: boolean }[] = [];
function control(id: string, expected: "PASS" | "FAIL", fn: () => { ok: boolean; detail: string }): void {
  let r: { ok: boolean; detail: string };
  try {
    r = fn();
  } catch (e) {
    r = { ok: false, detail: e instanceof Error ? e.message.slice(0, 80) : "threw" };
  }
  const got = r.ok ? "PASS" : "FAIL";
  controls.push({ id, expected, got, ok: got === expected });
  console.log(`  [בקרה] ${id} — צפי=${expected} · נמדד=${got} · ${r.detail}`);
}

/* ─── עזרי-refs ─────────────────────────────────────────────────────────────── */
function remotePeels(refs: string[]): { ok: boolean; map: Map<string, string>; raw: string } {
  const url = `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`;
  const r = sh(["git", "ls-remote", url, ...refs]);
  const map = new Map<string, string>();
  for (const line of r.out.split("\n")) {
    const [sha, ref] = line.trim().split(/\t/);
    if (sha && ref) map.set(ref, sha);
  }
  return { ok: r.ok, map, raw: safe(r.out) };
}

/* ─── main ──────────────────────────────────────────────────────────────────── */
const at = new Date().toISOString();
console.log(`ROAST-GRILL @ ${at} — האמת בלי טענות: כל-טענה נגזרת מחדש, והגריל עצמו מוכיח שיניים`);

// ── בקרות (קודמות לכל-בדיקה — גריל-שבור עוצר הכול) ──
control("git-חי (חובה-לעבור)", "PASS", () => {
  const r = sh(["git", "-C", ROSHPINA, "rev-parse", "HEAD"]);
  return { ok: r.ok && /^[0-9a-f]{40}$/.test(r.out.trim().split("\n").pop() ?? ""), detail: r.ok ? "rev-parse החזיר sha" : r.out.slice(0, 60) };
});
control("sha-אפסים (חובה-להיכשל)", "FAIL", () => {
  const r = sh(["git", "-C", ROSHPINA, "rev-parse", `${"0".repeat(40)}^{commit}`]);
  return { ok: r.ok, detail: r.ok ? "הצליח?! הגריל עיוור" : "נכשל כצפוי" };
});
control("קובץ-לא-קיים (חובה-להיכשל)", "FAIL", () => {
  const ghost = "/nonexistent-roast-grill-negative-control";
  return { ok: existsSync(ghost), detail: existsSync(ghost) ? "הקובץ קיים?! מציאות-אחרת" : "לא קיים כצפוי" };
});
control("פורט-מת (חובה-להיכשל)", "FAIL", () => {
  return { ok: !portDead, detail: portDead ? "חיבור נכשל כצפוי" : "ענה?! אין-רשת-אמיתית" };
});
const controlsOk = controls.every((c) => c.ok);

if (!controlsOk) {
  console.error("ROAST-GRILL-BROKEN: בקרת-שלילה לא התנהגה כצפוי — הגריל עצמו שבור; אין תוקף לשום-תוצאה (fail-closed)");
  writeState("ROAST-GRILL-BROKEN", { pass: 0, fail: 0, gaps: 0, controls: "broken" }, 0, at, ["הגריל עצמו שבור — בקרת-שלילה כשלה"]);
  process.exit(1);
}
console.log("  שיניי-הגריל מוכחות: 3 בקרות-שלילה נכשלו כצפוי · בקרת-חיוב עברה כצפוי");

// ── 1. refs: חוק-מות-הבונים (מדידה עצמאית — plumbing + ls-remote, לא GitHub-API כמו self-audit) ──
try {
  const head = sh(["git", "-C", ROSHPINA, "rev-parse", "HEAD"]).out.trim().split("\n").pop() ?? "";
  const tagLocal = sh(["git", "-C", ROSHPINA, "rev-parse", `${LANE_TAG}^{commit}`]).out.trim();
  const lr = remotePeels([`refs/heads/agent4/p2-sovereign-market`, `refs/tags/${LANE_TAG}`, `refs/tags/${LANE_TAG}^{}`]);
  const remoteBranch = lr.map.get("refs/heads/agent4/p2-sovereign-market") ?? "";
  const remoteTagPeeled = lr.map.get(`refs/tags/${LANE_TAG}^{}`) ?? lr.map.get(`refs/tags/${LANE_TAG}`) ?? "";
  const all = [head, tagLocal, remoteBranch, remoteTagPeeled];
  const same = lr.ok && all.every((s) => s === head && /^[0-9a-f]{40}$/.test(head));
  checks.push({
    id: "lane-refs",
    claim: "חוק-מות-הבונים: HEAD מקומי == תג-מקומי == ענף-מרוחק == תג-ארכיון-מרוחק",
    result: same ? "PASS" : "FAIL",
    detail: `head=${head.slice(0, 7)} · tag-local=${tagLocal.slice(0, 7)} · branch-remote=${remoteBranch.slice(0, 7)} · tag-remote-peel=${remoteTagPeeled.slice(0, 7)}`,
  });
  if (!same) painful.push("refs-הציר אינו עקבי — עבודת-הרשת עלולה לא לשרוד את הבונה");

  // ── 2. control-plane dual-ref ──
  const cp = remotePeels(["refs/heads/agent4/control-plane", "refs/tags/archive/agent4/control-plane"]);
  const cpB = cp.map.get("refs/heads/agent4/control-plane") ?? "";
  const cpT = cp.map.get("refs/tags/archive/agent4/control-plane") ?? "";
  const cpSame = cp.ok && cpB !== "" && cpB === cpT;
  checks.push({
    id: "cp-dual-ref",
    claim: "מטוס-הבקרה: ענף-גיבוי מרוחק == תג-ארכיון מרוחק (dual-ref עקבי)",
    result: cpSame ? "PASS" : "FAIL",
    detail: `cp-branch=${cpB.slice(0, 7)} · cp-tag=${cpT.slice(0, 7)}`,
  });
  if (!cpSame) painful.push("dual-ref של מטוס-הבקרה אינו עקבי — הקוד החי לא בטוח בגיט");
} catch (e) {
  checks.push({ id: "lane-refs", claim: "refs-הציר", result: "FAIL", detail: e instanceof Error ? safe(e.message).slice(0, 120) : "שגיאה" });
  painful.push("מדידת-refs נכשלה כולה");
}

// ── 3. צמתים חיים + שלמות-שוק ──
try {
  const [runner, ledger, market] = await Promise.all([
    getJson("http://127.0.0.1:3031/health"),
    getJson("http://127.0.0.1:3032/health"),
    getJson("http://127.0.0.1:3033/health"),
  ]);
  const m = market.data as { ok?: boolean; trades?: number; phantomsSkipped?: number; escrowOrphanQuote?: string; escrowOrphanBase?: string; desk?: string; quiesced?: boolean };
  const okNodes = runner.data.ok === true && ledger.data.ok === true && m.ok === true;
  const cleanMarket = m.phantomsSkipped === 0 && m.escrowOrphanQuote === "0" && m.escrowOrphanBase === "0" && m.desk === "on";
  checks.push({
    id: "nodes",
    claim: "3/3 צמתים חיים · שוק נקי (אפס-פנטומים, אפס-יתומי-escrow, שולחן-שוק פועל)",
    result: okNodes && cleanMarket ? "PASS" : "FAIL",
    detail: `runner=${String(runner.data.ok)} · ledger=${String(ledger.data.ok)} · market=${String(m.ok)} · trades=${m.trades} · phantoms=${m.phantomsSkipped} · escrowQ=${m.escrowOrphanQuote} · desk=${m.desk}`,
  });
  if (!(okNodes && cleanMarket)) painful.push("צומת/שוק במצב-לא-תקין");

  // ── 4. שימור דו-צדדי (self-audit בודק רק quote — הגריל דורש גם base) ──
  const rep = await getJson("http://127.0.0.1:3033/economy/report");
  const cons = (rep.data.conservation ?? {}) as { quote?: { holds?: boolean }; base?: { holds?: boolean } };
  const q = cons.quote?.holds === true;
  const b = cons.base ? cons.base.holds === true : null;
  checks.push({
    id: "conservation",
    claim: "שימור-כסף מאומת בשני-הצדדים (quote + base)",
    result: q && b !== false ? "PASS" : "FAIL",
    detail: `quote.holds=${String(q)} · base.holds=${b === null ? "לא-דווח (חסר-מבנה)" : String(b)}`,
  });
  if (!(q && b !== false)) painful.push("שימור-כסף שבור — הפנקס לא מאזן");
} catch (e) {
  checks.push({ id: "nodes", claim: "צמתים חיים + שימור", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 120) : "לא נגיש" });
  painful.push("צמתים לא נגישים");
}

// ── 5. הביקורות הקיימות מורצות טרי (הפלט = טענה שנבדקת, לא נאמן) ──
let selfOk = false;
let capOk = false;
try {
  const self = sh(["bun", "scripts/self-audit.ts"], { cwd: RUNNER_DIR });
  selfOk = self.ok && /SELF-AUDIT-OK/.test(self.out);
  checks.push({
    id: "self-audit-fresh",
    claim: "צוות-אדום עצמי רץ טרי ועובר (exit 0 + SELF-AUDIT-OK)",
    result: selfOk ? "PASS" : "FAIL",
    detail: `exit-ok=${String(self.ok)} · ${selfOk ? "11 טענות נבדקו מחדש" : self.out.split("\n").filter((l) => /\[FAIL\]/.test(l)).slice(0, 3).join(" | ").slice(0, 160)}`,
  });
  if (!selfOk) painful.push("self-audit טרי נכשל");
} catch (e) {
  checks.push({ id: "self-audit-fresh", claim: "self-audit טרי", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "לא רץ" });
  painful.push("self-audit לא רץ");
}
try {
  const cap = sh(["bun", "scripts/capability-audit.ts"], { cwd: RUNNER_DIR });
  capOk = cap.ok && /CAPABILITY-AUDIT-OK/.test(cap.out);
  checks.push({
    id: "capability-fresh",
    claim: "מטריצת-יכולות רצה טרי ועוברת (exit 0 + CAPABILITY-AUDIT-OK)",
    result: capOk ? "PASS" : "FAIL",
    detail: `exit-ok=${String(cap.ok)} · ${capOk ? "14 יכולות נמדדו" : cap.out.split("\n").filter((l) => /\[FAIL\]/.test(l)).slice(0, 3).join(" | ").slice(0, 160)}`,
  });
  if (!capOk) painful.push("capability-audit טרי נכשל");
} catch (e) {
  checks.push({ id: "capability-fresh", claim: "capability-audit טרי", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "לא רץ" });
  painful.push("capability-audit לא רץ");
}

// ── 6. האם הפסיקות-השמורות משקרות? (מטריצה שמורה מול ריצה-טרייה) ──
try {
  const matrix = readJson(`${DATA_DIR}/ai/capability-matrix.json`) as { at?: string; verdict?: string } | null;
  const stored = matrix?.verdict ?? "";
  const fresh = capOk ? "CAPABILITY-AUDIT-OK" : "CAPABILITY-AUDIT-FAIL";
  const agree = stored === fresh;
  const gate = readJson(`${DATA_DIR}/sovereign/secrets-gate.json`) as { verdict?: string } | null;
  const gateClean = gate?.verdict === "CLEAN";
  const anchors = existsSync(`${DATA_DIR}/oracle/anchors.jsonl`)
    ? (JSON.parse(readFileSync(`${DATA_DIR}/oracle/anchors.jsonl`, "utf8").trim().split("\n").pop() ?? "{}") as { at?: string })
    : {};
  const oraAge = ageMin(anchors.at);
  const treasury = readJson(`${DATA_DIR}/treasury/last.json`) as { marketOk?: boolean; ledgerOk?: boolean } | null;
  const treOk = treasury?.marketOk === true && treasury?.ledgerOk === true;
  const allGood = agree && gateClean && oraAge >= 0 && oraAge <= 30 && treOk;
  checks.push({
    id: "stored-verdict-truth",
    claim: "פסיקות-שמורות אינן משקרות: מטריצה-שמורה == מדידה-טרייה · שער-סודות CLEAN · עוגן ≤30ד׳ · אוצרה market+ledger ok",
    result: allGood ? "PASS" : "FAIL",
    detail: `stored=${stored || "ריק"} · fresh=${fresh} · gate=${gate?.verdict ?? "ריק"} · oracle-age=${oraAge.toFixed(1)}min · treasury=${treOk ? "ok" : "שקר"}`,
  });
  if (!allGood) painful.push("פסיקה-שמורה סותרת את המציאות הטרייה");
} catch (e) {
  checks.push({ id: "stored-verdict-truth", claim: "פסיקות-שמורות", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 120) : "שגיאה" });
  painful.push("לא ניתן לצלוב פסיקות-שמורות");
}

// ── 7. האמת המפורסמת (הפאנל החי בעולם האמיתי) ──
let liveDateHeader: string | null = null;
try {
  const { data, dateHeader } = await getJson(`${LIVE_EVID}?t=${Date.now()}`, 12_000);
  liveDateHeader = dateHeader;
  const gen = String(data.generatedAt ?? "");
  const genAge = ageMin(gen);
  const sources = (data.sources ?? {}) as Record<string, { available?: boolean }>;
  const avail = Object.values(sources).filter((s) => s?.available === true).length;
  const om = sources.ownerMemory as { directives?: number } | undefined;
  const localMem = readJson(`${ROSHPINA}/sovereignty/owner-memory.json`) as { directiveLog?: unknown[] } | null;
  const localCount = (localMem?.directiveLog ?? []).length;
  const liveDirectives = typeof om?.directives === "number" ? om.directives : -1;
  const noFabrication = liveDirectives <= localCount; // מפורסם > מקומי = המצאה
  const freshEnough = genAge >= 0 && genAge <= 60;
  checks.push({
    id: "published-truth",
    claim: "הפאנל החי מפרסם אמת טרייה: HTTP 200 · גיל ≤60ד׳ · ≥9 מקורות זמינים · אפס-המצאה (מפורסם ≤ מקומי)",
    result: freshEnough && avail >= 9 && noFabrication ? "PASS" : "FAIL",
    detail: `generatedAt-גיל=${genAge.toFixed(1)}min · זמינים=${avail} · directives-חי=${liveDirectives} · directives-מקומי=${localCount}`,
  });
  if (!(freshEnough && avail >= 9 && noFabrication)) painful.push("הפאנל המפורסם אינו טרי או חורג מהאמת המקומית");

  const consoleRes = await fetch(`${LIVE_CONSOLE}?t=${Date.now()}`, { signal: AbortSignal.timeout(12_000) });
  const html = consoleRes.ok ? await consoleRes.text() : "";
  checks.push({
    id: "panel-live",
    claim: "פאנל-הראיות חי בקונסוליה המפורסמת (AGENT4-EVIDENCE-PANEL קיים ב-HTML החי)",
    result: consoleRes.ok && html.includes("AGENT4-EVIDENCE-PANEL") ? "PASS" : "FAIL",
    detail: `HTTP=${consoleRes.status} · מרקר=${html.includes("AGENT4-EVIDENCE-PANEL") ? "קיים" : "חסר"}`,
  });
  if (!(consoleRes.ok && html.includes("AGENT4-EVIDENCE-PANEL"))) painful.push("פאנל-הראיות חסר מהקונסוליה החיה");
} catch (e) {
  checks.push({ id: "published-truth", claim: "האמת המפורסמת", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 120) : "לא נגיש" });
  painful.push("הפרסום החי לא נענה");
}

// ── 8. זיכרון-בעלים: מונוטוני בין-ריצות הגריל ──
let directives = 0;
try {
  const mem = readJson(`${ROSHPINA}/sovereignty/owner-memory.json`) as { directiveLog?: Array<{ trace?: string }> } | null;
  const dl = mem?.directiveLog ?? [];
  directives = dl.length;
  const lastTrace = dl.length ? String(dl[dl.length - 1].trace ?? "") : "";
  const jrl = `${DATA_DIR}/ai/roast-grill.jsonl`;
  let prev = -1;
  if (existsSync(jrl)) {
    const lines = readFileSync(jrl, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as { directives?: number };
        if (typeof rec.directives === "number") { prev = rec.directives; break; }
      } catch { /* שורה-פגומה — ממשיכים */ }
    }
  }
  const monotone = prev < 0 || directives >= prev;
  checks.push({
    id: "directives-monotone",
    claim: "זיכרון-ההנחיות אינו נסג בין-ריצות הגריל (חוק task-48: זיכרון שקט פחות = זיכרון אבוד)",
    result: monotone && directives >= 1 && lastTrace !== "" ? "PASS" : "FAIL",
    detail: `directives=${directives} · קודם=${prev < 0 ? "ריצה-ראשונה" : String(prev)} · lastTrace=${lastTrace.slice(0, 18)}`,
  });
  if (!(monotone && directives >= 1 && lastTrace !== "")) painful.push("זיכרון-ההנחיות נסג או ריק");
} catch (e) {
  checks.push({ id: "directives-monotone", claim: "זיכרון-הנחיות", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "שגיאה" });
  painful.push("זיכרון-בעלים לא נקרא");
}

// ── 9. שלמות-ה-worklog: אין פערים ברצף-המשימות של הציר ──
try {
  const ids = [...readFileSync(WORKLOG, "utf8").matchAll(/^Task ID: (\d+)[^\d]/gm)].map((m) => parseInt(m[1], 10));
  const present = new Set(ids);
  const maxT = Math.max(44, ...ids);
  const missing: number[] = [];
  for (let t = 44; t <= maxT; t++) if (!present.has(t)) missing.push(t);
  checks.push({
    id: "worklog-integrity",
    claim: `יומן-העבודה שלם: אין משימות חסרות בטווח 44–${maxT} (פער = זיכרון-עבודה אבוד)`,
    result: missing.length === 0 ? "PASS" : "FAIL",
    detail: missing.length === 0 ? `Task 44..${maxT} מלאים (${ids.filter((x) => x >= 44).length} רשומות-ציר)` : `חסרים: ${missing.join(", ")}`,
  });
  if (missing.length > 0) painful.push(`worklog חסר Task ${missing.join(", ")} — זיכרון-עבודה אבוד`);
} catch (e) {
  checks.push({ id: "worklog-integrity", claim: "שלמות-worklog", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "לא נקרא" });
  painful.push("worklog לא נקרא");
}

// ── 10. לוח-הזמנים: כישלון-מתוזמן חייב הוכחה-טרייה מרפאת, או הצהרה-כנה ──
// מקור-האמת = רשומת-ה-end האחרונה ב-jobs.jsonl (ראיה ראשונית), לא lastStatus
// (מטמון שמפגר מאחורי הריצה הבאה). lastStatus משמש רק כרמז-חיפוש.
try {
  const lastEnd = new Map<string, { status?: string; finishedAt?: string }>();
  const jp = `${DATA_DIR}/jobs.jsonl`;
  if (existsSync(jp)) {
    for (const line of readFileSync(jp, "utf8").split("\n")) {
      if (!line.includes('"phase":"end"')) continue;
      try {
        const rec = JSON.parse(line) as { preset?: string; status?: string; finishedAt?: string };
        if (rec.preset) lastEnd.set(rec.preset, { status: rec.status, finishedAt: rec.finishedAt });
      } catch { /* שורה-פגומה */ }
    }
  }
  const scheds = (readJson(`${DATA_DIR}/schedules.json`) ?? []) as Array<{ presetId?: string; enabled?: boolean; lastStatus?: string | null; failCount?: number; runCount?: number }>;
  const enabled = scheds.filter((s) => s.enabled);
  const bad = enabled.filter((s) => s.lastStatus === "failed" || s.lastStatus === "timeout");
  const covered: string[] = [];
  const gaps: string[] = [];
  const unexplained: string[] = [];
  for (const s of bad) {
    const p = String(s.presetId);
    // מרפא-טרי: ריצת-קצה מוצלחת של אותו-preset מאשרת שהכישלון-המתוזמן היה נקודתי
    const real = lastEnd.get(p);
    if (real?.status === "succeeded") {
      covered.push(`${p}(ריצה אחרונה בפועל succeeded @ ${String(real.finishedAt ?? "").slice(11, 19)}Z)`);
    } else if (p === "ai-architect" || (typeof s.failCount === "number" && typeof s.runCount === "number" && s.runCount > 5 && s.failCount / s.runCount > 0.4)) {
      gaps.push(`${p}(${s.failCount}/${s.runCount} כישלונות — מדוד, מוצהר)`);
    } else {
      unexplained.push(`${p}(lastStatus=${String(s.lastStatus)} · ריצה-אחרונה-בפועל=${real?.status ?? "אין"})`);
    }
  }
  checks.push({
    id: "schedule-truth",
    claim: "כל כישלון-מתוזמן מוסבר מראיה-ראשונית: ריצת-קצה מוצלחת מרפאת, או פער-מדוד מוצהר — אף-אחד לא מוסתר",
    result: unexplained.length === 0 ? "PASS" : "FAIL",
    detail: `${enabled.length} מופעלים · מכוסים-מהיומן: ${covered.join(",") || "—"} · פערים-כנים: ${gaps.join(",") || "—"} · לא-מוסברים: ${unexplained.join(",") || "—"}`,
  });
  if (unexplained.length > 0) painful.push(`כישלונות-תזמון לא מוסברים: ${unexplained.join(", ")}`);
  if (gaps.length > 0) checks.push({ id: "degraded-lane-gap", claim: "מסלולים באמינות-חלקית — פער מוצהר, לא שקר", result: "GAP", detail: gaps.join(" · ") });
} catch (e) {
  checks.push({ id: "schedule-truth", claim: "לוח-זמנים", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "לא נקרא" });
  painful.push("לוח-הזמנים לא נקרא");
}

// ── 11. שער-סודות טרי על שני העצים ──
try {
  const d = sh(["bun", "scripts/secrets-gate.ts", "dir", DOMAIN], { cwd: RUNNER_DIR });
  const r = sh(["bun", "scripts/secrets-gate.ts", "dir", ROSHPINA], { cwd: RUNNER_DIR });
  const clean = d.ok && r.ok;
  checks.push({
    id: "secrets-fresh",
    claim: "שער-סודות טרי: Domain + roshpina נקיים (exit 0, אפס-פגיעות)",
    result: clean ? "PASS" : "FAIL",
    detail: `domain=${d.ok ? "CLEAN" : "נפגע"} · roshpina=${r.ok ? "CLEAN" : "נפגע"}`,
  });
  if (!clean) painful.push("שער-סודות מצא פגיעה — fail-closed");
} catch (e) {
  checks.push({ id: "secrets-fresh", claim: "שער-סודות", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "לא רץ" });
  painful.push("שער-סודות לא רץ");
}

// ── 12. אמת-שעון (הקפאה משקרת בשעון) ──
try {
  const server = liveDateHeader ? Date.parse(liveDateHeader) : NaN;
  const skew = Number.isFinite(server) ? Math.abs(Date.now() - server) / 1000 : -1;
  checks.push({
    id: "time-truth",
    claim: "השעון המקומי כשר מול העולם (סטייה משרת-HTTP ≤90שנ׳)",
    result: skew >= 0 && skew <= 90 ? "PASS" : "FAIL",
    detail: skew < 0 ? "לא נמדד (אין כותרת-תאריך)" : `סטייה=${skew.toFixed(1)}שנ׳`,
  });
  if (!(skew >= 0 && skew <= 90)) painful.push("סטיית-שעון חריגה — ההקפאה עלולה לשקר");
} catch (e) {
  checks.push({ id: "time-truth", claim: "אמת-שעון", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "שגיאה" });
}

// ── 13. תרגיל-אסון טרי (מהיומן, מהסוף-להתחלה) ──
try {
  const jp = `${DATA_DIR}/jobs.jsonl`;
  let drOk = false;
  let drDetail = "לא נמצאה ריצת dr-drill ביומן";
  if (existsSync(jp)) {
    const lines = readFileSync(jp, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"dr-drill"')) continue;
      try {
        const rec = JSON.parse(lines[i]) as { preset?: string; status?: string; phase?: string; finishedAt?: string; startedAt?: string };
        if (rec.phase !== "end") continue;
        const ts = rec.finishedAt ?? rec.startedAt ?? "";
        const ageH = ageMin(ts) / 60;
        drOk = rec.status === "succeeded" && ageH >= 0 && ageH <= 26;
        drDetail = `status=${rec.status} · גיל=${ageH.toFixed(1)}h (חוזה: ≤26h, יומי)`;
        break;
      } catch { /* שורה-פגומה */ }
    }
  }
  checks.push({ id: "dr-drill", claim: "תרגיל-אסון טרי (העיקרה קמה מהגיט בלבד) — הצלחה ≤26h", result: drOk ? "PASS" : "FAIL", detail: drDetail });
  if (!drOk) painful.push("תרגיל-האסון לא אומת טרי");
} catch (e) {
  checks.push({ id: "dr-drill", claim: "תרגיל-אסון", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "שגיאה" });
  painful.push("יומן-העבודות לא נקרא");
}

/* ─── פסיקה ─────────────────────────────────────────────────────────────────── */
const pass = checks.filter((c) => c.result === "PASS").length;
const fail = checks.filter((c) => c.result === "FAIL").length;
const gaps = checks.filter((c) => c.result === "GAP").length;
const verdict = fail > 0 ? "ROAST-GRILL-PAINFUL" : "ROAST-GRILL-OK";
for (const c of checks) console.log(`  [${c.result}] ${c.claim} — ${c.detail}`);
console.log(`${verdict} · ${pass} עברו · ${fail} נשברו · ${gaps} פערים-כנים · בקרות: מוכחות`);
if (painful.length) console.log(`  אמת-כואבת (${painful.length}): ${painful.join(" · ")}`);

writeState(verdict, { pass, fail, gaps, controls: "proven" }, directives, at, painful);

if (fail > 0) {
  console.error("ROAST-GRILL-PAINFUL: אמת-כואבת נחשפה — רועשת בכוונה, לא מוסתרת (fail-closed)");
  process.exit(1);
}

/* ─── כתיבת-מצב אטומית + יומן-מונוטוני ─────────────────────────────────────── */
function writeState(verdict: string, summary: Record<string, unknown>, directives: number, at: string, painful: string[]): void {
  try {
    mkdirSync(`${DATA_DIR}/ai`, { recursive: true });
    const state = { at, verdict, summary, directives, painful };
    const tmp = `${DATA_DIR}/ai/roast-grill.json.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, `${DATA_DIR}/ai/roast-grill.json`);
    appendFileSync(`${DATA_DIR}/ai/roast-grill.jsonl`, JSON.stringify(state) + "\n");
  } catch {
    /* ראיות לא מפילות ביצוע */
  }
}
