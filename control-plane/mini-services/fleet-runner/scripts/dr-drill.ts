/**
 * dr-drill — תרגיל-אסון חי: העיקרה קמה מהגיט בלבד.
 *
 * ההוכחה הכי-קשה שקיימת: לוקחים את שני-המקורות-מ-origin (קוד מתג-ה-archive של
 * ענף-העבודה + קפסולת-המצב מענף agent4/estate-vault), בונים עולם-חדש ב-/tmp,
 * ומקימים את שני-צמתי-הכסף חיים מהמצב-המשוחזר. אפס-גישה לדיסק-הייצור:
 * הקפסולה שנבדקת היא זו-שבגיטהאב, לא העותק המקומי.
 *
 * שערי-כנות (fail-closed, כל-כישלון = exit 1):
 *   (0) טיסה-מקדימה: פורטי-התרגיל חייבים להיות פנויים — סביבה-נגועה (תהליך-
 *       DR זליג-שלאחר-ריצה) מסרבת-לרוץ, לעולם לא "עובדת-במקרה" על תהליך-ישן
 *   (1) שלמות: sha256sum -c מול VAULT-MANIFEST של ענף-ה-estate מ-origin
 *   (2) ledger קם עם verify:"full" (יומן-פגום מסרב לקום — מובנה ב-serve.ts)
 *       ומדווח seq ≥ 100 וחשבונות ≥ 5 מהמצב-המשוחזר
 *   (3) market קם ומדווח עסקאות ≥ 10 מהמצב-המשוחזר
 *
 * מוסר-המחלקה (באג-חי 9, 2026-10-18): process.exit() בתוך-try מדלג על finally —
 * ריצה-כושלת השאירה תהליך-DR זליג על-הפורט. התיקון עד-השורש: fail() זורק
 * (לעולם לא exit באמצע), ה-cleanup רץ ב-true-finally, וה-exit היחיד — אחריו.
 *
 * ניקוי-מלא בכל-נתיב: תהליכים נהרגים, /tmp נמחק. פורטים זמניים 3055/3056 —
 * לעולם לא נוגעים ב-3032/3033 של הייצור.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { cpSync } from "fs";

const REPO = "/home/z/repos/roshpina";
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? "/home/z/my-project/upload/pat.env";
const CODE_TAG = "archive/agent4/p2-sovereign-market"; // the work branch's stable mirror
const ESTATE_BRANCH = "agent4/estate-vault";
const DR_LEDGER_PORT = 3055;
const DR_MARKET_PORT = 3056;
const FLOOR = { ledgerSeq: 100, ledgerAccounts: 5, marketTrades: 10 };

const token = existsSync(TOKEN_FILE)
  ? (readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? "")
  : "";
if (!token) {
  console.error("DR-DRILL-FAIL: no usable token (fail-closed) — nothing live spawned yet, safe to exit");
  process.exit(1);
}
const clean = (s: string) => s.split(token).join("***");
const tokenUrl = `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`;

function run(cmd: string[], opts?: { cwd?: string; quiet?: boolean }): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  if (!opts?.quiet && out.trim()) console.log(clean(out).trim());
  return { ok: p.exitCode === 0, out: clean(out) };
}

if (!existsSync(`${REPO}/.git`)) {
  console.error(`DR-DRILL-FAIL: roshpina repo missing at ${REPO} — nothing live spawned yet, safe to exit`);
  process.exit(1);
}

let failed = false;
/** The ONLY failure path once the world is being built: throw → true-finally cleans → exit after. */
const fail = (msg: string): never => {
  failed = true;
  console.error(msg);
  throw new Error("dr-drill-failed");
};

const work = `/tmp/dr-drill-${Date.now().toString(36)}`;
mkdirSync(work, { recursive: true });
const procs: Bun.Subprocess[] = [];

async function waitHealthy(port: number, what: string, proc?: Bun.Subprocess, timeoutMs = 25_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (body) return body as Record<string, unknown>;
    await Bun.sleep(600);
  }
  if (proc) {
    try {
      proc.kill();
      const err = await new Response(proc.stderr).text();
      if (err.trim()) console.error(`--- ${what} stderr tail ---\n${clean(err.trim().split("\n").slice(-8).join("\n"))}`);
    } catch { /* already gone */ }
  }
  fail(`DR-DRILL-FAIL: ${what} did not come healthy on :${port} within ${timeoutMs / 1000}s`);
}

try {
  // ── 0) pre-flight: the drill ports must be FREE — a contaminated environment
  //        (a leaked DR process from a previous broken run) refuses to drill,
  //        because a "healthy" poll could be reading a stale impostor.
  for (const port of [DR_LEDGER_PORT, DR_MARKET_PORT]) {
    const busy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) }).then((r) => r.ok).catch(() => false);
    if (busy) fail(`DR-DRILL-FAIL: port ${port} is already serving BEFORE the drill — stale DR process (contaminated env); clean it first (fail-closed, never drill against an impostor)`);
  }

  // ── 1) estate capsule from ORIGIN (never the local disk copy) ──────────────
  // הענף ב-origin נמחק-שוב-ושוב (wipe #1–7 נמדדו) — תג-ה-archive מחזיק את-אותו-עץ ואותו-מניפסט.
  // ניסיון-ענף קודם, נפילה-כנה לתג; שניהם-נכשלו = fail-closed.
  console.log(`[1/5] cloning estate state from origin (depth 1)…`);
  const estateDir = `${work}/estate`;
  const estateTag = ESTATE_BRANCH.replace(/^agent4\//, "archive/agent4/");
  let estateSource = ESTATE_BRANCH;
  let ce = run(["git", "clone", "--quiet", "--depth", "1", "--branch", ESTATE_BRANCH, tokenUrl, estateDir]);
  if (!ce.ok) {
    try { rmSync(estateDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    console.log(`      branch ${ESTATE_BRANCH} unavailable at origin — falling back to archive tag ${estateTag} (same tree, same manifest)`);
    ce = run(["git", "clone", "--quiet", "--depth", "1", "--branch", estateTag, tokenUrl, estateDir]);
    estateSource = estateTag;
  }
  if (!ce.ok) fail(`DR-DRILL-FAIL: estate clone failed from BOTH branch and archive tag\n${ce.out.slice(0, 300)}`);

  const capsules = readdirSync(`${estateDir}/state`).filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz"));
  if (capsules.length !== 1) fail(`DR-DRILL-FAIL: expected exactly 1 capsule on ${ESTATE_BRANCH}, found ${capsules.length}`);
  const capsule = `state/${capsules[0]}`;

  // ── 2) integrity gate: sha256 vs the manifest, on the origin copy ──────────
  console.log(`[2/5] integrity gate: sha256 vs VAULT-MANIFEST (${capsule})…`);
  const iv = run(["bash", "-c", `jq -r '.files[] | "\\(.sha256)  \\(.path)"' VAULT-MANIFEST.json | sha256sum -c - --quiet && echo INTEGRITY-OK`], { cwd: estateDir, quiet: true });
  if (!iv.ok || !iv.out.includes("INTEGRITY-OK")) fail(`DR-DRILL-FAIL: integrity gate failed\n${iv.out.slice(0, 300)}`);

  // ── 3) code from the work branch's archive tag on ORIGIN ───────────────────
  console.log(`[3/5] cloning production code from origin tag ${CODE_TAG} (depth 1)…`);
  const codeDir = `${work}/code`;
  const cc = run(["git", "clone", "--quiet", "--depth", "1", "--branch", CODE_TAG, tokenUrl, codeDir]);
  if (!cc.ok) fail(`DR-DRILL-FAIL: code clone failed\n${cc.out.slice(0, 300)}`);

  const x = run(["tar", "-xzf", capsule], { cwd: estateDir, quiet: true });
  if (!x.ok) fail(`DR-DRILL-FAIL: capsule extraction failed\n${x.out.slice(0, 200)}`);
  const restoredData = `${estateDir}/data`;
  if (!existsSync(`${restoredData}/ledger-net`) || !existsSync(`${restoredData}/market-net`)) {
    fail("DR-DRILL-FAIL: capsule did not unpack ledger-net/market-net");
  }
  cpSync(restoredData, `${codeDir}/data`, { recursive: true });

  // ── 4) boot the ledger node from the restored state ────────────────────────
  console.log(`[4/5] booting DR ledger on :${DR_LEDGER_PORT} from restored state (verify:"full")…`);
  const ledger = Bun.spawn(["bun", "serve.ts"], {
    cwd: codeDir,
    env: { ...process.env, ROSHPINA_PORT: String(DR_LEDGER_PORT), ROSHPINA_DATA_DIR: `${codeDir}/data/ledger-net` },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  procs.push(ledger);
  const lHealth = (await waitHealthy(DR_LEDGER_PORT, "DR ledger", ledger)) as { ok?: boolean; seq?: number; accounts?: number };
  const lSeq = Number(lHealth?.seq ?? 0);
  const lAccounts = Number(lHealth?.accounts ?? 0);
  if (!lHealth?.ok || lSeq < FLOOR.ledgerSeq || lAccounts < FLOOR.ledgerAccounts) {
    fail(`DR-DRILL-FAIL: restored ledger below floor — seq=${lSeq} (floor ${FLOOR.ledgerSeq}), accounts=${lAccounts} (floor ${FLOOR.ledgerAccounts})`);
  }

  // ── 5) boot the market node from the restored state ────────────────────────
  console.log(`[5/5] booting DR market on :${DR_MARKET_PORT} from restored state…`);
  const market = Bun.spawn(["bun", "market-serve.ts"], {
    cwd: codeDir,
    env: { ...process.env, ROSHPINA_PORT: String(DR_MARKET_PORT), ROSHPINA_DATA_DIR: `${codeDir}/data/market-net` },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  procs.push(market);
  const mHealth = (await waitHealthy(DR_MARKET_PORT, "DR market", market)) as { ok?: boolean; trades?: number; bids?: number; asks?: number };
  const mTrades = Number(mHealth?.trades ?? 0);
  if (!mHealth?.ok || mTrades < FLOOR.marketTrades) {
    fail(`DR-DRILL-FAIL: restored market below floor — trades=${mTrades} (floor ${FLOOR.marketTrades})`);
  }

  console.log("DR-DRILL-OK — the estate stands back up from git alone");
  console.log(`integrity: INTEGRITY-OK (sha256, capsule ${capsule} from origin)`);
  console.log(`ledger:  seq=${lSeq} accounts=${lAccounts} (verify:"full" passed, boot refused nothing)`);
  console.log(`market:  trades=${mTrades} book=${mHealth?.bids}x${mHealth?.asks}`);
  console.log(`sources: code=${CODE_TAG} · state=${estateSource} — zero production disk touched`);
} catch (e) {
  if (!(e instanceof Error && e.message === "dr-drill-failed")) {
    failed = true;
    console.error(`DR-DRILL-FAIL: unexpected error: ${clean(String(e))}`);
  }
} finally {
  // the true-finally: cleanup runs on EVERY path — success, gate failure, crash
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  await Bun.sleep(400);
  rmSync(work, { recursive: true, force: true });
  if (failed) process.exit(1); // the only exit — after cleanup
}
