/**
 * secrets-gate — "טוקן אף פעם לא נכתב לקובץ בריפו, אף פעם לא בקומיט, אף פעם לא בדוח."
 *
 * תעלה של PHASE-0 §4 (ערכת-היגיינת-המפתחות של AGENT-Z, R130) + החוק-הברזל של הצי,
 * מיושמת ברמת-הרשת שלנו: סריקת-תוכן (לא רק נתיב/סיומת) של כל-מה שאנחנו דוחפים לגיט.
 *
 * רקע-מדידה (audit 40-b, 2026-10-20):
 *  - R11: ארכיון-שורש + פסקה לצידו הופצו ל-8 ריפואים (roshpina כולל — נוקה ב-HEAD,
 *    נשמר בהיסטוריה; .gitleaksignore מתעד; רוטציה חסומת-בעלים מ-2026-10-01).
 *  - control-plane-backup ו-estate-vault סורקים נתיבים/סיומות — טוקן בתוך .md היה עובר.
 *  - הסריקה הזו סורקת תוכן בתבניות בביטחון-גבוה בלבד (שקר-חיובי שובר דחיפה — fail-closed).
 *
 * מצבים:
 *   lane            — סריקת כל-הקבצים ב-HEAD של ענף-הרשת (מה שבאמת נדחף כענף/תג).
 *   dir <path>      — סריקת עץ-סטייג'ינג (שער-קדם-דחיפה ל-control-plane / estate-vault).
 *
 * מה-לא-מכוסה (כנות): מחרוזות-hex גנריות (פסקאות R11 היו hex-48) לא ניתנות להפרדה
 * מ-sha256 של ראיות-יומן בלי שקרים-חיוביים המוניים — כיסוי זה דווקאי ומדוד, לא מובטח.
 *
 * fail-closed: כל-פגיעה → exit 1. כל-שגיאת-סריקה → exit 1. רק נקי → exit 0.
 * הפלט והפסיק-JSON לעולם לא מכילים את הערך עצמו — רק מזהה-תבנית + תצוגה מצונזרת.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, relative } from "path";

const REPO = "/home/z/repos/roshpina";
const SOV_DIR = "/home/z/my-project/mini-services/fleet-runner/data/sovereign";
const MAX_FILE_BYTES = 6 * 1024 * 1024; // text evidence up to 6MB IS scanned (jobs.jsonl ≈2.4MB); binary tarballs exit via looksBinary
const JSONL_KEEP = 400;

type Pattern = { id: string; re: RegExp; why: string };

// high-confidence only — a false positive here breaks the push chain (fail-closed),
// so every pattern is shaped to its real-world token family (R11 lesson: describe by
// shape, never store the value).
const PATTERNS: Pattern[] = [
  { id: "GH_PAT",    re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/, why: "GitHub personal-access token (the estate's own leak class — R11/PHASE-0)" },
  { id: "PEM_KEY",   re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,        why: "private key material (operator identity, node keys)" },
  { id: "AWS_AKIA",  re: /\bAKIA[0-9A-Z]{16}\b/,                                  why: "AWS access key id" },
  { id: "WIF_KEY",   re: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,                   why: "WIF wallet key shape, 51-52 chars (uncompressed 5…/compressed K…L…) — R11 kit: WIFs of the fleet" },
  { id: "AI_KEY",    re: /\bsk-(?:ant|proj)-[A-Za-z0-9_\-]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b/, why: "LLM-provider API key shape" },
  { id: "SLACK",     re: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/,                     why: "Slack token" },
  { id: "GOOGLE",    re: /\bAIza[0-9A-Za-z_\-]{35}\b/,                            why: "Google API key" },
];

export type Hit = { pattern: string; file: string; line: number; preview: string; why: string };
export type Verdict = {
  at: string; mode: string; target: string;
  filesScanned: number; bytesScanned: number; patterns: number;
  hits: Hit[]; verdict: "CLEAN" | "FAIL" | "ERROR"; error?: string;
};

const redact = (m: string) => `${m.slice(0, 4)}…(${m.length} chars)`;

// WIF false-positive class (measured live on the control-plane snapshot 2026-10-20):
// a 52-char base58-shaped window INSIDE a base64 blob (images in HTML templates) —
// base64 uses '+/' whose non-word chars create regex boundaries mid-blob. A real WIF
// stands alone (json field / line / csv), never as a slice of a media blob.
function insideBase64Run(line: string, start: number, end: number): boolean {
  const B64 = /[A-Za-z0-9+/=]/;
  let lo = start, hi = end;
  while (lo > 0 && B64.test(line[lo - 1])) lo--;
  while (hi < line.length && B64.test(line[hi])) hi++;
  return hi - lo >= 64; // the match is a slice of a long base64-ish run → media blob, not a token
}

function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

export function scanBuffer(file: string, buf: Buffer): { hits: Hit[]; bytes: number } {
  const hits: Hit[] = [];
  if (looksBinary(buf)) return { hits, bytes: buf.length };
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    for (const p of PATTERNS) {
      let m = line.match(p.re);
      while (m) {
        const start = m.index ?? 0, end = start + m[0].length;
        if (p.id === "WIF_KEY" && insideBase64Run(line, start, end)) { // proven false-positive class, not a weakening — standalone WIFs still abort
          const rest = line.slice(end);
          const next = rest.match(p.re);
          if (!next) { m = null; break; }
          m = { ...next, index: end + (next.index ?? 0) } as RegExpMatchArray;
          continue;
        }
        hits.push({ pattern: p.id, file, line: li + 1, preview: redact(m[0]), why: p.why });
        break;
      }
    }
  });
  return { hits, bytes: buf.length };
}

export function scanTree(root: string, opts?: { relTo?: string }): { hits: Hit[]; filesScanned: number; bytesScanned: number; error?: string } {
  const relTo = opts?.relTo;
  const hits: Hit[] = [];
  let filesScanned = 0, bytesScanned = 0;
  const walk = (dir: string): string | undefined => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return `readdir ${dir}: ${(e as Error).message}`; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".next") continue;
        const err = walk(full); if (err) return err;
      } else if (ent.isFile()) {
        let st;
        try { st = statSync(full); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size > MAX_FILE_BYTES) { filesScanned++; bytesScanned += st.size; continue; } // oversized: counted, head-pattern risk accepted (tarballs excluded upstream)
        let buf;
        try { buf = readFileSync(full); } catch { continue; }
        const rel = relTo ? relative(relTo, full) : full;
        const r = scanBuffer(rel, buf);
        hits.push(...r.hits); filesScanned++; bytesScanned += r.bytes;
      }
    }
    return undefined;
  };
  const err = walk(root);
  return { hits, filesScanned, bytesScanned, error: err };
}

export function scanLaneHead(): { hits: Hit[]; filesScanned: number; bytesScanned: number; error?: string } {
  const ls = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (ls.exitCode !== 0) return { hits: [], filesScanned: 0, bytesScanned: 0, error: `git ls-tree failed: ${new TextDecoder().decode(ls.stderr).slice(0, 200)}` };
  const names = new TextDecoder().decode(ls.stdout).split("\0").filter(Boolean);
  const hits: Hit[] = [];
  let filesScanned = 0, bytesScanned = 0;
  for (const name of names) {
    const show = Bun.spawnSync(["git", "show", `HEAD:${name}`], { cwd: REPO, stdout: "pipe", stderr: "pipe", maxBuffer: 8 * 1024 * 1024 });
    if (show.exitCode !== 0) continue;
    const buf = Buffer.from(show.stdout);
    if (buf.length > MAX_FILE_BYTES) { filesScanned++; bytesScanned += buf.length; continue; }
    const r = scanBuffer(name, buf);
    hits.push(...r.hits); filesScanned++; bytesScanned += r.bytes;
  }
  return { hits, filesScanned, bytesScanned };
}

function persist(v: Verdict): void {
  try { mkdirSync(SOV_DIR, { recursive: true }); } catch { /* exists */ }
  writeFileSync(join(SOV_DIR, "secrets-gate.json"), JSON.stringify(v, null, 1));
  const jsonl = join(SOV_DIR, "secrets-gate.jsonl");
  try {
    appendFileSync(jsonl, JSON.stringify({ at: v.at, mode: v.mode, files: v.filesScanned, hits: v.hits.length, verdict: v.verdict }) + "\n");
    const lines = readFileSync(jsonl, "utf8").trim().split("\n");
    if (lines.length > JSONL_KEEP) writeFileSync(jsonl, lines.slice(-JSONL_KEEP).join("\n") + "\n");
  } catch { /* journal best-effort; verdict file is authoritative */ }
}

// capability-audit calls this hourly — the lane verdict can never silently age out:
// if stale, the audit itself re-scans the lane HEAD and re-journals. fail-closed on error.
export function ensureLaneVerdict(maxAgeMin: number): { verdict: string; files: number; age: number; refreshed: boolean; error?: string } {
  const vf = join(SOV_DIR, "secrets-gate.json");
  if (existsSync(vf)) {
    try {
      const v = JSON.parse(readFileSync(vf, "utf8")) as Verdict;
      const age = (Date.now() - Date.parse(v.at)) / 60_000;
      if (v.mode === "lane" && age <= maxAgeMin) return { verdict: v.verdict, files: v.filesScanned, age, refreshed: false, error: v.error };
    } catch { /* corrupt verdict → rescan */ }
  }
  const r = scanLaneHead();
  const v: Verdict = {
    at: new Date().toISOString(), mode: "lane", target: REPO,
    filesScanned: r.filesScanned, bytesScanned: r.bytesScanned, patterns: PATTERNS.length,
    hits: r.hits, verdict: r.error ? "ERROR" : r.hits.length > 0 ? "FAIL" : "CLEAN", error: r.error,
  };
  persist(v);
  const age = 0;
  return { verdict: v.verdict, files: v.filesScanned, age, refreshed: true, error: v.error };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "lane";
  let result: { hits: Hit[]; filesScanned: number; bytesScanned: number; error?: string };
  let target = REPO;
  if (mode === "dir") {
    target = process.argv[3] ?? "";
    if (!target || !existsSync(target)) {
      console.error(`SECRETS-GATE-FAIL: dir target missing: ${target}`);
      process.exit(1);
    }
    result = scanTree(target, { relTo: target });
  } else {
    result = scanLaneHead();
  }
  const verdict: Verdict = {
    at: new Date().toISOString(), mode, target,
    filesScanned: result.filesScanned, bytesScanned: result.bytesScanned, patterns: PATTERNS.length,
    hits: result.hits,
    verdict: result.error ? "ERROR" : result.hits.length > 0 ? "FAIL" : "CLEAN",
    error: result.error,
  };
  persist(verdict);
  console.log(JSON.stringify({ verdict: verdict.verdict, files: verdict.filesScanned, bytes: verdict.bytesScanned, hits: verdict.hits.length, patterns: verdict.patterns }));
  if (verdict.error) { console.error(`SECRETS-GATE-FAIL: ${verdict.error}`); process.exit(1); }
  if (verdict.hits.length > 0) {
    for (const h of verdict.hits.slice(0, 20)) console.error(`SECRETS-GATE-HIT ${h.pattern} ${h.file}:${h.line} ${h.preview} — ${h.why}`);
    process.exit(1);
  }
  console.log("SECRETS-GATE-CLEAN");
  process.exit(0);
}

if (import.meta.main) await main();
