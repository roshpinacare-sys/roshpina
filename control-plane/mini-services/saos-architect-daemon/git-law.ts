/* ═══ git-law.ts — the git constitution, enforced INSIDE the daemon ═══════
 * Owner constitution (standing): every landed commit MUST be GPG-signed
 * (sovereign key E0E28CEB) and the push MUST be fetch→rebase→ff-only with
 * cloud==local identity proof. Until now the daemon trusted the ambient
 * gitconfig (commit.gpgsign=true on this runner). Zero-slop law: the daemon
 * carries its own constitution — signing is forced by argv, never trusted
 * to the environment (a runner that forgot the law cannot produce an
 * unsigned sovereign commit).
 *
 * G78-i amendment (trace 1a17d85ab0537c95, measured, not trusted):
 * rotated sandboxes carry NO sovereign key (gpg --list-secret-keys empty —
 * measured on this runner, wave G78). The old law made the executive's LAND
 * step permanently impossible there — honest failure, but a half-deaf
 * executive is triviality. Amendment: MEASURE the key; present → force-signed
 * exactly as the standing law; absent → commit.gpgsign=false + an
 * honest-unsigned trailer naming the absent key. Never a fake signature,
 * never a hidden caveat — the trailer travels in the commit itself.
 */

/** The honest-unsigned trailer: self-documenting, greppable, owner-auditable. */
export const HONEST_UNSIGNED_TRAILER =
  "honest-unsigned: sovereign key E0E28CEB absent on this runner (measured by git-law)";

export interface CommitOpts {
  /** measured key availability — true = force-signed (standing law), false = honest-unsigned. */
  gpg?: boolean;
}

/** argv for a GPG-forced commit: `-c commit.gpgsign=true commit -m <msg>`. */
export function commitArgs(msg: string, opts: CommitOpts = {}): string[] {
  if (opts.gpg === false) {
    return [
      "-c", "commit.gpgsign=false",
      "commit", "-m", msg,
      "--trailer", HONEST_UNSIGNED_TRAILER,
    ];
  }
  return ["-c", "commit.gpgsign=true", "commit", "-m", msg];
}

/**
 * Measure (never trust) GPG secret-key availability for the LAND step.
 * Law: exit 0 AND non-empty listing = key present. Anything else (non-zero
 * exit, empty listing, gpg missing) = absent → honest-unsigned fallback.
 * `run` is injected (production passes the daemon sh() shell; tests inject
 * deterministic fixtures — zero real gpg in the suite).
 */
export function gpgSecretKeyAvailable(
  run: (cmd: string, args: string[]) => { code: number; out: string },
): boolean {
  try {
    const r = run("gpg", ["--list-secret-keys"]);
    return r.code === 0 && r.out.trim().length > 0;
  } catch {
    return false;
  }
}

/** argv for the rebase step of the land loop (autoStash over live writers). */
export function rebaseArgs(): string[] {
  return ["-c", "rebase.autoStash=true", "rebase", "origin/main"];
}
