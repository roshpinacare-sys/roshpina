/**
 * state-backup — קפסולת-מצב של הרשת הריבונית, שורדת מחיקת-סנדבוקס.
 *
 * אורז את המצב המתמיד שאינו בגיט (יומני data/ של roshpina מוגדרים gitignore בכוונה)
 * לתוך /home/z/my-project/state-snapshots — המיקום ששרד את המחיקה האחרונה:
 *   - data/ledger-net  (הספר המתמיד החתום)
 *   - data/market-net  (השוק: יתרות, ספר-זמנות, יומן)
 *   - data/jobs.jsonl + schedules.json + keys/manifest.json של ה-runner (ראיות + תזמונים)
 *
 * מחזיק 10 קפסולות אחרונות. קריאה-חוזרת בטוחה (idempotent). fail-closed: ריפו חסר = כישלון כן.
 *
 * ── חוק-ההשבה (אירוע-חי 2026-10-20 08:12–09:47Z) ─────────────────────────────
 * מרגע שהצומת-הראשון quiesced, הסקריפט הזה חייב להגיע ללולאת-ההשבה בכל-מסלול —
 * כולל-הכישלונות-שלו-עצמו. process.exit() מדלג על בלוקי-finally, ולכן כל-כישלון
 * אחרי-ה-quiesce הוא THROW (ה-finally רץ, הכלכלה משוחררת) ולא exit().
 * exit() מותר אך ורק לפני ה-quiesce הראשון. שלושה-מסלולי-הקפאה שנתפסו באירוע:
 *   (1) ReferenceError ב-finally (stageDir מחוץ-לתחום) — ההשבה לא רצה כלל;
 *   (2) exit(1) על כישלון-tar — מדלג על ה-finally;
 *   (3) exit(1) על סירוב-quiesce של הצומת-השני — הראשון נשאר תקוע.
 * מתקן-עצמאי לשחרור קפוא: scripts/resume-money.ts (זהה-סמכות, לא-תלוי-כאן).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "fs";

const ROSHPINA = "/home/z/repos/roshpina";
const SNAP_DIR = "/home/z/my-project/state-snapshots";
const RUNNER_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const KEEP = 10;

if (!existsSync(`${ROSHPINA}/serve.ts`)) {
  console.error(`STATE-BACKUP-FAIL: roshpina repo missing at ${ROSHPINA} (start-nodes.sh will heal it)`);
  process.exit(1); // מותר: לפני כל-quiesce — אין-צומת-שעלול-להיתקע
}

mkdirSync(SNAP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `${SNAP_DIR}/state-${stamp}.tar.gz`;

// ── 0) quiesce the money nodes — the tear-free capsule gate ──────────────────
// The live bug of the 06:06 reboot: the old capsule tarred LIVE data dirs, and
// a trade landing mid-tar tore it (ledger newer than the market journal) — the
// next boot resurrected orders whose escrow backing was already swept (a
// -22.8M µ¢ degraded book). While quiesced, nodes refuse every mutation, so
// the tar is internally consistent. Fail-closed: a refused quiesce aborts the
// backup — a torn capsule is worse than no capsule. A DOWN node needs no gate
// (its files are stable). The operator signs — the same local dev keys the
// nodes already trust. NOTE: private PEMs deliberately stay OUT of the capsule
// (capsules are pushed off-site to git by estate-vault) — identity is restored by operator
// re-license, not by copying keys around.
const KEYS = `${RUNNER_ROOT}/data/keys`;
const MONEY_NODES = [
  { name: "ledger", url: "http://127.0.0.1:3032" },
  { name: "market", url: "http://127.0.0.1:3033" },
];

if (!existsSync(`${KEYS}/operator.priv.pem`)) {
  console.error("STATE-BACKUP-FAIL: operator dev keys missing — cannot sign the quiesce gate (fail-closed)");
  process.exit(1); // מותר: לפני כל-quiesce
}

// ההצהרות האלה חייבות להיות בתחום-הראייה של ה-finally — האירוע של 09:28 היה בדיוק
// stageDir שהוגדר בתוך ה-try וה-finally לא ראה אותו (ReferenceError) וההשבה מתה.
const quiescedUrls: string[] = [];
let tarOk = false;
let stageDir: string | null = null;

try {
  const { AgentClient } = await import("/home/z/repos/roshpina/kernel/fleet/sovereign-agents");
  const { sha256Hex } = await import("/home/z/repos/roshpina/src/lib/route-auth");
  const publicPem = (await Bun.file(`${KEYS}/operator.pub.pem`).text()).trim();
  const privatePem = (await Bun.file(`${KEYS}/operator.priv.pem`).text()).trim();
  const keys = { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem).slice(0, 16) };

  for (const n of MONEY_NODES) {
    const up = await fetch(`${n.url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    if (!up) continue; // down = stable = safe to tar ungated
    const r = await new AgentClient(n.url, keys).post("/internal/quiesce", { on: true });
    if (r.status !== 200) {
      // THROW, לא exit — כל-צומת-שכבר-quiesced משוחרר ב-finally למטה
      throw new Error(`STATE-BACKUP-FAIL: ${n.name} refused quiesce (http ${r.status}) — aborting (no torn capsules); already-quiesced nodes are released below`);
    }
    quiescedUrls.push(n.url);
  }
  console.log(`quiesced: ${quiescedUrls.length ? quiescedUrls.join(", ") : "(nodes down — stable, ungated)"}`);

  // build tar args: repo data dirs that exist + runner evidence/schedule state.
  // Live bug 2026-10-20 08:12Z: tar read jobs.jsonl while the fleet appended to
  // it → "file changed as we read it" → capsule refused (fail-closed, honest).
  // Root fix: the runner's single-file pieces are STAGED (copied) first — tar
  // packs the stable stage. Honest trade: the stage may miss the very last
  // concurrent journal line (tolerable for evidence backups); the money dirs
  // stay packed live because the quiesce gate above guarantees stability.
  const args = ["tar", "-czf", out];
  const repoPieces = ["data/ledger-net", "data/market-net"].filter((p) => existsSync(`${ROSHPINA}/${p}`));
  for (const p of repoPieces) args.push("-C", ROSHPINA, p);
  const runnerPieces = ["data/jobs.jsonl", "data/schedules.json", "data/keys/manifest.json"].filter((p) =>
    existsSync(`${RUNNER_ROOT}/${p}`)
  );
  if (runnerPieces.length) {
    stageDir = `${RUNNER_ROOT}/data/.backup-stage-${stamp}`;
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    for (const p of runnerPieces) {
      const dest = `${stageDir}/${p}`;
      mkdirSync(dest.split("/").slice(0, -1).join("/"), { recursive: true });
      cpSync(`${RUNNER_ROOT}/${p}`, dest);
    }
    for (const p of runnerPieces) args.push("-C", stageDir, p);
  }

  if (repoPieces.length === 0) {
    // THROW, לא exit — הצמתים כבר quiesced
    throw new Error("STATE-BACKUP-FAIL: no ledger/market data dirs found (fresh box before first heal?)");
  }

  const proc = Bun.spawnSync(args);
  if (proc.exitCode !== 0) {
    // THROW, לא exit — הצמתים כבר quiesced
    throw new Error(`STATE-BACKUP-FAIL: tar exit=${proc.exitCode}\n${new TextDecoder().decode(proc.stderr).slice(0, 400)}`);
  }
  tarOk = true;

  // prune: keep the newest KEEP capsules (timestamped names sort chronologically)
  const all = readdirSync(SNAP_DIR)
    .filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz"))
    .sort();
  const removed: string[] = [];
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) {
    try { unlinkSync(`${SNAP_DIR}/${f}`); removed.push(f); } catch { /* keep going */ }
  }

  const size = statSync(out).size;
  console.log("STATE-BACKUP-OK");
  console.log(`capsule: ${out} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`packed:  roshpina[${repoPieces.join(", ")}] runner[${runnerPieces.join(", ")}]`);
  console.log(`retained: ${Math.min(all.length, KEEP)} capsules${removed.length ? ` (pruned ${removed.length} old)` : ""}`);
} finally {
  if (stageDir) { try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* keep going */ } }
  // ── resume the market in EVERY path — a stuck quiesce is a frozen economy ──
  // לולאה-זו היא חובה-מבנית: רצה בכל-יציאה מה-try (הצלחה, throw, מה-שלא-יהיה).
  for (const url of quiescedUrls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const alive = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }).then((x) => x.ok).catch(() => false);
        if (!alive) break; // node went down — quiesce dies with it
        const { AgentClient } = await import("/home/z/repos/roshpina/kernel/fleet/sovereign-agents");
        const { sha256Hex } = await import("/home/z/repos/roshpina/src/lib/route-auth");
        const publicPem = (await Bun.file(`${KEYS}/operator.pub.pem`).text()).trim();
        const privatePem = (await Bun.file(`${KEYS}/operator.priv.pem`).text()).trim();
        const keys = { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem).slice(0, 16) };
        const res = await new AgentClient(url, keys).post("/internal/quiesce", { on: false });
        if (res.status === 200) break;
      } catch { /* retry */ }
      if (attempt === 3) console.error(`STATE-BACKUP-CRITICAL: failed to RESUME ${url} after 3 attempts — the node may stay quiesced! Run now: bun scripts/resume-money.ts`);
      else await Bun.sleep(500);
    }
  }
  if (!tarOk && quiescedUrls.length) console.error("STATE-BACKUP-FAIL: tar did not complete — nodes resumed, no capsule written");
}
