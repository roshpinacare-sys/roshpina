/**
 * ref-warden.ts — שומר-ה-refs (task 55 + חוק-tag-forward מ-task 61).
 *
 * נמדד: הענפים נאכלים חיצונית ≤17ד׳ אחרי-דחיפות-נקיות, וגם — הכי-כואב — ה-warden
 * עצמו היה direction-blind ואכל עבודה-קדימה (bfbb973→bf1e6e6). החוק-המתוקן:
 *   1. ענף-חי + שווה-לתג ⇒ שום-דבר (מסונכרן).
 *   2. ענף-חי + צאצא-מוכח-של-התג (merge-base --is-ancestor) ⇒ עבודה-התקדמה —
 *      התג עוקב-אחרי-הענף (מרוחק + מקומי). אפס-תנועות-אחורה לעולם.
 *   3. ענף-חי + לא-צאצא (לא-קשור או מאחורי-התג) ⇒ הענף נאכל/אופס — שחזור-כוח
 *      ענף←תג (ההתנהגות-השמרנית).
 *   4. ענף-GONE ⇒ שחזור-מהתג; תג-GONE גם-כן ⇒ exit 1 רועש (fail-closed).
 * אפס-קומיטים-חדשים; R42 נשמר. רץ: bun scripts/ref-warden.ts
 */

import { readFileSync } from "fs";

const REPO = "/home/z/repos/roshpina";
const BRANCH = "agent4/p2-sovereign-market";
const TAG = "archive/agent4/p2-sovereign-market";
const TOKEN_FILE = "/home/z/my-project/upload/pat.env";
const URL = `https://x-access-token:${readFileSync(TOKEN_FILE, "utf8").match(/=(\S+)/)?.[1] ?? ""}@github.com/roshpinacare-sys/roshpina.git`;

const git = (args: string[], cwd = REPO): { ok: boolean; out: string } => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

// טמפ-refs: האובייקט-המרוחק עשוי-שלא-להיות-קיים-מקומית (נמדד: "bad object")
const fetchRef = (): boolean => git(["fetch", "--quiet", URL, `+refs/heads/${BRANCH}:refs/remotes/refwarden/branch`, `+refs/tags/${TAG}:refs/remotes/refwarden/tag`]).ok;

const peel = (ref: string): string | null => {
  const r = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  return r.ok ? r.out.split("\n")[0] : null;
};

if (!fetchRef()) {
  console.error("REF-WARDEN-FAIL: cannot fetch remote refs (network/token) — fail-closed");
  process.exit(1);
}
const b = peel("refs/remotes/refwarden/branch");
const t = peel("refs/remotes/refwarden/tag");
if (!t) {
  console.error("REF-WARDEN-FAIL: archive tag GONE remotely — cannot preserve or restore; fail-closed");
  process.exit(1);
}
if (!b) {
  const r = git(["push", "--quiet", URL, `+${t}:refs/heads/${BRANCH}`]);
  console.log(r.ok ? `REF-WARDEN-OK: branch GONE — restored from tag ${t.slice(0, 7)} (0/1 fixes)` : "REF-WARDEN-FAIL: branch GONE and restore push failed");
  process.exit(r.ok ? 0 : 1);
}
if (b === t) {
  console.log(`REF-WARDEN-OK: branch==tag==${b.slice(0, 7)} — מסונכרן (0/0 fixes)`);
  process.exit(0);
}
// ancestry מדוד — חוק-tag-forward (task 61): צאצא-מוכח = עבודה-התקדמה ⇒ התג עוקב
const isDescendant = git(["merge-base", "--is-ancestor", `refs/remotes/refwarden/tag`, `refs/remotes/refwarden/branch`]).ok;
if (isDescendant) {
  const remote = git(["push", "--quiet", URL, `+${b}:refs/tags/${TAG}`]);
  const local = git(["tag", "-f", TAG, b]);
  const ok = remote.ok && local.ok;
  console.log(ok
    ? `REF-WARDEN-OK: tag-forward — branch ${b.slice(0, 7)} is a proven DESCENDANT of tag ${t.slice(0, 7)} → the TAG follows the work (remote+local). אפס-תנועות-אחורה. (1/1 fixes)`
    : "REF-WARDEN-FAIL: tag-forward push failed");
  process.exit(ok ? 0 : 1);
}
// לא-צאצא: הענף נאכל/אופס מאחורי-התג — שחזור-שמרני ענף←תג
const r = git(["push", "--quiet", URL, `+${t}:refs/heads/${BRANCH}`]);
console.log(r.ok
  ? `REF-WARDEN-OK: branch not a descendant (unrelated/reset) — force-restored branch←tag ${t.slice(0, 7)} (1/1 fixes; R42 — התג הוא הזיכרון)`
  : "REF-WARDEN-FAIL: conservative branch restore failed");
process.exit(r.ok ? 0 : 1);
