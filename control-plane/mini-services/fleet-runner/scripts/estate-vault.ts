/**
 * estate-vault — "כל-העיקרה שורדת מחיקת-סנדבוקס".
 *
 * סקר-העמידות של 2026-10-18 (Task 23) הוכיח פער אמיתי: control-plane-backup מגן
 * על הקוד, אבל **מצב-הכסף והראיות חיים רק על הדיסק המקומי** — הקפסולות
 * (state-snapshots), יומן-העבודות (jobs.jsonl), הפלטים, ה-DB, שידורי-האתר וראיות-
 * המסך כולם ימותו עם מחיקת-הסנדבוקס. הסקריפט הזה דוחף את העיקרה כולה לענף
 * agent4/estate-vault בריפו roshpina — snapshot-semantics (force-push) כמו
 * control-plane-backup, דחיפה-כפולה (ענף + תג archive) מול מחיקות-ענפים ידועות.
 *
 * מה נדחף:
 *   state/           — הקפסולה העדכנית (state-backup: quiesce-gate חתום, חתוכה-טיפות)
 *   fleet-data/      — jobs.jsonl (כל-הראיות) + schedules.json + build/ + ai/ + insights/
 *                      + keys/manifest.json (רישום-זהויות ציבורי — אף מפתח-פרטי!)
 *   outputs-recent/  — 150 פלטי-עבודה אחרונים (ראיות-תוצרים)
 *   db/ + prisma/    — custom.db (SQLite של האתר) + schema.prisma
 *   evidence/        — צילומי-ראיה מ-logs/ (תקציב 4MB, החדשים קודם)
 *   site-data/       — שידורי-האתר (src/data/*.json — כולל השידור-העצמי הראשון)
 *   worklog.md       — יומן-העבודה המלא של הרשת
 *   VAULT-MANIFEST.json — sha256 + גודל לכל-קובץ (בסיס לתרגיל-שחזור מאמת)
 *   PROVENANCE.md    — מקור + הוראות-שחזור מדויקות
 *
 * fail-closed: סריקת-סודות כפולה — (א) על כל-נתיב שנאסף לפני-העתקה, (ב) על
 * כל-קובץ staged לפני-הקומיט. pem/env/passphrase/upload/rar/keys-פרטיים = עצירה
 * קשה, לעולם לא "מדלגים בשקט". דילוג-כנה: עץ-זהה למרוחק = אין דחיפה (SKIP).
 * הטוקן לעולם לא נדפס — הפלט מנוקה לפני הצגה.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, relative } from "path";
import { scanTree } from "./secrets-gate.ts";

const CP = "/home/z/my-project";
const REPO = "/home/z/repos/roshpina";
const BRANCH = "agent4/estate-vault";
const RUNNER_ROOT = `${CP}/mini-services/fleet-runner`;
const SNAP_DIR = `${CP}/state-snapshots`;
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? `${CP}/upload/pat.env`;
const OUTPUTS_LIMIT = 150;
const EVIDENCE_BUDGET = 4 * 1024 * 1024;

const token = existsSync(TOKEN_FILE)
  ? (readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? "")
  : "";
if (!token) {
  console.error("ESTATE-VAULT-FAIL: no usable token (fail-closed)");
  process.exit(1);
}
const clean = (s: string) => s.split(token).join("***");

function run(cmd: string[], opts?: { cwd?: string; quiet?: boolean }): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  if (!opts?.quiet && out.trim()) console.log(clean(out).trim());
  return { ok: p.exitCode === 0, out: clean(out) };
}

if (!existsSync(`${REPO}/.git`)) {
  console.error(`ESTATE-VAULT-FAIL: roshpina repo missing at ${REPO}`);
  process.exit(1);
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walkFiles(root: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) acc.push(relative(root, p));
    }
  };
  walk(root);
  return acc;
}

// ── 1) collect the estate (explicit, secret-guarded paths) ──────────────────
const SECRET_PATTERNS: RegExp[] = [
  /\.pem$/i, /\.env$/i, /\.env\./i, /passphrase/i, /(^|\/)pat\./i, /\.rar$/i,
  /(^|\/)upload\//i, /priv\.pem|\.priv\./i, /(^|\/)keys\/(?!manifest\.json$)/i,
  /(^|\/)vault\/nim-api/i, /(^|\/)\.git(\/|$)/, /(^|\/)p0-runbook\//i,
];

type Item = { rel: string; abs: string; bytes: number };
const items: Item[] = [];
const collect = (rel: string, abs: string) => {
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (!st.isFile()) return;
  items.push({ rel, abs, bytes: st.size });
};

// 1a) the newest money-state capsule — without it there is nothing to protect
const capsules = readdirSync(SNAP_DIR).filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz")).sort();
if (capsules.length === 0) {
  console.error("ESTATE-VAULT-FAIL: no state capsules found — run state-backup first (fail-closed, no estate without its money state)");
  process.exit(1);
}
const capName = capsules[capsules.length - 1];
collect(`state/${capName}`, `${SNAP_DIR}/${capName}`);

// 1b) fleet evidence & schedules (explicit names — keys/ only its public manifest)
collect("fleet-data/jobs.jsonl", `${RUNNER_ROOT}/data/jobs.jsonl`);
collect("fleet-data/schedules.json", `${RUNNER_ROOT}/data/schedules.json`);
collect("fleet-data/keys/manifest.json", `${RUNNER_ROOT}/data/keys/manifest.json`);
for (const d of ["build", "ai", "insights"]) {
  const src = `${RUNNER_ROOT}/data/${d}`;
  if (existsSync(src)) for (const f of walkFiles(src)) collect(`fleet-data/${d}/${f}`, join(src, f));
}

// 1c) job outputs — newest 150 (bounded evidence of what the network produced)
const outDir = `${RUNNER_ROOT}/data/outputs`;
if (existsSync(outDir)) {
  const newest = readdirSync(outDir)
    .map((f) => ({ f, m: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, OUTPUTS_LIMIT);
  for (const o of newest) collect(`outputs-recent/${o.f}`, join(outDir, o.f));
}

// 1d) site DB + schema
collect("db/custom.db", `${CP}/db/custom.db`);
collect("prisma/schema.prisma", `${CP}/prisma/schema.prisma`);

// 1e) screen evidence — newest first within a hard byte budget
const logsDir = `${CP}/logs`;
if (existsSync(logsDir)) {
  let budget = EVIDENCE_BUDGET;
  const shots = readdirSync(logsDir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => ({ f, m: statSync(join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const s of shots) {
    const sz = statSync(join(logsDir, s.f)).size;
    if (sz > budget) continue;
    budget -= sz;
    collect(`evidence/${s.f}`, join(logsDir, s.f));
  }
}

// 1f) site broadcasts + the full worklog
if (existsSync(`${CP}/src/data`)) {
  for (const f of readdirSync(`${CP}/src/data`)) if (f.endsWith(".json")) collect(`site-data/${f}`, `${CP}/src/data/${f}`);
}
collect("worklog.md", `${CP}/worklog.md`);

if (items.length < 5) {
  console.error("ESTATE-VAULT-FAIL: estate too small — collection failed (fail-closed)");
  process.exit(1);
}

// ── 2) secret guard on EVERY collected path — abort, never skip silently ────
const badCollect = items.filter((i) => SECRET_PATTERNS.some((rx) => rx.test(i.rel) || rx.test(i.abs)));
if (badCollect.length > 0) {
  console.error(`ESTATE-VAULT-FAIL: secret-like paths collected — aborting: ${badCollect.slice(0, 6).map((b) => b.rel).join(", ")}`);
  process.exit(1);
}

const totalBytes = items.reduce((a, i) => a + i.bytes, 0);
console.log(`collected: ${items.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB (capsule: ${capName})`);

// ── 3) isolated temp clone — the live working tree is never touched ─────────
const tmp = `/tmp/estate-vault-${Date.now().toString(36)}`;
const clone = run(["git", "clone", "--quiet", REPO, tmp]);
if (!clone.ok) {
  console.error(`ESTATE-VAULT-FAIL: temp clone failed\n${clone.out.slice(0, 300)}`);
  process.exit(1);
}

try {
  run(["git", "checkout", "--quiet", "--orphan", BRANCH], { cwd: tmp, quiet: true });
  run(["git", "rm", "-rf", "--quiet", "."], { cwd: tmp, quiet: true });

  // ── 4) stage the estate (file-by-file copy — robust) ───────────────────────
  for (const i of items) {
    const dst = `${tmp}/${i.rel}`;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(i.abs, dst);
  }

  // a copied .gitignore could shadow evidence — replace with a guard
  rmSync(`${tmp}/.gitignore`, { force: true });
  writeFileSync(`${tmp}/.gitignore`, "*.pem\n*.priv.*\n*.key\nnode_modules/\n.next/\n*.log\n.env*\nupload/\np0-runbook/\n");

  // ── 4b) content-pattern secrets gate on the staged tree (PHASE-0 §4 channel) ──
  // path rules stop pem/env/upload; a token inside a .md or a jobs-line passes those —
  // this scan stops it. fail-closed, output redacted (never the secret itself).
  const gate = scanTree(tmp, { relTo: tmp });
  if (gate.error) {
    console.error(`ESTATE-VAULT-FAIL: secrets-gate scan error — ${gate.error}`);
    process.exit(1);
  }
  if (gate.hits.length > 0) {
    console.error(`ESTATE-VAULT-FAIL: secrets-gate content hits — aborting: ${gate.hits.slice(0, 6).map((h) => `${h.pattern} ${h.file}:${h.line} ${h.preview}`).join(" | ")}`);
    process.exit(1);
  }
  console.log(`secrets-gate: content CLEAN (${gate.filesScanned} staged files, ${(gate.bytesScanned / 1048576).toFixed(1)}MB)`);

  // ── 5) manifest with per-file sha256 — the restore drill verifies against it
  const files = walkFiles(tmp)
    .filter((f) => f !== ".gitignore" && !f.startsWith(".git/"))
    .sort()
    .map((f) => ({ path: f, sha256: sha256(join(tmp, f)), bytes: statSync(join(tmp, f)).size }));
  writeFileSync(
    `${tmp}/VAULT-MANIFEST.json`,
    JSON.stringify(
      {
        vault: "agent4-estate",
        generatedAt: new Date().toISOString(),
        source: CP,
        branch: BRANCH,
        capsule: { name: capName, sha256: sha256(`${SNAP_DIR}/${capName}`) },
        fileCount: files.length,
        totalBytes,
        exclusions: "secrets by policy: *.pem, *.env*, passphrase, upload/, p0-runbook/, keys/* (except public manifest), data/vault/, vault-sealed/",
        files,
      },
      null,
      2
    )
  );
  writeFileSync(
    `${tmp}/PROVENANCE.md`,
    `# Estate vault — agent4 control-plane estate\n\n` +
      `- captured: ${new Date().toISOString()}\n` +
      `- source: ${CP} (the live autonomous network: fleet-runner + money nodes + site)\n` +
      `- branch: ${BRANCH} (snapshot semantics — force-push replaces; archive tag keeps a stable ref)\n` +
      `- capsule: ${capName} (state-backup, quiesce-gated, tear-free)\n\n` +
      `## Restore drill (the only backup that counts is one that was restored)\n\n` +
      "```bash\n" +
      `git clone https://github.com/roshpinacare-sys/roshpina.git && cd roshpina\n` +
      `git checkout ${BRANCH}\n` +
      `jq -r '.files[] | "\\(.sha256)  \\(.path)"' VAULT-MANIFEST.json | sha256sum -c -   # integrity\n` +
      `tar -xzf state/${capName} -C /tmp/restored                                         # money state out\n` +
      "```\n\n" +
      `The capsule unpacks to roshpina data/ledger-net + data/market-net and the runner\n` +
      `data (jobs.jsonl, schedules.json, keys/manifest.json). Identities restore via\n` +
      `operator re-license (private PEMs are intentionally NOT in git — ever).\n`
  );

  // ── 6) commit + fail-closed staged scan ────────────────────────────────────
  run(["git", "-c", "user.name=agent4-fleet", "-c", "user.email=agent4@roshpinacare-sys.local", "add", "-A"], { cwd: tmp, quiet: true });
  const staged = run(["git", "diff", "--cached", "--name-only"], { cwd: tmp, quiet: true }).out.split("\n");
  const badStaged = staged.filter((f) =>
    SECRET_PATTERNS.some((rx) => rx.test(f)) || f.endsWith(".pem") || f.endsWith(".env") || f.includes("upload/") || f.includes("p0-runbook/")
  );
  if (badStaged.length > 0) {
    console.error(`ESTATE-VAULT-FAIL: sensitive files staged — aborting: ${badStaged.slice(0, 6).join(", ")}`);
    process.exit(1);
  }
  const commit = run(
    ["git", "-c", "user.name=agent4-fleet", "-c", "user.email=agent4@roshpinacare-sys.local",
     "commit", "--quiet", "-m", `agent4: estate vault @ ${new Date().toISOString()} — money-state capsule + evidence + DB + worklog (secrets excluded, sha256-manifested)`],
    { cwd: tmp, quiet: true }
  );
  if (!commit.ok) {
    console.error(`ESTATE-VAULT-FAIL: commit failed\n${commit.out.slice(0, 300)}`);
    process.exit(1);
  }

  // ── 7) honest skip: identical tree to the remote tip → no push ─────────────
  let remoteTree = "";
  const fetch = run(["git", "fetch", "--quiet", "origin", BRANCH], { cwd: tmp, quiet: true });
  if (fetch.ok) {
    remoteTree = run(["git", "rev-parse", "--quiet", "--verify", "FETCH_HEAD^{tree}"], { cwd: tmp, quiet: true }).out.trim();
  }
  const localTree = run(["git", "rev-parse", "HEAD^{tree}"], { cwd: tmp, quiet: true }).out.trim();
  if (remoteTree && remoteTree === localTree) {
    console.log("ESTATE-VAULT-SKIP: estate unchanged since last push — honest no-op");
    process.exit(0);
  }

  // ── 8) dual-ref push with self-healing retry (transient GitHub glitches) ───
  // Plus the DAILY ANCHOR: once per UTC day, a date-stamped tag pins that day's
  // estate — off-site retention becomes days-deep, not just the latest push.
  // Branch wipes (measured: 4) can never eat more than the current push window.
  const dailyTag = `estate-daily/${new Date().toISOString().slice(0, 10)}`;
  const tokenUrl = `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`;
  const dailyAnchorExists =
    run(["git", "ls-remote", "--quiet", "--tags", tokenUrl, `refs/tags/${dailyTag}`], { cwd: tmp, quiet: true }).out.trim().length > 0;
  const refspecs = [`${BRANCH}:${BRANCH}`, `+HEAD:refs/tags/archive/${BRANCH}`];
  if (!dailyAnchorExists) refspecs.push(`+HEAD:refs/tags/${dailyTag}`);
  const pushOnce = () => run(
    ["git", "push", "--quiet", "--force", tokenUrl, ...refspecs],
    { cwd: tmp, quiet: true }
  );
  let push = pushOnce();
  if (!push.ok) {
    console.error("ESTATE-VAULT: push failed once — retrying in 15s (transient remote glitches self-heal)");
    await new Promise((r) => setTimeout(r, 15_000));
    push = pushOnce();
  }
  if (!push.ok) {
    console.error(`ESTATE-VAULT-FAIL: push failed twice\n${push.out.slice(0, 300)}`);
    process.exit(1);
  }
  const sha = run(["git", "rev-parse", "--short", "HEAD"], { cwd: tmp, quiet: true }).out.trim();
  console.log("ESTATE-VAULT-OK");
  console.log(`branch:  ${BRANCH} @ ${sha} (dual-ref: branch + archive tag)`);
  console.log(`daily:   ${dailyTag} ${dailyAnchorExists ? "(already anchored today)" : "(NEW daily anchor — day pinned off-site)"}`);
  console.log(`files:   ${items.length} staged, ${files.length} committed (manifest included)`);
  console.log(`capsule: ${capName} — money state survives sandbox wipe`);
  console.log("secrets excluded: *.pem, *.env*, passphrase, upload/, p0-runbook/, keys/* (manifest only)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
