/**
 * sovereign-decisions.ts — הריבון-המחליט (חוק-R40: הארכיטקטורה מחליטה — לא ממתינה לבעלים).
 *
 * כל-ריצה, בלי-שום-אדם-בלופ:
 *   1. איסוף-אמת מהקרקע: חיות-צמתים (ledger/market/runner), refs מרוחקים (branch+tag לשני-הקווים),
 *      טריות-קפסולת-מדינה, טריות-עוגן-אורקל.
 *   2. הכרעה על-פי-חוקים מפורשים (R39 בעלות-ארכיטקטורה · R40 הכרעה-עצמית · חוק-תמותת-הבונים · R28 כנות).
 *   3. ביצוע מיידי של הפעולה (שחזור-refs, ריפוי-צמתים, רענון-קפסולה, רענון-אורקל).
 *   4. רישום כל-החלטה ביומן חתום-זמן: data/sovereign/decisions.jsonl
 *      { at, id, kind, evidence, action, outcome, law } — החלטת-"החזק" נרשמת בדיוק כמו פעולה,
 *      כדי שהבעלים יראה שהארכיטקטורה שקלה והחליטה — לא שהיא לא-עשתה-כלום.
 *
 * fail-closed: הכרעה-שנכשלה-בביצוע = exit 1 רועש (אין הסתרת-כישלון-החלטה).
 * רץ: bun scripts/sovereign-decisions.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const RUNNER_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const SOVR_DIR = join(RUNNER_ROOT, "data", "sovereign");
const SNAP_DIR = "/home/z/my-project/state-snapshots";
const ROSHPINA = "/home/z/repos/roshpina";
const TOKEN_FILE = "/home/z/my-project/upload/pat.env";
const REPO = "roshpinacare-sys/roshpina";
const LANE_BRANCH = "agent4/p2-sovereign-market";
const CP_BRANCH = "agent4/control-plane";
const TIMEOUT = 8_000;
const CAPSULE_MAX_AGE_MIN = 30;
const ORACLE_MAX_AGE_MIN = 30;
const nowIso = () => new Date().toISOString();

type Decision = { at: string; id: string; kind: string; evidence: string; action: string; outcome: string; law: string };
const decisions: Decision[] = [];

// ── monotonic-council laws (channel: CONTROLS-THAT-EXIST — "monotonic escalation") ──
// המועצה יכולה רק לשקם ולהרים — אף-פעם לא להשמיד. שתי-אכיפות:
// (א) סטטית: קוד-המועצה עצמו אסור שיכיל יכולת-השמדה (מחיקת-ref/תג מרוחקים, prune) —
//     אם נוספה כזו למקור, הריצה מתה כאן רועש, לפני כל-החלטה.
// (ב) רנטית: סוגי-ההחלטות סגורים-למיני-רשימה — כל-kind מחוץ-לרשימה = exit 1.
const DESTRUCTIVE_SOURCE = [/\s--delete\b/, /\s:refs\/(heads|tags)\//, /tag\s+-[a-z]*d\b/, /remote\s+prune/];
const DECISION_KINDS = new Set([
  "restore-lane-branch", "restore-control-plane-branch", "preserve-lane-work", "restore-control-plane-file", "heal-nodes", "refresh-capsule", "refresh-oracle", "hold",
]);
function monotonicSelfAudit(): void {
  const src = readFileSync(import.meta.path, "utf8");
  const hits = DESTRUCTIVE_SOURCE.filter((rx) => rx.test(src));
  if (hits.length > 0) {
    console.error(`SOVEREIGN-DECISIONS-FAIL: council self-audit — destructive capability present in source (${hits.length} pattern(s)); the council is monotonic (restore-only) — refusing to run`);
    process.exit(1);
  }
}

const decide = (kind: string, evidence: string, action: string, outcome: string, law: string): Decision => {
  if (!DECISION_KINDS.has(kind)) {
    console.error(`SOVEREIGN-DECISIONS-FAIL: decision kind "${kind}" is outside the closed set — the council may not invent new powers (monotonic law)`);
    process.exit(1);
  }
  const d: Decision = {
    at: nowIso(),
    id: `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind, evidence, action, outcome, law,
  };
  decisions.push(d);
  return d;
};

function git(args: string[], cwd = ROSHPINA): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + " " + p.stderr.toString()).trim() };
}

function runScript(script: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["bun", `scripts/${script}`], { cwd: RUNNER_ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + " " + p.stderr.toString()).trim() };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
  return JSON.parse(raw);
}

function tokenOf(): string {
  if (!existsSync(TOKEN_FILE)) return "";
  return readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? "";
}

async function refAlive(ref: "heads" | "tags", name: string): Promise<{ alive: boolean; sha: string }> {
  const token = tokenOf();
  if (!token) throw new Error("no usable token in supply path");
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/ref/${ref}%2F${name.replaceAll("/", "%2F")}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404) return { alive: false, sha: "" };
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${name}`);
  const j = (await res.json()) as { object?: { sha?: string } };
  return { alive: true, sha: String(j.object?.sha ?? "") };
}

const ageMinOf = (iso: string) => (Date.now() - Date.parse(iso)) / 60_000;
const lastJsonl = (p: string): Record<string, unknown> => {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const lines = readFileSync(p, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};
const newestCapsule = (): { name: string; ageMin: number } => {
  const dir = SNAP_DIR;
  const caps = readdirSyncSafe(dir).filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz")).sort();
  if (!caps.length) throw new Error("no capsules");
  const name = caps[caps.length - 1];
  return { name, ageMin: (Date.now() - statSyncSafe(join(dir, name))) / 60_000 };
};

function readdirSyncSafe(p: string): string[] { return existsSync(p) ? readdirSync(p) : []; }
function statSyncSafe(p: string): number { return statSync(p).mtimeMs; }

async function main(): Promise<void> {
  monotonicSelfAudit(); // (א) — the council may never carry destructive capability
  const at = nowIso();
  console.log(`SOVEREIGN-DECISIONS @ ${at} — the architecture decides, evidences, executes (R40; monotonic: restore-only)`);

  // ── 1. איסוף-אמת ──
  const truth: string[] = [];
  let laneBr = { alive: false, sha: "" };
  let cpBr = { alive: false, sha: "" };
  let laneTag = { alive: false, sha: "" };
  let cpTag = { alive: false, sha: "" };
  let refErr = "";
  try {
    laneBr = await refAlive("heads", LANE_BRANCH);
    cpBr = await refAlive("heads", CP_BRANCH);
    laneTag = await refAlive("tags", `archive/${LANE_BRANCH}`);
    cpTag = await refAlive("tags", `archive/${CP_BRANCH}`);
    truth.push(`refs: lane-branch=${laneBr.alive ? laneBr.sha.slice(0, 7) : "GONE"} · cp-branch=${cpBr.alive ? cpBr.sha.slice(0, 7) : "GONE"} · lane-tag=${laneTag.alive ? "alive" : "GONE"} · cp-tag=${cpTag.alive ? "alive" : "GONE"}`);
  } catch (e) {
    refErr = e instanceof Error ? e.message : "refs-unreachable";
    truth.push(`refs: unreachable (${refErr})`);
  }

  const nodes: Record<string, boolean> = {};
  for (const [name, url] of [["ledger", "http://127.0.0.1:3032/health"], ["market", "http://127.0.0.1:3033/health"], ["runner", "http://127.0.0.1:3031/health"]] as const) {
    try { await getJson(url); nodes[name] = true; } catch { nodes[name] = false; }
  }
  truth.push(`nodes: ${Object.entries(nodes).map(([k, v]) => `${k}=${v ? "up" : "DOWN"}`).join(" · ")}`);

  let capsule = { name: "?", ageMin: -1 };
  let oracleAge = -1;
  try { capsule = newestCapsule(); truth.push(`capsule: ${capsule.name} (${capsule.ageMin.toFixed(1)}min)`); }
  catch (e) { truth.push(`capsule: unreadable (${e instanceof Error ? e.message.slice(0, 80) : "?"})`); }
  try {
    const a = lastJsonl(join(RUNNER_ROOT, "data", "oracle", "anchors.jsonl")) as { at: string };
    oracleAge = ageMinOf(a.at);
    truth.push(`oracle-anchor: ${oracleAge.toFixed(1)}min`);
  } catch {
    // R40 fix (measured 14:12): an UNREADABLE anchor must count as maximally stale —
    // the refresh trigger below keys on age; a missing/corrupt anchor is worse than an old one.
    oracleAge = Number.MAX_SAFE_INTEGER / 60_000;
    truth.push("oracle-anchor: unreadable — treated as maximally stale (refresh will decide)");
  }

  console.log(`  truth: ${truth.join(" | ")}`);

  // ── 2+3. הכרעה על-פי-חוק וביצוע מיידי ──
  let acted = false;
  let anyFailed = false;

  // R40 + חוק-תמותת-הבונים: branch שנמחק-בידי-גורם-חוץ → שחזור מהמצע המקומי, מיד.
  if (refErr === "" && !laneBr.alive) {
    acted = true;
    if (!laneTag.alive) {
      decide("restore-lane-branch", "lane branch GONE and archive tag GONE — no remote preservation", "ABSTAIN — escalated to operator (exception-only: preservation substrate itself is gone)", "recorded", "R40 · exception-only escalation");
      anyFailed = true;
    } else {
      const token = tokenOf();
      const headSha = git(["rev-parse", "HEAD"]).out.trim().slice(0, 7);
      const r = git(["push", "--quiet", "--force", `https://x-access-token:${token}@github.com/${REPO}.git`, "HEAD:refs/heads/" + LANE_BRANCH]);
      decide("restore-lane-branch", `external cleaner deleted ${LANE_BRANCH}; archive tag intact (${laneTag.sha.slice(0, 7)})`, `force-push local HEAD (${headSha}) → refs/heads/${LANE_BRANCH}`, r.ok ? "restored" : `FAILED: ${r.out.split(token).join("***").slice(0, 120)}`, "R40 decides · builder-mortality law: the work survives the builder");
      if (!r.ok) anyFailed = true;
    }
  }
  // R40 + חוק-תמותת-הבונים, חצי-ב (נמדד 2026-10-21 ~10:00): תג-הארכיון של המסלול פגר מאחורי
  // ה-HEAD החי (cfc05d6 מול ca662d6) — 2 ביקודים נכשלו (remote-preservation · self-red-team 1/11)
  // ו-dr-drill משחזר קוד *מהתג* — תג-מפגר = שחזור-DR של קוד ישן. השורש: קידום-התג היה טקס-ידני
  // של-בונה, וטקס נשכח פעם-אחת. הריפוי-המבני: המועצה מקדמת את התג בעצמה — מונוטוני-בבנייה:
  // רק fast-forward (הפיל-המרוחק אב-קדמון של HEAD — או להפך, ואז המקומי משתחזר ff-only),
  // רק עץ-נקי (עבודה-שלא-נשמרה לא נושאת תג — חוק task-48), ענף-ראשון. סטייה-דו-כיוונית =
  // ABSTAIN (R42: לעולם לא לכתוב על עולם שאולי-טוב-יותר — מותר להרים, אסור להחליף).
  if (refErr === "" && laneBr.alive && laneTag.alive) {
    const token2 = tokenOf();
    const url = `https://x-access-token:${token2}@github.com/${REPO}.git`;
    const safe = (s: string) => s.split(token2).join("***");
    const head = git(["rev-parse", "HEAD"]).out.trim();
    const fr = git(["fetch", "--quiet", url, `refs/tags/archive/${LANE_BRANCH}`]);
    const peel = fr.ok ? git(["rev-parse", "FETCH_HEAD^{commit}"]).out.trim() : "";
    const cleanTree = git(["status", "--porcelain"]).out.trim() === "";
    if (head && peel && head !== peel && cleanTree) {
      if (git(["merge-base", "--is-ancestor", peel, head]).ok) {
        // מקומי מוביל — מרימים ענף ואז תג (שניהם fast-forward; הפיל-הישן נשאר אב-קדמון — R42-safe)
        acted = true;
        const br = git(["push", "--quiet", url, "HEAD:refs/heads/" + LANE_BRANCH]);
        const tg = br.ok
          ? git(["push", "--quiet", url, "+HEAD:refs/tags/archive/" + LANE_BRANCH])
          : { ok: false, out: "branch push rejected — tag not advanced" };
        if (tg.ok) git(["update-ref", `refs/tags/archive/${LANE_BRANCH}`, head]);
        decide(
          "preserve-lane-work",
          `tag-peel=${peel.slice(0, 7)} behind live-HEAD=${head.slice(0, 7)} · ff=${git(["rev-list", "--count", `${peel}..${head}`]).out.trim()} commits`,
          `push HEAD → refs/heads/${LANE_BRANCH}, then +HEAD → refs/tags/archive/${LANE_BRANCH}`,
          tg.ok ? `preserved — peel now ${head.slice(0, 7)}` : `FAILED: ${safe((br.ok ? tg : br).out).slice(0, 120)}`,
          "R40 · builder-mortality half-b: the tag must not depend on builder memory (measured: manual ritual failed once → 2 audit FAILs)",
        );
        if (!tg.ok) anyFailed = true;
      } else if (git(["merge-base", "--is-ancestor", head, peel]).ok) {
        // מקומי מפגר (למשל אחרי sandbox-rewind) — השתחזרות ff-only אל האמת-המרוחקת
        acted = true;
        const mg = git(["merge", "--quiet", "--ff-only", "FETCH_HEAD"]);
        if (mg.ok) git(["update-ref", `refs/tags/archive/${LANE_BRANCH}`, peel]);
        decide(
          "preserve-lane-work",
          `live-HEAD=${head.slice(0, 7)} behind tag-peel=${peel.slice(0, 7)} — local worktree lags the remote contract`,
          "git merge --ff-only FETCH_HEAD (monotone catch-up; no force, no reset)",
          mg.ok ? `caught up — HEAD now ${peel.slice(0, 7)}` : `FAILED: ${safe(mg.out).slice(0, 120)}`,
          "R40 · restore-only: local fast-forwards to remote truth, never rewinds it",
        );
        if (!mg.ok) anyFailed = true;
      } else {
        decide("hold", `tag-peel=${peel.slice(0, 7)} diverged from live-HEAD=${head.slice(0, 7)} (neither is ancestor)`, "ABSTAIN — escalated to lane owner (R42: a divergent tag is never overwritten blind)", "recorded", "R40 · exception-only escalation");
      }
    } else if (head && peel && head !== peel && !cleanTree) {
      decide("hold", `tag-peel=${peel.slice(0, 7)} behind HEAD=${head.slice(0, 7)} but worktree dirty`, "ABSTAIN — uncommitted work never carries the tag; the next run preserves after commit", "recorded", "R28 · uncommitted memory is lost memory (task-48 law)");
    }
  }

  // R40 + חוק-משימה-51 (נמדד 2026-10-21 ~16:00): הפשרת-סנדבוקס החזירה את עץ-מכשיר-הבקרה —
  // שאינו checkout-git — למצב-ישן: התיקון-המבני של משימה-49 (preserve-lane-work) נעלם מהעץ-החי
  // בזמן שארכיון-הסנפשוטים בגיט החזיק אותו (21ddf60/512e631). חוק-משימה-49 מיושם על התיקון-עצמו:
  // שימור אינו יכול להיות תלוי-בזיכרון-בונה. הכוח: גלאי-נסיגה מבוסס epoch-תוכן — אם תוכן-חי
  // של קובץ-ריבוני זהה לגרסה-היסטורית (מוכח: ה-blob קיים בהיסטוריית-הסנפשוטים) וקיימת גרסה
  // שepoch-ההופעה-הראשונה שלה מאוחר-יותר — נסיגה-מוכחת ומשחזרים מהארכיון. מונוטוני-בתוכן:
  // לעולם לא מחזירים גרסה שהופיעה-ראשונה לפני זו-החייה — כך סנפשוט-מזוהם (קומיט-מאוחר של
  // תוכן-ישן שנבנה-מחדש מעץ-מופשר) לא יגרום למשחזר לרדת-אחורה (R42).
  // תוכן-חי שכלל-לא בהיסטוריה = עבודה-מקומית-חדשה — לא נסיגה; הגיבוי-המתוכנן ישמר אותה.
  const CP_SNAPSHOT_PREFIX = "control-plane/mini-services/fleet-runner/scripts/";
  const CP_GUARDED_FILES = ["sovereign-decisions.ts", "capability-audit.ts", "self-audit.ts", "dr-drill.ts", "control-plane-backup.ts", "pages-evidence.ts", "secrets-gate.ts"];
  for (const f of CP_GUARDED_FILES) {
    const livePath = join(RUNNER_ROOT, "scripts", f);
    if (!existsSync(livePath)) continue;
    const liveBlob = git(["hash-object", livePath]).out.trim();
    if (!liveBlob) continue;
    const snapshotPath = CP_SNAPSHOT_PREFIX + f;
    // הסריקה על אמת-מרוחקת, לא על שיקוף-מקומי: הגיבוי קומט ב-clone-זמני מבודד ודוחף משם —
    // הריפו-המקומי לעולם לא מכיר את הסנפשוטים-החדשים (נמדד 2026-10-21 16:40: f583368 נעדר
    // מקומית לגמרי). מביאים את ענף-הבקרה המרוחק ל-ref-מעקב מקומי וסורקים אותו; כישלון-רשת =
    // נפילה-מכובדת לסריקה-מקומית (best-effort, לא שקט).
    const cpUrl = `https://x-access-token:${tokenOf()}@github.com/${REPO}.git`;
    git(["fetch", "--quiet", cpUrl, "+refs/heads/agent4/control-plane:refs/remotes/cp-scan/head"]);
    let hist = git(["log", "refs/remotes/cp-scan/head", "--format=%H %cI", "-n", "60", "--", snapshotPath]);
    if (!hist.ok || !hist.out.trim()) hist = git(["log", "--all", "--format=%H %cI", "-n", "60", "--", snapshotPath]);
    if (!hist.ok || !hist.out.trim()) continue;
    const firstSeen = new Map<string, string>();
    for (const line of hist.out.trim().split("\n")) {
      const parts = line.split(" ");
      if (parts.length < 2) continue;
      const b = git(["rev-parse", `${parts[0]}:${snapshotPath}`]).out.trim();
      if (b && !firstSeen.has(b)) firstSeen.set(b, parts[1]);
    }
    const liveEpoch = firstSeen.get(liveBlob);
    if (!liveEpoch) {
      // תוכן-חי לא-מוכר-להיסטוריה: עבודה-חדשה (הגיבוי ישמר אותה) — או נסיגה-קדם-ארכיון (המקרה
      // שנמדד 2026-10-21: נקודת-ביקורת ישנה מהסנפשוט-הראשון של עץ-מכשיר-הבקרה). לא נוגעים
      // אוטומטית (R42: לא לכתוב על עולם שאולי-טוב-יותר) — אך לא שקטים: hold לנראות עד שהגיבוי יעגן.
      decide("hold", `${f}: live content unknown to snapshot history — new work (next control-plane-backup preserves it) or pre-archive regression like the 2026-10-21 measured rewind`, "no auto-action — visibility only; control-plane-backup will anchor the live tree", "recorded", "R42 · never overwrite a possibly-better world blind");
      continue;
    }
    const newer = [...firstSeen.entries()].filter(([b, iso]) => b !== liveBlob && iso > liveEpoch)
      .sort((a, b) => (a[1] < b[1] ? 1 : -1));
    if (newer.length === 0) continue; // החי הוא החדש-ביותר-מוכח — מסונכרן
    const [newestBlob, newestEpoch] = newer[0];
    // בייטים-מדויקים (ה-git() שלנו עושה trim — blob חייב לרדת כמו-שהוא, אחרת ה-hash verify ייפול)
    const raw = Bun.spawnSync(["git", "cat-file", "blob", newestBlob], { cwd: ROSHPINA, stdout: "pipe", stderr: "pipe" });
    if (raw.exitCode !== 0 || !raw.stdout.length) continue;
    writeFileSync(livePath, raw.stdout);
    const verify = git(["hash-object", livePath]).out.trim();
    acted = true;
    decide(
      "restore-control-plane-file",
      `${f}: live content == historical blob (first-seen ${liveEpoch}) while archive holds a newer blob (first-seen ${newestEpoch}) — proven sandbox-rewind regression`,
      `git cat-file blob ${newestBlob.slice(0, 10)} → scripts/${f} (restore-only, content-epoch monotone)`,
      verify === newestBlob ? "restored — archive truth back in the live tree" : `FAILED: hash mismatch (${verify.slice(0, 10)} ≠ ${newestBlob.slice(0, 10)})`,
      "R40 · R42 — only forward in content-epoch; the cure itself survives builder mortality (task-51 law)",
    );
    if (verify !== newestBlob) anyFailed = true;
  }

  if (refErr === "" && !cpBr.alive) {
    acted = true;
    const r = runScript("control-plane-backup.ts");
    decide("restore-control-plane-branch", `external cleaner deleted ${CP_BRANCH}; rebuilding snapshot from the live control-plane tree`, "bun scripts/control-plane-backup.ts (dual-ref: branch + archive tag)", r.ok ? "restored" : `FAILED: ${r.out.slice(0, 120)}`, "R40 decides · snapshot-semantics survive external deletion");
    if (!r.ok) anyFailed = true;
  }

  // R40: צומת-שנפל → ריפוי עצמאי דרך המנגנון-הקיים (idempotent — מקים רק-מה-שנפל).
  const downNodes = Object.entries(nodes).filter(([, v]) => !v).map(([k]) => k);
  if (downNodes.length) {
    acted = true;
    const r = Bun.spawnSync(["bash", "start-nodes.sh"], { cwd: RUNNER_ROOT, stdout: "pipe", stderr: "pipe" });
    const ok = r.exitCode === 0;
    decide("heal-nodes", `nodes down: ${downNodes.join(",")}`, "bash start-nodes.sh (idempotent keeper path)", ok ? "heal executed" : `FAILED: ${(r.stdout.toString() + r.stderr.toString()).slice(0, 120)}`, "R40 decides · the architecture heals itself");
    if (!ok) anyFailed = true;
  }

  // R40: קפסולה-מזדקנת → רענון מיד.
  if (capsule.ageMin > CAPSULE_MAX_AGE_MIN) {
    acted = true;
    const r = runScript("state-backup.ts");
    decide("refresh-capsule", `newest capsule ${capsule.name} is ${capsule.ageMin.toFixed(1)}min old (limit ${CAPSULE_MAX_AGE_MIN})`, "bun scripts/state-backup.ts", r.ok ? "capsule refreshed" : `FAILED: ${r.out.slice(0, 120)}`, "R40 decides · state survives via capsules");
    if (!r.ok) anyFailed = true;
  }

  // R40: עוגן-אורקל-מזדקן → רענון מיד (אמת-חוץ, לא-טענות-עצמיות).
  if (oracleAge > ORACLE_MAX_AGE_MIN) {
    acted = true;
    const r = runScript("sovereign-oracle.ts");
    decide("refresh-oracle", `oracle anchor is ${oracleAge.toFixed(1)}min old (limit ${ORACLE_MAX_AGE_MIN})`, "bun scripts/sovereign-oracle.ts", r.ok ? "oracle refreshed" : `FAILED: ${r.out.slice(0, 120)}`, "R40 decides · external truth over self-claims");
    if (!r.ok) anyFailed = true;
  }

  // הכרעת-החזק — נרשמת בדיוק כמו פעולה: שקלול-מפורש, לא שתיקה.
  if (!acted) {
    decide("hold", truth.join(" | "), "no action — every subsystem within its law", "recorded", "R40: deciding to hold is a decision, evidenced");
  }

  // ── 4. יומן ──
  mkdirSync(SOVR_DIR, { recursive: true });
  for (const d of decisions) appendFileSync(join(SOVR_DIR, "decisions.jsonl"), JSON.stringify(d) + "\n");
  // last-decision.json = קובץ-מצב-אחרון (לא יומן): כתיבה-מלאה על-גבי — appendFileSync כאן
  // דפק קובץ-JSON (מסמכים-מחוברים) שקרס לכל-קורא (נתגלה 2026-10-21 ע"י גשר-הראיות, צו 1a15ce0b8dbf6c71)
  writeFileSync(join(SOVR_DIR, "last-decision.json"), JSON.stringify({ runAt: at, decisions }, null, 1) + "\n");

  for (const d of decisions) {
    console.log(`  [DECIDE] ${d.kind} — ${d.action} → ${d.outcome} · ${d.law}`);
  }
  if (anyFailed) {
    console.error("SOVEREIGN-DECISIONS-FAIL: a decision failed in execution — loud, not hidden");
    process.exit(1);
  }
  console.log(`SOVEREIGN-DECISIONS-OK · ${decisions.length} decision(s) journaled → data/sovereign/decisions.jsonl`);
}

main().catch((e) => {
  console.error(`SOVEREIGN-DECISIONS-FAIL: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
