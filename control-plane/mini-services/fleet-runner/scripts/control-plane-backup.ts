/**
 * control-plane-backup — "הקוד חי בגיט, לא בסנדבוקס".
 *
 * צילום מלא של מטוס-הבקרה (/home/z/my-project) לענף `agent4/control-plane` בריפו roshpina,
 * דרך clone זמני מבודד — עץ-העבודה הרץ (ענף P2 שממנו רצים הצמתים) לא נוגע כלל.
 *
 * מוצא מהצילום (סודות ולכלוך בלבד): node_modules, .next, .git, upload/ (טוקנים!),
 * .env, db/, p0-runbook/ (כלי-רוטציה — מחוץ לתחום), tool-results, logs, state-snapshots.
 * כל-פלט מנוקה מהטוקן לפני הדפסה — אפס דליפה לראיות.
 *
 * הענף הוא snapshot-semantics (force-push): כל גיבוי מחליף את קודמו, ההיסטוריה האמיתית
 * של הקוד חיה בענפי העבודה (agent4/p2-sovereign-market וכו').
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { scanTree } from "./secrets-gate.ts";

const CP = "/home/z/my-project";
const REPO = "/home/z/repos/roshpina";
const BRANCH = "agent4/control-plane";
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? `${CP}/upload/pat.env`;

const token = existsSync(TOKEN_FILE)
  ? (readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? "")
  : "";
if (!token) {
  console.error("CONTROL-PLANE-BACKUP-FAIL: no usable token (fail-closed)");
  process.exit(1);
}
const clean = (s: string) => s.split(token).join("***");

function run(cmd: string[], opts?: { cwd?: string; quiet?: boolean }): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out =
    new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  if (!opts?.quiet && out.trim()) console.log(clean(out).trim());
  return { ok: p.exitCode === 0, out: clean(out) };
}

if (!existsSync(`${REPO}/.git`)) {
  console.error(`CONTROL-PLANE-BACKUP-FAIL: roshpina repo missing at ${REPO}`);
  process.exit(1);
}

// 1) isolated temp clone — the live working tree is never touched
const tmp = `/tmp/cp-backup-${Date.now().toString(36)}`;
const clone = run(["git", "clone", "--quiet", REPO, tmp]);
if (!clone.ok) { console.error(`CONTROL-PLANE-BACKUP-FAIL: temp clone failed\n${clone.out.slice(0, 300)}`); process.exit(1); }

try {
  // 2) orphan branch = pure snapshot (no history baggage, no risk to other branches)
  run(["git", "checkout", "--quiet", "--orphan", BRANCH], { cwd: tmp, quiet: true });
  run(["git", "rm", "-rf", "--quiet", "."], { cwd: tmp, quiet: true });

  // 3) copy control-plane tree with explicit exclusions (file-based tar handoff — robust)
  const dest = `${tmp}/control-plane`;
  mkdirSync(dest, { recursive: true });
  const excludes = [
    "./node_modules", "./.next", "./.git", "./upload", "./.env", "./db",
    "./tool-results", "./p0-runbook", "./download", "./.zscripts", "./state-snapshots",
    "./mini-services/fleet-runner/logs", "./bun.lockb", "./next-env.d.ts", "*.pem", "*.priv.*",
    // vendored external reference clones (AutoHedge / agency-agents, public upstreams,
    // URLs recorded in docs/CHANNEL-AUDIT-2026-10-21-AUTOHEDGE-AGENCY.md) — reference
    // material, not sovereign state; live finding 2026-10-21: upstream role cards carry
    // PEM-example text that the secrets-gate correctly refuses to snapshot.
    "./third-party",
  ];
  const archive = `${tmp}.tar`;
  const t = Bun.spawnSync(
    ["tar", "-C", CP, "-cf", archive, ...excludes.map((e) => `--exclude=${e}`), "."],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (t.exitCode !== 0) {
    console.error(`CONTROL-PLANE-BACKUP-FAIL: tar create exit=${t.exitCode}\n${new TextDecoder().decode(t.stderr).slice(0, 300)}`);
    process.exit(1);
  }
  const x = Bun.spawnSync(["tar", "-C", dest, "-xf", archive], { stdout: "pipe", stderr: "pipe" });
  if (x.exitCode !== 0) {
    console.error(`CONTROL-PLANE-BACKUP-FAIL: tar extract exit=${x.exitCode}\n${new TextDecoder().decode(x.stderr).slice(0, 300)}`);
    process.exit(1);
  }
  rmSync(archive, { force: true });
  // a copied .gitignore could shadow evidence — replace with a minimal one
  rmSync(`${dest}/.gitignore`, { force: true });
  writeFileSync(`${dest}/.gitignore`, "node_modules\n.next\n*.log\n");
  // CRITICAL: `git rm -rf .` deleted the repo's root .gitignore (which carried *.pem etc.) —
  // restore a root guard BEFORE `git add -A`, or local dev keys get committed.
  writeFileSync(`${tmp}/.gitignore`, "*.pem\n*.priv.*\n*.key\nnode_modules/\n.next/\n*.log\n.env*\nupload/\n");
  writeFileSync(
    `${dest}/PROVENANCE.md`,
    `# Control-plane snapshot\n\n- source: ${CP}\n- captured: ${new Date().toISOString()}\n- branch: ${BRANCH} (snapshot semantics — force-push replaces)\n- exclusions (secrets/junk): node_modules, .next, .git, upload/, .env, db/, p0-runbook/, tool-results, logs, state-snapshots\n- money-node runtime state: NOT here (see fleet-runner/scripts/state-backup.ts — data/ is gitignored by design)\n`
  );

  // 4) commit + force-push (token never printed — output sanitized)
  const count = run(["bash", "-c", `find control-plane -type f | wc -l`], { cwd: tmp, quiet: true }).out.trim();
  run(["git", "-c", "user.name=agent4-fleet", "-c", "user.email=agent4@roshpinacare-sys.local", "add", "-A"], { cwd: tmp, quiet: true });
  // fail-closed assertion: no secrets may ever be staged — abort before commit
  const staged = run(["git", "diff", "--cached", "--name-only"], { cwd: tmp, quiet: true }).out.split("\n");
  const bad = staged.filter((f) => f.endsWith(".pem") || f.endsWith(".env") || f.includes("upload/") || f.includes("p0-runbook/"));
  if (bad.length > 0) {
    console.error(`CONTROL-PLANE-BACKUP-FAIL: sensitive files staged — aborting: ${bad.slice(0, 5).join(", ")}`);
    process.exit(1);
  }
  // PHASE-0 §4 channel (channel-audit 40-b): path checks miss a token inside a .md —
  // content-pattern scan of the whole staged tree, fail-closed, output redacted.
  const gate = scanTree(tmp, { relTo: tmp });
  if (gate.error) {
    console.error(`CONTROL-PLANE-BACKUP-FAIL: secrets-gate scan error — ${gate.error}`);
    process.exit(1);
  }
  if (gate.hits.length > 0) {
    console.error(`CONTROL-PLANE-BACKUP-FAIL: secrets-gate content hits — aborting: ${gate.hits.slice(0, 5).map((h) => `${h.pattern} ${h.file}:${h.line} ${h.preview}`).join(" | ")}`);
    process.exit(1);
  }
  console.log(`secrets-gate: content CLEAN (${gate.filesScanned} staged files, ${(gate.bytesScanned / 1048576).toFixed(1)}MB)`);
  const commit = run(
    ["git", "-c", "user.name=agent4-fleet", "-c", "user.email=agent4@roshpinacare-sys.local",
     "commit", "--quiet", "-m", `agent4: control-plane snapshot @ ${new Date().toISOString()} — runner+UI+scripts+evidence (secrets excluded)`],
    { cwd: tmp, quiet: true }
  );
  if (!commit.ok) { console.error(`CONTROL-PLANE-BACKUP-FAIL: commit failed\n${commit.out.slice(0, 300)}`); process.exit(1); }
  // R42 (measured in the 2026-10-20T12:2x–13:1x environment-rewind incident): a
  // post-incident snapshot run can overwrite the archive tag with a WORSE world —
  // yet the pre-overwrite object survives on GitHub and stays fetchable BY SHA
  // (proven live: 5cb1081 was recovered exactly this way after its ref was
  // force-pushed over). So: record the current archive-tag sha BEFORE every
  // overwrite — the evidence trail that makes rollback possible with no human.
  const prev = run(
    ["git", "ls-remote", `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`, `refs/tags/archive/${BRANCH}`],
    { cwd: tmp, quiet: true }
  );
  const prevSha = prev.out.trim().split("\t")[0] ?? "";
  if (prevSha) console.log(`CONTROL-PLANE-BACKUP: overwriting archive tag — previous object ${prevSha.slice(0, 7)} remains fetchable by SHA (R42)`);
  // Dual-ref push: the branch AND the archive tag. Branches get deleted by
  // other fleet streams (measured: 3 wipes) — the archive tag is the stable
  // home. Both get the same snapshot, so either alone restores the control plane.
  // Transient GitHub-side storage glitches (live 11:52: "unable to write pack —
  // No such file or directory") retry once after 15s before declaring failure.
  const pushOnce = () => run(
    ["git", "push", "--quiet", "--force", `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`,
     `${BRANCH}:${BRANCH}`, `+HEAD:refs/tags/archive/${BRANCH}`],
    { cwd: tmp, quiet: true }
  );
  let push = pushOnce();
  if (!push.ok) {
    console.error("CONTROL-PLANE-BACKUP: push failed once — retrying in 15s (transient remote glitches self-heal)");
    await new Promise((r) => setTimeout(r, 15_000));
    push = pushOnce();
  }
  if (!push.ok) { console.error(`CONTROL-PLANE-BACKUP-FAIL: push failed twice\n${push.out.slice(0, 300)}`); process.exit(1); }
  const sha = run(["git", "rev-parse", "--short", "HEAD"], { cwd: tmp, quiet: true }).out.trim();

  console.log("CONTROL-PLANE-BACKUP-OK");
  console.log(`branch: ${BRANCH} @ ${sha} (dual-ref: branch + archive tag)`);
  console.log(`files:  ${count} under control-plane/`);
  console.log("secrets excluded: upload/, .env, db/, *.pem, p0-runbook/");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
