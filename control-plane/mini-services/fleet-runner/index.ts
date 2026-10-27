/**
 * fleet-runner — the execution network's runner node (port 3031).
 *
 * הרשת-שמבצעת: שירות אמיתי שמריץ עבודות אמיתיות (lint, טסטים, סריקות)
 * על העץ האמיתי שלנו — /home/z/my-project ו-/home/z/repos — ומפיק ראיות:
 * stdout/stderr מלאים, קוד-יציאה, משך, ויומן JSONL append-only בדיסק.
 *
 * אפס-תלות-חוץ (Bun.serve בלבד). אין-פקודות שרירותיות: רק whitelist.
 * כל-קריאה חוזרת נתונים אמיתיים — אין-מצב-מדומה, אין-סימולציה.
 */

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "fs";

// ─── Singleton guard: one runner, one scheduler (atomic, O_EXCL) ─────────────
// The 06:06 reboot class: the sandbox supervisor started `bun run dev` twice.
// The original check-then-write pidfile had a TOCTOU race — both instances
// booted in the same second, both read "no pidfile", both kept live scheduler
// timers (registered before Bun.serve). Fix: the lock is an O_EXCL create —
// atomic at the kernel level. The file's EXISTENCE is the lock. A dead holder
// (stale lock) → unlink + retry. bun --hot re-evaluates with the same pid →
// reclaims its own lock. No timer is registered until the lock is held.
const RUNNER_LOCKFILE = "/tmp/fleet-runner.lock";
const RUNNER_PIDFILE = "/tmp/fleet-runner.pid";
const acquireRunnerLock = (): boolean => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(RUNNER_LOCKFILE, "wx"); // O_CREAT|O_EXCL — atomic
      try { writeSync(fd, String(process.pid)); } catch { /* observability only */ }
      return true; // fd intentionally left open — we hold the lock for life
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    let holderPid = -1;
    try { holderPid = Number(readFileSync(RUNNER_LOCKFILE, "utf8").trim()); } catch { holderPid = -1; }
    if (holderPid === process.pid) return true; // bun --hot re-evaluation — our own lock
    let alive = false;
    try { if (holderPid > 0) { process.kill(holderPid, 0); alive = true; } } catch { alive = false; }
    if (alive) return false; // another LIVE runner holds the scheduler
    try { unlinkSync(RUNNER_LOCKFILE); } catch { /* raced away */ }
  }
  return false;
};
if (!acquireRunnerLock()) {
  console.error(`[fleet-runner] another LIVE instance holds the scheduler (${RUNNER_LOCKFILE}) — exiting before any timer is registered`);
  process.exit(0);
}
try { writeFileSync(RUNNER_PIDFILE, String(process.pid)); } catch { /* observability only */ }

const PORT = 3031;
const STARTED_AT = Date.now();
const WORKSPACE = "/home/z/my-project";
const ROSHPINA = "/home/z/repos/roshpina";
const RUNNER_DIR = import.meta.dir;
const DATA_DIR = `${RUNNER_DIR}/data`;
const JOBS_JSONL = `${DATA_DIR}/jobs.jsonl`;
mkdirSync(DATA_DIR, { recursive: true });
const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB cap per stream
const MAX_CONCURRENT = 3;

// ─── Owner gate (vault-backed, deny-by-default) ──────────────────────────────
// 2026-10-25 hardening directive: no state mutation and no full job-output read
// without a token derived from the encrypted vault's own secret. The token is
// never stored anywhere — derived at boot from the local-only passphrase file.
// Passphrase unreadable → token null → EVERY mutation denied (fail-closed).
const VAULT_PASSPHRASE_FILE = "/home/z/my-project/upload/vault.passphrase";
const deriveOwnerToken = (pass: string): string =>
  new Bun.CryptoHasher("sha256").update(`${pass.trim()}\nowner-gate-v1`).digest("hex");
let OWNER_TOKEN: string | null = null;
try {
  OWNER_TOKEN = deriveOwnerToken(readFileSync(VAULT_PASSPHRASE_FILE, "utf8"));
  console.log("[fleet-runner] owner gate ARMED — vault-derived token, deny-by-default on mutations");
} catch {
  OWNER_TOKEN = null;
  console.error("[fleet-runner] owner gate FAIL-CLOSED: vault passphrase unreadable — all mutations denied");
}
const SECURITY_DIR = `${DATA_DIR}/security`;
const DENIALS_JSONL = `${SECURITY_DIR}/denials.jsonl`;
const timingSafeEq = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const ownerOk = (req: Request): boolean =>
  OWNER_TOKEN !== null && timingSafeEq(String(req.headers.get("x-owner-token") ?? ""), OWNER_TOKEN);
const denyOwner = (req: Request, path: string): Response => {
  const rec = { at: new Date().toISOString(), ip: req.headers.get("x-forwarded-for") ?? "", method: req.method, path };
  try { mkdirSync(SECURITY_DIR, { recursive: true }); appendFileSync(DENIALS_JSONL, `${JSON.stringify(rec)}\n`); } catch { /* journal is best-effort */ }
  console.warn(`[fleet-runner] OWNER-DENIED ${rec.method} ${rec.path} ip=${rec.ip || "local"}`);
  return json(401, { error: "owner_auth_required", hint: "POST /api/owner/unlock with the vault passphrase" });
};

// ─── Node registry: the real network ─────────────────────────────────────────

const NODES = [
  { id: "control-plane", name: "Control Plane", port: 3000, url: "http://127.0.0.1:3000/", kind: "ui" },
  { id: "runner", name: "Fleet Runner", port: 3031, url: "http://127.0.0.1:3031/health", kind: "runner" },
  { id: "ledger", name: "Roshpina Ledger (P1)", port: 3032, url: "http://127.0.0.1:3032/health", kind: "money" },
  { id: "market", name: "Sovereign Market (P2)", port: 3033, url: "http://127.0.0.1:3033/health", kind: "money" },
];

// ─── Job presets: whitelisted real work ──────────────────────────────────────

type Preset = {
  id: string;
  label: string;
  description: string;
  cwd: string;
  cmd: string[];
  timeoutMs: number;
  argSpec?: { name: string; pattern: string; required: boolean }[]; // whitelisted parameters only — fail-closed
};

const PRESETS: Record<string, Preset> = {
  "health-sweep": {
    id: "health-sweep",
    label: "סריקת-חיות הרשת",
    description: "מציב פינג אמיתי מול כל-4 הצמתים ומדפיס טבלת חיות + עומס-זמן",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/health-sweep.ts"],
    timeoutMs: 30_000,
  },
  "nodes-up": {
    id: "nodes-up",
    label: "הקמת צמתים (idempotent)",
    description: "מריץ start-nodes.sh — מקים ledger/market אם-ורק-אם הם לא-למעלה; לא-נוגע בשום-דבר אחר",
    cwd: RUNNER_DIR,
    cmd: ["bash", "start-nodes.sh"],
    timeoutMs: 60_000,
  },
  "execution-ledger-renew": {
    id: "execution-ledger-renew",
    label: "חידוש-ספר-ההוצאה-לפועל (directive 42 §2)",
    description: "מפרסם execution-state.json מחדש על Domain + אתר-השורש — lineage-preserving, כל-מספר נמדד בזמן-החידוש (trace 1a178c71bcb7ddad)",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/execution-ledger-renew.ts"],
    timeoutMs: 120_000,
  },
  "fixedfloat-quote": {
    id: "fixedfloat-quote",
    label: "ציטוט FixedFloat חתום (מסילת-המרות)",
    description: "אימות HMAC מול ff.io v2 + ציטוט חי + כיסוי-מטבעות כנה (HIVE/STEEM לא-רשומים — נמדד); fail-closed על כספת-חסרה",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/fixedfloat-quote.ts"],
    timeoutMs: 45_000,
  },
  "chain-audit": {
    id: "chain-audit",
    label: "ביקורת-שרשרת בלתי-תלויה",
    description: "מחשב-מחדש את שרשרת-ה-hash של הפנקס מהדיסק במימוש עצמאי (בלי לייבא את הקרנל), מאמת עיגון-snapshot וצליבה מול הצומת החי — אפס-אמון בטענת הפנקס על עצמו",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/chain-audit.ts"],
    timeoutMs: 60_000,
  },
  "capability-audit": {
    id: "capability-audit",
    label: "מטריצת-יכולות כנה",
    description: "מודד מה-הארכיטקטורה יודעת-לעשות-לבד (עשר-טענות-נמדדות-חי) ומצהיר בכנות מה-עדיין-דורש-בעלים-אנושי (חמישה-פערים, כל-מיתוג-נמדד) — fail-closed על כל-שורה-נכשלת; המטריצה-שמונעת-שקר-יכולות",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/capability-audit.ts"],
    timeoutMs: 60_000,
  },
  "sovereign-decisions": {
    id: "sovereign-decisions",
    label: "מועצת-הריבון — החלטות-בעלים",
    description: "חוק-R40: הארכיטקטורה מחליטה ולא ממתינה לבעלים — אוספת אמת מהקרקע (צמתים, refs מרוחקים, קפסולה, אורקל), מכריעה על-פי-חוקים, מבצעת מיד (שחזור-refs-שנמחקו, ריפוי-צמתים, רענון-קפסולה/אורקל) ורושמת כל-החלטה ביומן data/sovereign/decisions.jsonl; החלטת-החזק נרשמת בדיוק כמו פעולה",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/sovereign-decisions.ts"],
    timeoutMs: 120_000,
  },
  "secrets-gate": {
    id: "secrets-gate",
    label: "שער-סודות — סריקת-תוכן קדם-דחיפה",
    description: "תעלה של PHASE-0 §4 (ערכת-היגיינת-המפתחות של הצי, R130): סורק את תוכן כל-קובץ ב-HEAD של ענף-הרשת ב-7 תבניות-סוד בביטחון-גבוה (PAT/PEM/WIF/AWS/AI/Slack/Google) — לא רק נתיבים; פגיעה אחת = exit 1 (fail-closed); הפלט מצונזר — אף-ערך-סוד לא נדפס ולא נשמר",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/secrets-gate.ts", "lane"],
    timeoutMs: 60_000,
  },
  lint: {
    id: "lint",
    label: "Lint — מיזם הבקרה",
    description: "bun run lint על /home/z/my-project",
    cwd: WORKSPACE,
    cmd: ["bun", "run", "lint"],
    timeoutMs: 120_000,
  },
  "kernel-tests": {
    id: "kernel-tests",
    label: "טסטי הגרעין (21)",
    description: "bun test kernel/ ב-roshpina — 11 ledger + 10 book, הסוויטה המוכחת",
    cwd: ROSHPINA,
    cmd: ["bun", "test", "kernel/"],
    timeoutMs: 120_000,
  },
  "kernel-smoke": {
    id: "kernel-smoke",
    label: "Smoke הגרעין (13)",
    description: "bun run kernel-smoke.ts ב-roshpina — 13 הוכחות הגרעין החי",
    cwd: ROSHPINA,
    cmd: ["bun", "run", "kernel-smoke.ts"],
    timeoutMs: 120_000,
  },
  "git-sweep": {
    id: "git-sweep",
    label: "סריקת-git הצי",
    description: "ענף, מצב-לא-מקומט וקומיט-אחרון לכל-ריפו תחת /home/z/repos",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/git-sweep.ts"],
    timeoutMs: 60_000,
  },
  "machine-facts": {
    id: "machine-facts",
    label: "עובדות-מכונה",
    description: "uname, uptime, דיסק, זיכרון — העובדות החיות של הסנדבוקס",
    cwd: RUNNER_DIR,
    cmd: ["bash", "-c", "uname -a; echo; uptime; echo; df -h / | tail -1; echo; free -m | head -2"],
    timeoutMs: 15_000,
  },
  "economy-run": {
    id: "economy-run",
    label: "כלכלה-חיה — סוכנים סוחרים",
    description: "צי-סוכנים ריבוני חתום (Ed25519, 4 ליבה + חברים-מורשים — 10 נכון-ל-Task 27) סוחר מול צומת-השוק החי:3033 — שימור-כסף נאכף-לכל-טיק, הפרה = כישלון",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/economy-run.ts", "30"],
    timeoutMs: 180_000,
  },
  "market-report": {
    id: "market-report",
    label: "דוח-שוק (קריאה-בלבד)",
    description: "ספר-הזמנות, יתרות-סוכנים, עמלות-אמת ובדיקת-שימור — מהנתונים-החיים של :3033",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/market-report.ts"],
    timeoutMs: 30_000,
  },
  "ledger-sync": {
    id: "ledger-sync",
    label: "סנכרון-ספר — שוק → ledger",
    description: "שכבת-ההסתלקות: יתרות-הסוכנים והעמלות מהשוק החי נרשמות כרשומות-חתומות בספר-המתמיד :3032 — דלתא מהאמת, idempotent, עם התכנסות",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/ledger-sync.ts"],
    timeoutMs: 90_000,
  },
  "ledger-report": {
    id: "ledger-report",
    label: "דוח-התאמה שוק↔ספר (קריאה-בלבד)",
    description: "טבלת-אמת: מה שהשוק רואה מול מה שהספר חייב — לכל-סוכן ומטבע, עמלות, pool ויכולת-פירעון",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/ledger-report.ts"],
    timeoutMs: 30_000,
  },
  "economy-stake": {
    id: "economy-stake",
    label: "סטייקינג — סוכנים נועלים הון",
    description: "כל-סוכן חתום (Ed25519) מגיע בהתכנסות אל 5% סטייק מהחזקותיו מול :3033 — נעילה אמיתית במנוע, idempotent, שימור-נאכף",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/economy-stake.ts"],
    timeoutMs: 60_000,
  },
  "economy-cycle": {
    id: "economy-cycle",
    label: "אפוק-פיסקלי — מיסים/שכר/תגמולים",
    description: "מחזור-שלם של הכלכלה הריבונית: מיסים 0.01% לאוצר ← שכר 100 USDS לכל-סוכן ← 10% מהאוצר לסטייקרים יחסית לסטייק. epoch-שעתי, idempotent, fail-closed",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/economy-cycle.ts"],
    timeoutMs: 60_000,
  },
  "state-backup": {
    id: "state-backup",
    label: "גיבוי-מצב — קפסולת הרשת",
    description: "אריזת יומני ה-ledger והשוק + ראיות ה-runner והתזמונים ל-state-snapshots (שורד מחיקת-סנדבוקס); מחזיק 10 אחרונות",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/state-backup.ts"],
    timeoutMs: 60_000,
  },
  "sovereign-oracle": {
    id: "sovereign-oracle",
    label: "עוגני-מחיר — רשתות-ענק → הרשת שלנו",
    description: "משיכת עוגני-מחיר אמיתיים (BTC/ETH/SOL) מ-Kraken/Bitstamp ציבוריים עם דריכת-מקור מלאה (sha256 תשובה גולמית); קריאה-בלבד, אפס-נגיעה בכסף",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/sovereign-oracle.ts"],
    timeoutMs: 45_000,
  },
  "treasury-report": {
    id: "treasury-report",
    label: "דוח-אוצרה — רווחיות מהשימור",
    description: "הכנסה-אמיתית (עמלות) מ-/economy/report עם holds:true; דלתא מול-הדוח-הקודם = קצב-רווח לשעה; היסטוריה מצטברת ב-data/treasury",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/treasury-report.ts"],
    timeoutMs: 30_000,
  },
  "self-audit": {
    id: "self-audit",
    label: "צוות-אדום עצמי — טענות-מול-מציאות",
    description: "ביקורת-עצמית בלתי-תלויה: שימור · התכנסות-mirror (כולל-סטייק, סבילות-דו-צדדית) · כשירות-פירעון בשני-המודלים-יחד (בלי-מעגליות) · עוגנים-טריים · תזמונים חיים · צמתים חיים; טענה-שנשברה = exit 1",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/self-audit.ts"],
    timeoutMs: 45_000,
  },
  "roast-grill": {
    id: "roast-grill",
    label: "גריל-האמת — ביקורת אדיברסרית עם שיניים",
    description: "צו 1a15f55f6d0395f9: הרשת צולה את-עצמה בלי לסמוך על טענותיה — כל-טענה נגזרת מחדש מפרימיטיבים גולמיים (git-plumbing, ls-remote מאומת, HTTP חי, קריאת-קבצים), הביקורות הקיימות מורצות טרי כטענות-שנבדקות, ובקרות-שלילה מוכיחות שהגריל עצמו מסוגל להיכשל — גריל-בלי-שיניים = גריל-שבור (fail-closed). אמת-כואבת = רועשת, לא מוסתרת",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/roast-grill.ts"],
    timeoutMs: 180_000,
  },
  "agent-pnl": {
    id: "agent-pnl",
    label: "מדד-P&L — ניסוי A/B: מוח-LLM מול אלגוריתמים",
    description: "סקורבורד כסף-חי: שווי-כל-סוכן (USDS+SAOS×mid-הספר) ודלתא מה-baseline המדוד; epsilon (מוח-LLM) מדורג מול האלגוריתמים. שימור-שבור או ספר-ריק = exit 1; אפס-המצאת-היסטוריה",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/agent-pnl.ts"],
    timeoutMs: 45_000,
  },
  "control-plane-backup": {
    id: "control-plane-backup",
    label: "גיבוי מטוס-הבקרה לגיט",
    description: "צילום מלא של קוד מטוס-הבקרה (ללא סודות) לענף agent4/control-plane ב-roshpina ודחיפה — הקוד חי בגיט, לא בסנדבוקס",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/control-plane-backup.ts"],
    timeoutMs: 120_000,
  },
  "estate-vault": {
    id: "estate-vault",
    label: "גיבוי-עיקרה לגיט — מצב-הכסף + ראיות + DB",
    description: "הקפסולה העדכנית + jobs.jsonl + תזמונים + build/ai/insights + 150 פלטים אחרונים + DB + שידורי-אתר + ראיות-מסך + worklog → ענף agent4/estate-vault ב-roshpina עם מניפסט-SHA256 (dual-ref, עוגן-יומי, fail-closed, אפס-סודות). משלים את control-plane: מה שהיה מקומי-בלבד עכשיו שורד מחיקת-סנדבוקס",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/estate-vault.ts"],
    timeoutMs: 300_000,
  },
  "dr-drill": {
    id: "dr-drill",
    label: "תרגיל-אסון חי — העיקרה קמה מהגיט בלבד",
    description: "קוד מתג-ה-archive של ענף-העבודה + קפסולת-המצב מענף-ה-estate — שניהם מ-origin בלבד — מקימים שני-צמתי-כסף חיים ב-/tmp (שער-שלמות sha256 + verify:full + רצפות-סף). אפס-גישה לדיסק-הייצור; ניקוי-מלא. מתוזמן יומית (Task 25) + כלי-ביקוש",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/dr-drill.ts"],
    timeoutMs: 300_000,
  },
  "agent-license": {
    id: "agent-license",
    label: "רישוי-סוכן חדש — הרשת מרחיבה-את-עצמה",
    description: "זהות Ed25519 חדשה מקומית + רישום-חתום-מפעיל מול-השוק החי (עם מפתח-ציבורי — שורד-ריסטרט) + הוכחת-חתימה-ראשונה. החבר מצטרף-למסחר בריצת-הכלכלה הבאה",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/agent-license.ts"],
    timeoutMs: 30_000,
    argSpec: [{ name: "agentId", pattern: "^[a-z][a-z0-9]{1,15}$", required: true }],
  },
  "ai-sentinel": {
    id: "ai-sentinel",
    label: "מוח-AI — סנטינל אינטליגנטי (NVIDIA NIM)",
    description: "מגייס את מצב-הרשת החי (שוק/ספר/runner/תזמונים) ושולח לנמוטרון לניתוח-מודיעיני: הערכה, סיכונים, אנומליות, המלצות. המפתח מהכספת-האטומה; fail-closed בלעדיו",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/ai-sentinel.ts"],
    timeoutMs: 120_000,
  },
  "ai-architect": {
    id: "ai-architect",
    label: "אדריכל — תוכנית-בניין אוטונומית (NVIDIA NIM)",
    description: "המוח מתכנן את סבב-הבנייה הבא: 3-5 משימות בנייה בטוחות (תוכן/ניתוח/תיעוד) שהרשת תבצע בעצמה — המוצר משתפר כל-הזמן, לא רק נבדק. JSON מאומת, fail-closed",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/ai-architect.ts"],
    timeoutMs: 150_000,
  },
  "code-executor": {
    id: "code-executor",
    label: "מבצע-קוד מוגן — הרשת כותבת קוד",
    description: "מבצע משימות action:\"code\" מהתוכנית תחת שכבות-הגנה מלאות: רשימה-לבנה-נתיבים (agent-lab/docs/broadcasts), סריקה-סטטית, שער-ייבוא-חי, שער-גרעין 47, revert-אוטומטי, יומן-ראיות",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/code-executor.ts"],
    timeoutMs: 240_000,
  },
  "site-builder": {
    id: "site-builder",
    label: "בנאי-האתר — האתר בונה את עצמו",
    description: "מחזור-בנייה אמיתי: מגייס את האמת החיה מכל-הצמתים + התוכנית + הניתוח האחרון ובונה דוח-בניין חי שהאתר מציג — האתר מתעדכן לבד, בלי-אדם, עם ראיות append-only",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/site-builder.ts"],
    timeoutMs: 60_000,
  },
  "plan-executor": {
    id: "plan-executor",
    label: "מבצע-התוכניות — מהתוכנית לפרסום",
    description: "לוקח את תוכנית-האדריכל החיה ומבצע אותה בפועל: כל משימה בטוחה (content/insight/note) הופכת לפריט-ידע אמיתי בעברית שהאתר מפרסם — הלולאה המלאה: תכנון → ביצוע → פרסום. idempotent, fail-closed",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/plan-executor.ts"],
    timeoutMs: 300_000,
  },
  "pages-evidence": {
    id: "pages-evidence",
    label: "עיתון-הרשת — ראיות-ריבונות ל-GitHub Pages",
    description: "צו-מפעיל 1a15ce0b8dbf6c71: הארכיטקטורה מפרסמת את עצמה בעצמה — אוספת ראיות חיות (מטריצת-יכולות, אוצרה, אורקל, מועצה, שער-סודות, תזמונים, פנקס-חתום, ספר-השוק החי, זיכרון-בעלים) ודוחפת press/evidence.json ל-Domain עם שער-סודות קדם-דחיפה (fail-closed) + pull --rebase נגד-מרוצי-דחיפה + אימות-אחרי-פרסום מה-URL החי; כל-הריצות חתומות ב-data/sovereign/pages-publish.jsonl",
    cwd: RUNNER_DIR,
    cmd: ["bun", "scripts/pages-evidence.ts"],
    timeoutMs: 180_000,
  },
};

// ─── Job engine ──────────────────────────────────────────────────────────────

type JobStatus = "running" | "succeeded" | "failed" | "timeout";

interface Job {
  id: string;
  preset: string;
  label: string;
  cwd: string;
  cmd: string[];
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  trigger: "manual" | "schedule";
  scheduleId?: string;
}

const OUTPUTS_DIR = `${DATA_DIR}/outputs`;
mkdirSync(OUTPUTS_DIR, { recursive: true });

const jobs = new Map<string, Job>();
let runningCount = 0;

// Full captured output persists on disk — in-memory map is a hot cache, the disk is the truth.
function persistOutput(job: Job): void {
  try {
    writeFileSync(
      `${OUTPUTS_DIR}/${job.id}.json`,
      JSON.stringify({ stdout: job.stdout, stderr: job.stderr, truncated: job.truncated })
    );
  } catch {
    // evidence persistence never breaks execution
  }
}

// Boot replay: rebuild run history from the append-only evidence journal.
function restoreHistoryFromJournal(): void {
  try {
    if (!existsSync(JOBS_JSONL)) return;
    const lines = readFileSync(JOBS_JSONL, "utf8").split("\n").filter(Boolean);
    const ends = new Map<string, Record<string, unknown>>();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.phase === "end" && typeof rec.id === "string") ends.set(rec.id, rec);
      } catch {
        // tolerate a torn last line — append-only journals may end mid-write
      }
    }
    for (const [id, rec] of ends) {
      if (jobs.has(id)) continue;
      jobs.set(id, {
        id,
        preset: String(rec.preset ?? "?"),
        label: PRESETS[String(rec.preset)]?.label ?? String(rec.preset),
        cwd: String(rec.cwd ?? ""),
        cmd: Array.isArray(rec.cmd) ? (rec.cmd as string[]) : [],
        status: rec.status as JobStatus,
        startedAt: String(rec.startedAt ?? ""),
        finishedAt: (rec.finishedAt as string) ?? undefined,
        durationMs: (rec.durationMs as number) ?? undefined,
        exitCode: (rec.exitCode as number | null) ?? null,
        stdout: "",
        stderr: "",
        truncated: Boolean(rec.truncated),
        trigger: rec.trigger === "schedule" ? "schedule" : "manual", // autonomy stays countable across restarts
        scheduleId: (rec.scheduleId as string | null) ?? undefined,
      });
    }
    if (ends.size > 0) console.log(`[fleet-runner] restored ${ends.size} historical runs from evidence journal`);
  } catch {
    // never block boot on history
  }
}

function appendEvidence(job: Job, phase: "start" | "end"): void {
  try {
    const rec = {
      ts: new Date().toISOString(),
      phase,
      id: job.id,
      preset: job.preset,
      status: job.status,
      cwd: job.cwd,
      cmd: job.cmd,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      durationMs: job.durationMs ?? null,
      exitCode: job.exitCode ?? null,
      stdoutBytes: Buffer.byteLength(job.stdout),
      stderrBytes: Buffer.byteLength(job.stderr),
      truncated: job.truncated,
      trigger: job.trigger,
      scheduleId: job.scheduleId ?? null,
    };
    appendFileSync(JOBS_JSONL, JSON.stringify(rec) + "\n");
  } catch {
    // evidence never breaks execution
  }
  if (phase === "end") persistOutput(job);
}

async function readStreamLimit(stream: unknown, job: Job, key: "stdout" | "stderr"): Promise<void> {
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= MAX_OUTPUT_BYTES) {
      job[key] += decoder.decode(value, { stream: true });
    } else if (!job.truncated) {
      job[key] += "\n… [output truncated at 512KB — full run is real, cap is for transport]";
      job.truncated = true;
    }
  }
}

function startJob(preset: Preset, trigger: "manual" | "schedule" = "manual", scheduleId?: string, args: string[] = []): Job {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const cmd = [...preset.cmd, ...args];
  const job: Job = {
    id,
    preset: preset.id,
    label: preset.label,
    cwd: preset.cwd,
    cmd,
    status: "running",
    startedAt: new Date().toISOString(),
    stdout: "",
    stderr: "",
    truncated: false,
    trigger,
    scheduleId,
  };
  jobs.set(id, job);
  runningCount++;
  appendEvidence(job, "start");

  const proc = Bun.spawn(cmd, {
    cwd: preset.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(9); } catch {}
  }, preset.timeoutMs);

  (async () => {
    try {
      await Promise.all([
        readStreamLimit(proc.stdout, job, "stdout"),
        readStreamLimit(proc.stderr, job, "stderr"),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - Date.parse(job.startedAt);
      job.status = timedOut ? "timeout" : exitCode === 0 ? "succeeded" : "failed";
      notifyScheduleFinished(job);
      appendEvidence(job, "end");
    } catch (err) {
      clearTimeout(timer);
      job.status = "failed";
      job.stderr += `\n[runner spawn error] ${String(err)}`;
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - Date.parse(job.startedAt);
      notifyScheduleFinished(job);
      appendEvidence(job, "end");
    } finally {
      runningCount--;
    }
  })();

  return job;
}

// ─── Scheduler: real recurring work — persisted, fail-closed, honest ─────────

type Schedule = {
  id: string;
  presetId: string;
  intervalSec: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastStatus: JobStatus | "skipped" | null;
  nextRunAt: string;
  runCount: number;
  failCount: number;
  skippedCount: number;
};

const SCHEDULES_JSON = `${DATA_DIR}/schedules.json`;
const MIN_INTERVAL_SEC = 60; // חוק-מינימום: הגנה על המכונה מפני ריצות תדירות מדי
// תקרה הוגבהה 20→24 (צו-מפעיל 1a15ce0b8dbf6c71: "שלא יהיו חסימות מיותרות על הפעילות
// הריבונית האוטונומית") — התקרה שמרנית אך הפרסום-העצמי ל-Pages הוא עבודה-ריבונית אמיתית
// שהרשת חייבת לרוץ בה-לבד; שאר-ההגנות (רשימת-preset סגורה, אידמפוטנציה) נשמרות.
const MAX_SCHEDULES = 24;
const BUSY_RETRY_SEC = 15; // כשה-runner עמוס — דילוג כן, ניסיון-חוזר קרוב
const BOOT_CATCHUP_SEC = 150; // השלמה-אחרי-אתחול — נמדד בלידה-מחדש 2026-10-21T01:22: חתימת-הכספת (vault-unseal) מסתיימת ~90שנ' אחרי-עליית-ה-runner, ויריות-ב-45שנ' פגעו בכישלון-כן ב-3 לוחות-AI/ביקורת (ai-architect 01:23:15 קדם-לחתימה 01:23:5x). 150שנ' = הבטחה-חוזרת אחרי-שהרשת-חיה, עדיין רחוק ממחזור-שלם.

const schedules = new Map<string, Schedule>();

function saveSchedules(): void {
  try {
    writeFileSync(SCHEDULES_JSON, JSON.stringify([...schedules.values()], null, 2));
  } catch {
    // persistence never breaks execution
  }
}

function restoreSchedules(): void {
  try {
    if (!existsSync(SCHEDULES_JSON)) return;
    const parsed = JSON.parse(readFileSync(SCHEDULES_JSON, "utf8")) as Schedule[];
    let restored = 0;
    for (const s of parsed) {
      if (!s || typeof s.id !== "string" || !PRESETS[s.presetId]) continue; // fail-closed: preset לא-מוכר → נשרף
      if (!Number.isInteger(s.intervalSec) || s.intervalSec < MIN_INTERVAL_SEC) continue;
      // חוק-שמירת-ההבטחה (תיקון-באג 2026-10-20 06:2x): הבטחת-nextRunAt עתידית
      // שנשמרה בדיסק היא קודש — hot-reload/reboot לא מוחקים אותה. באג-המקורי:
      // כל-טעינת-מודול עגנה מחדש now+interval ודחפה תזמון-טרי (עוד-לא-ירה)
      // מחזור-שלם-קדימה בשקט (self-audit: 05:49 → 06:27 בלי-ריצה — נתפס-באימות-עצמאי).
      const intervalMs = s.intervalSec * 1000;
      const lastMs = typeof s.lastRunAt === "string" ? Date.parse(s.lastRunAt) : NaN;
      const createdMs = typeof s.createdAt === "string" ? Date.parse(s.createdAt) : NaN;
      const storedNextMs = typeof s.nextRunAt === "string" ? Date.parse(s.nextRunAt) : NaN;
      if (Number.isFinite(storedNextMs) && storedNextMs > Date.now()) {
        // הבטחה עתידית — נשמרת כמו-שהיא
        s.nextRunAt = new Date(storedNextMs).toISOString();
      } else {
        // פיגור (הבטחה-שעברה) → השלמה מהירה; אין-הבטחה-כלל → מחזור-מלא מעכשיו
        const overdue =
          Number.isFinite(storedNextMs) ||
          (Number.isFinite(lastMs) && Date.now() - lastMs >= intervalMs) ||
          (!s.lastRunAt && Number.isFinite(createdMs) && Date.now() - createdMs >= intervalMs);
        s.nextRunAt = new Date(Date.now() + (overdue ? BOOT_CATCHUP_SEC : intervalMs)).toISOString();
      }
      schedules.set(s.id, s);
      restored++;
    }
    if (restored > 0) console.log(`[fleet-runner] restored ${restored} schedules from disk`);
  } catch {
    // never block boot on schedule state
  }
}

function notifyScheduleFinished(job: Job): void {
  if (!job.scheduleId) return;
  const s = schedules.get(job.scheduleId);
  if (!s) return;
  s.lastStatus = job.status;
  if (job.status !== "succeeded") s.failCount++;
  saveSchedules();
}

// 调度核心——从 setInterval 提取，并由每个传入的 HTTP 请求（lazy tick）调用：
// bun --hot 会丢弃热重载评估中创建的 setInterval 回调，
// 因此仅依靠定时器在开发模式下会导致静默失效。控制平面每 ~5 秒轮询一次 —
// 每次请求都会先运行一次调度检查。该定时器在生产环境中保留，用作无请求时的备份。
function runSchedulerTick(): void {
  schedGlobal.__fleetTickCount = (schedGlobal.__fleetTickCount ?? 0) + 1;
  try {
    const now = Date.now();
    for (const s of schedules.values()) {
      if (!s.enabled || Date.parse(s.nextRunAt) > now) continue;
      if (runningCount >= MAX_CONCURRENT) {
        s.skippedCount++;
        s.lastStatus = "skipped";
        s.nextRunAt = new Date(now + BUSY_RETRY_SEC * 1000).toISOString();
        saveSchedules();
        continue;
      }
      const preset = PRESETS[s.presetId];
      if (!preset) {
        s.enabled = false; // כישלון-כן: העבודה נעלמה מה-whitelist
        s.lastStatus = "failed";
        saveSchedules();
        continue;
      }
      const job = startJob(preset, "schedule", s.id);
      s.runCount++;
      s.lastRunAt = job.startedAt;
      s.lastJobId = job.id;
      s.lastStatus = job.status;
      s.nextRunAt = new Date(now + s.intervalSec * 1000).toISOString();
      saveSchedules();
    }
    schedGlobal.__fleetTickError = null;
  } catch (err) {
    schedGlobal.__fleetTickError = String(err).slice(0, 200); // שקיפות-מלאה — השגיאה נראית ב-/health
  }
}

// timer 备份（生产模式 — 无 --hot）：防重入保护，防止 lazy tick 与 timer 同时运行
let tickInFlight = false;

// ─── Self-healing watchdog: הרשת חייבת לרוץ אוטונומית ────────────────────────
// המחיקה האחרונה של הסנדבוקס השביתה את :3032/:3033 והסנדבוקס שתק לבד.
// מעכשיו: בדיקת-חיות מדי-45שנ' (lazy בבקשות + טיימר-גיבוי), ואם צומת-כסף כבוי —
// start-nodes.sh v2 מופעל detached (clone/branch/keys/state/בוט — הכל מחלים לבד).
const wdGlobal = globalThis as {
  __fleetWd?: { lastCheckAt: number; lastHealAt: number; healCount: number; lastResult: string; inFlight: boolean };
};
const wd = (wdGlobal.__fleetWd ??= { lastCheckAt: 0, lastHealAt: 0, healCount: 0, lastResult: "never", inFlight: false });

async function probeMoneyNode(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

// ─── External heartbeat insurance ──────────────────────────────────────────
// night-heartbeat.sh פועם ל-runner כל-30שנ' — מבטיח lazy-tick גם-באפס-מבקרים
// וגם-אם הטיימר-הפנימי מת בהחלפה-חמה. ה-runner (תהליך-קיים) מבטיח שהוא חי:
// pidfile guard + spawn detached (אותו-דפוס מוכח של הריפוי). תהליכים שה-runner
// מריץ detached שורדים — בניגוד לתהליכי-רקע של טרמינל.
const hbGlobal = globalThis as { __fleetHbLastEnsure?: number };
function ensureHeartbeat(): void {
  const now = Date.now();
  if (hbGlobal.__fleetHbLastEnsure && now - hbGlobal.__fleetHbLastEnsure < 60_000) return;
  hbGlobal.__fleetHbLastEnsure = now;
  try {
    Bun.spawn(
      ["bash", "-c", 'pf=/tmp/fleet-heartbeat.pid; if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then exit 0; fi; rm -f "$pf"; nohup setsid bash night-heartbeat.sh >> logs/heartbeat.log 2>&1 < /dev/null &'],
      { cwd: RUNNER_DIR, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    /* best-effort insurance */
  }
}

async function maybeWatchdog(): Promise<void> {
  if (wd.inFlight) return;
  const now = Date.now();
  if (now - wd.lastCheckAt < 45_000) return; // throttle — הבקרה דוגמת פעימה כל-~5שנ'
  wd.inFlight = true;
  try {
    wd.lastCheckAt = now;
    ensureHeartbeat(); // פעימות-לב חיצוניות — הביטוח של המתזמן בלילה
    const [ledgerUp, marketUp] = await Promise.all([
      probeMoneyNode("http://127.0.0.1:3032/health"),
      probeMoneyNode("http://127.0.0.1:3033/health"),
    ]);
    if (ledgerUp && marketUp) {
      wd.lastResult = `ok@${new Date().toISOString()}`;
      return;
    }
    if (now - wd.lastHealAt < 120_000) {
      wd.lastResult = `down-cooldown@${new Date().toISOString()}`;
      return;
    }
    wd.lastHealAt = now;
    wd.healCount++;
    wd.lastResult = `healing@${new Date().toISOString()}`;
    console.log(`[fleet-runner] watchdog: money nodes down (ledger=${ledgerUp} market=${marketUp}) → start-nodes.sh v2 (self-heal #${wd.healCount})`);
    Bun.spawn(
      ["bash", "-c", "nohup bash start-nodes.sh >> logs/watchdog-heal.log 2>&1 < /dev/null &"],
      { cwd: RUNNER_DIR, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
  } catch (err) {
    wd.lastResult = `error:${String(err).slice(0, 80)}`;
  } finally {
    wd.inFlight = false;
  }
}

const wdGlobalTimer = globalThis as { __fleetWdTimer?: ReturnType<typeof setInterval> };
if (wdGlobalTimer.__fleetWdTimer) clearInterval(wdGlobalTimer.__fleetWdTimer);
wdGlobalTimer.__fleetWdTimer = setInterval(() => { void maybeWatchdog(); }, 30_000);
const schedGlobal = globalThis as {
  __fleetSchedTimer?: ReturnType<typeof setInterval>;
  __fleetTickCount?: number;
  __fleetTickError?: string | null;
};
if (schedGlobal.__fleetSchedTimer) clearInterval(schedGlobal.__fleetSchedTimer);
schedGlobal.__fleetSchedTimer = setInterval(() => {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    runSchedulerTick();
  } finally {
    tickInFlight = false;
  }
}, 1000);

// ─── Network probe (real fetches, real latency) ──────────────────────────────

async function probeNode(node: (typeof NODES)[number]) {
  const t0 = Date.now();
  try {
    const res = await fetch(node.url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    const ms = Date.now() - t0;
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-json ok */ }
    return { ...node, up: res.ok, httpStatus: res.status, latencyMs: ms, body };
  } catch (err) {
    return { ...node, up: false, httpStatus: 0, latencyMs: Date.now() - t0, body: null, error: String(err).slice(0, 140) };
  }
}

// ─── HTTP service ────────────────────────────────────────────────────────────

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // lazy tick: כל-בקשה מריצה קודם בדיקת-תזמונים — חסין-החלפה-חמה, זול (≤20 בדיקות-תאריך)
    runSchedulerTick();
    // lazy watchdog: אותו-רעיון — חוסן-עצמי חסין-החלפה-חמה, fire-and-forget
    void maybeWatchdog();

    if (req.method === "GET" && path === "/health") {
      return json(200, {
        ok: true,
        service: "fleet-runner",
        port: PORT,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        jobsRunning: runningCount,
        jobsTotal: jobs.size,
        schedulesCount: schedules.size,
        tickCount: schedGlobal.__fleetTickCount ?? 0,
        tickError: schedGlobal.__fleetTickError ?? null,
        watchdog: {
          lastCheckAt: wd.lastCheckAt ? new Date(wd.lastCheckAt).toISOString() : null,
          lastHealAt: wd.lastHealAt ? new Date(wd.lastHealAt).toISOString() : null,
          healCount: wd.healCount,
          lastResult: wd.lastResult,
        },
        presets: Object.keys(PRESETS),
        ownerGate: OWNER_TOKEN ? "armed" : "fail-closed",
      });
    }

    if (req.method === "GET" && path === "/nodes") {
      const probed = await Promise.all(NODES.map(probeNode));
      return json(200, { probedAt: new Date().toISOString(), nodes: probed });
    }

    if (req.method === "GET" && path === "/presets") {
      return json(200, { presets: Object.values(PRESETS).map(({ id, label, description, timeoutMs }) => ({ id, label, description, timeoutMs })) });
    }

    if (req.method === "GET" && path === "/jobs") {
      const list = [...jobs.values()].slice(-50).reverse();
      return json(200, { jobs: list.map(({ stdout, stderr, ...rest }) => ({ ...rest, stdoutBytes: stdout.length, stderrBytes: stderr.length })) });
    }

    // full job output may carry secrets from logs — owner-only (public list stays summary-only)
    if (req.method === "GET" && path.startsWith("/jobs/")) {
      if (!ownerOk(req)) return denyOwner(req, path);
      const id = decodeURIComponent(path.slice("/jobs/".length));
      let job = jobs.get(id);
      if (!job) return json(404, { error: "job_not_found", id });
      // historical run: hydrate full output from disk (the disk is the truth)
      let restored = false;
      if (job.finishedAt && job.stdout === "" && job.stderr === "") {
        try {
          const saved = JSON.parse(readFileSync(`${OUTPUTS_DIR}/${id}.json`, "utf8")) as { stdout: string; stderr: string; truncated: boolean };
          job.stdout = saved.stdout;
          job.stderr = saved.stderr;
          job.truncated = saved.truncated;
        } catch {
          restored = true; // completed before disk-persistence existed — summary only, honestly flagged
        }
      }
      return json(200, { ...job, restored });
    }

    if (req.method === "POST" && path === "/jobs") {
      if (!ownerOk(req)) return denyOwner(req, path);
      let presetId = "";
      let rawArgs: Record<string, unknown> | undefined;
      try {
        const body = (await req.json()) as { preset?: string; args?: Record<string, unknown> };
        presetId = String(body.preset ?? "");
        if (body.args !== undefined) {
          if (typeof body.args !== "object" || body.args === null || Array.isArray(body.args)) {
            return json(400, { error: "args must be an object of name→string" });
          }
          rawArgs = body.args;
        }
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const preset = PRESETS[presetId];
      if (!preset) {
        return json(400, { error: "unknown_preset", allowed: Object.keys(PRESETS) }); // fail-closed: no arbitrary commands
      }
      // whitelisted args only: the preset declares what it accepts, every value matches its pattern
      let argv: string[] = [];
      if (preset.argSpec) {
        for (const spec of preset.argSpec) {
          const v = rawArgs?.[spec.name];
          if (v === undefined || v === null || String(v) === "") {
            if (spec.required) return json(400, { error: "missing_arg", arg: spec.name, pattern: spec.pattern });
            continue;
          }
          const s = String(v);
          if (s.length > 64 || !new RegExp(spec.pattern).test(s)) {
            return json(400, { error: "invalid_arg", arg: spec.name, pattern: spec.pattern });
          }
          argv.push(s);
        }
        const extra = Object.keys(rawArgs ?? {}).filter((k) => !preset.argSpec!.some((s) => s.name === k));
        if (extra.length > 0) return json(400, { error: "unknown_args", rejected: extra });
      } else if (rawArgs && Object.keys(rawArgs).length > 0) {
        return json(400, { error: "preset_accepts_no_args", preset: preset.id });
      }
      if (runningCount >= MAX_CONCURRENT) {
        return json(429, { error: "runner_busy", running: runningCount, max: MAX_CONCURRENT });
      }
      const job = startJob(preset, "manual", undefined, argv);
      return json(202, job);
    }

    if (req.method === "GET" && path === "/schedules") {
      const list = [...schedules.values()].sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
      return json(200, { schedules: list });
    }

    // בדיקה-נקודתית: תזמון בודד לפי מזהה (ללא חשיפת הרשימה כולה)
    if (req.method === "GET" && path.startsWith("/schedules/")) {
      const id = decodeURIComponent(path.slice("/schedules/".length));
      const sched = schedules.get(id);
      if (!sched) return json(404, { error: "schedule_not_found", id });
      return json(200, { schedule: sched });
    }

    if (req.method === "POST" && path === "/schedules") {
      if (!ownerOk(req)) return denyOwner(req, path);
      let presetId = "";
      let intervalSec = 0;
      try {
        const body = (await req.json()) as { preset?: string; intervalSec?: number };
        presetId = String(body.preset ?? "");
        intervalSec = Number(body.intervalSec ?? 0);
      } catch {
        return json(400, { error: "invalid_json" });
      }
      if (!PRESETS[presetId]) {
        return json(400, { error: "unknown_preset", allowed: Object.keys(PRESETS) }); // fail-closed: אין עבודות שרירותיות
      }
      // מנגנון-מנע מפני תזמון-כפול: preset אחד = תזמון-פעיל אחד.
      // לחיצה-כפולה על "המפתח-האחד" לא תיצור ריצה-כפולה — idempotent create-or-get.
      const existing = [...schedules.values()].find((s) => s.presetId === presetId && s.enabled);
      if (existing) {
        console.log(`[fleet-runner] schedule duplicate rejected (idempotent): preset=${presetId} existing=${existing.id}`);
        return json(200, { schedule: existing, duplicate: true, note: "preset_already_scheduled_use_PATCH_to_change_interval" });
      }
      if (PRESETS[presetId].argSpec?.some((s) => s.required)) {
        return json(400, { error: "preset_requires_args_not_schedulable", preset: presetId }); // schedules run without args — by design
      }
      if (!Number.isInteger(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
        return json(400, { error: "invalid_interval", min: MIN_INTERVAL_SEC });
      }
      if (schedules.size >= MAX_SCHEDULES) {
        return json(400, { error: "too_many_schedules", max: MAX_SCHEDULES });
      }
      const sched: Schedule = {
        id: `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        presetId,
        intervalSec,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        lastJobId: null,
        lastStatus: null,
        nextRunAt: new Date(Date.now() + intervalSec * 1000).toISOString(),
        runCount: 0,
        failCount: 0,
        skippedCount: 0,
      };
      schedules.set(sched.id, sched);
      saveSchedules();
      console.log(`[fleet-runner] schedule created: ${sched.id} preset=${presetId} every=${intervalSec}s`);
      return json(201, sched);
    }

    if ((req.method === "PATCH" || req.method === "DELETE") && path.startsWith("/schedules/")) {
      if (!ownerOk(req)) return denyOwner(req, path);
      const id = decodeURIComponent(path.slice("/schedules/".length));
      const sched = schedules.get(id);
      if (!sched) return json(404, { error: "schedule_not_found", id });
      if (req.method === "DELETE") {
        schedules.delete(id);
        saveSchedules();
        console.log(`[fleet-runner] schedule deleted: ${id}`);
        return json(200, { ok: true, deleted: id });
      }
      let enabled: unknown;
      let intervalSec: unknown;
      try {
        const body = (await req.json()) as { enabled?: boolean; intervalSec?: number };
        enabled = body.enabled;
        intervalSec = body.intervalSec;
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const hasEnabled = typeof enabled === "boolean";
      const hasInterval = intervalSec !== undefined && intervalSec !== null;
      if (!hasEnabled && !hasInterval) {
        return json(400, { error: "invalid_body", need: "enabled?:boolean, intervalSec?:integer>=MIN" });
      }
      if (hasInterval) {
        const n = Number(intervalSec);
        if (!Number.isInteger(n) || n < MIN_INTERVAL_SEC) {
          return json(400, { error: "invalid_interval", min: MIN_INTERVAL_SEC }); // אותו-חוק כמו POST
        }
        // עוגן-קצב: ההמשך נגזר מהריצה-האחרונה (לא מהרגע הנוכחי) — שינוי-מרווח לא מזיז את המועד הקרוב אם הוא כבר מתוכנן מוקדם-יותר
        sched.intervalSec = n;
        const anchorMs = typeof sched.lastRunAt === "string" ? Date.parse(sched.lastRunAt) : NaN;
        const anchoredNext = Number.isFinite(anchorMs) ? anchorMs + n * 1000 : Date.now() + n * 1000;
        sched.nextRunAt = new Date(Math.max(Date.now(), anchoredNext)).toISOString();
        console.log(`[fleet-runner] schedule interval changed: ${id} → ${n}s next=${sched.nextRunAt}`);
      }
      if (hasEnabled) {
        sched.enabled = enabled as boolean;
        console.log(`[fleet-runner] schedule enabled=${String(enabled)}: ${id}`);
      }
      saveSchedules();
      return json(200, sched);
    }

    return json(404, { error: "not_found", path });
  },
});

// יחידת-התזמון מוגדרת לפני-השרת; הטיימר-כאן רק גיבוי. הפעלת-היסטוריה והתזמונים:
restoreHistoryFromJournal();
restoreSchedules();
console.log(`[fleet-runner] listening on :${server.port} — presets=[${Object.keys(PRESETS).join(",")}] schedules=[${schedules.size}]`);
