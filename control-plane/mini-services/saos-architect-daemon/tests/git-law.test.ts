/**
 * git-law.test.ts — TDD RED (written before implementation, §6 zero-slop gate)
 * חוקת-הגיט בתוך-הדימון עצמו: כל-commit שהארכיטקט-נוחת חייב-חתימת-GPG
 * גם-אם-ה-runner שכח-את-החוק-בקונפיג-הגלובלי. אפס-אמון בסביבה.
 */
import { describe, test, expect } from "bun:test";

import { commitArgs, rebaseArgs } from "../git-law.ts";

describe("git-law — the constitution enforced inside the daemon", () => {
  test("commit argv forces GPG signing regardless of ambient config", () => {
    const args = commitArgs("fix(architect): x cured");
    expect(args).toEqual(["-c", "commit.gpgsign=true", "commit", "-m", "fix(architect): x cured"]);
  });

  test("commit argv keeps message byte-exact (no shell, no quoting drift)", () => {
    const msg = 'fix(architect): quote-test " --amend --no-verify';
    const args = commitArgs(msg);
    expect(args[args.length - 1]).toBe(msg);
  });

  test("rebase argv auto-stashes over live writers and targets origin/main", () => {
    expect(rebaseArgs()).toEqual(["-c", "rebase.autoStash=true", "rebase", "origin/main"]);
  });
});

/* ── G78-i (trace 1a17d85ab0537c95): honest-unsigned fallback law ──────────
 * Measured class: rotated sandboxes carry NO sovereign GPG key (E0E28CEB
 * absent — measured gpg --list-secret-keys empty on this runner, wave G78).
 * git-law forced commit.gpgsign=true unconditionally → the executive's LAND
 * step could NEVER land here (fail-honest, but half-dead = triviality).
 * New law: measure the key; present → force-signed exactly as before;
 * absent → commit.gpgsign=false + an honest-unsigned trailer, never a fake
 * signature, never a hidden caveat. The constitution adapts, the honesty
 * does not. */
import { HONEST_UNSIGNED_TRAILER, gpgSecretKeyAvailable } from "../git-law.ts";

describe("git-law G78-i — honest-unsigned fallback (measured, not trusted)", () => {
  test("gpgSecretKeyAvailable: true only on exit-0 AND non-empty secret listing", () => {
    const yes = gpgSecretKeyAvailable(() => ({ code: 0, out: "sec rsa4096 E0E28CEB" }));
    const empty = gpgSecretKeyAvailable(() => ({ code: 0, out: "  \n" }));
    const fail = gpgSecretKeyAvailable(() => ({ code: 2, out: "" }));
    expect(yes).toBe(true);
    expect(empty).toBe(false);
    expect(fail).toBe(false);
  });

  test("commitArgs with gpg:false → sign DISABLED + honest-unsigned trailer appended", () => {
    const args = commitArgs("fix(architect): cure landed", { gpg: false });
    expect(args).toEqual([
      "-c", "commit.gpgsign=false",
      "commit", "-m", "fix(architect): cure landed",
      "--trailer", HONEST_UNSIGNED_TRAILER,
    ]);
  });

  test("commitArgs with gpg:true → byte-identical to the standing force-signed law", () => {
    const args = commitArgs("fix(architect): cure landed", { gpg: true });
    expect(args).toEqual(["-c", "commit.gpgsign=true", "commit", "-m", "fix(architect): cure landed"]);
  });

  test("trailer names the absent sovereign key (self-documenting honesty)", () => {
    expect(HONEST_UNSIGNED_TRAILER).toContain("honest-unsigned");
    expect(HONEST_UNSIGNED_TRAILER).toContain("E0E28CEB");
  });
});
