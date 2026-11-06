/**
 * audit.ts — §5 zero-slop executive audit over the giant tree.
 *
 * THE LAW IS THE QUALITY GATE'S — consumed verbatim, zero legal schism:
 * this mirrors src/lib/sovereign/quality-gate.ts (SLOP_PATTERNS,
 * isSlopExemptPath, isTestPath) exactly, because the quality-gate lane owns
 * the VERDICT LAW core and the architect-daemon is its declared consumer
 * ("איבר-הארכיטקט מבצע, החוק-שופט"). The executive AUDITS (measured findings
 * + receipts); the forge (:3046) authors the issues; this lane never edits
 * other lanes. Mirrored here because mini-services are trunk-boundary isolated
 * (organ-commander precedent) — a divergence from the canon is a TEST-LOCKED
 * defect of this file and must be fixed here, never "fixed" in the canon.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export interface SlopViolation {
  path: string;
  line: number;
  pattern: string;
  excerpt: string;
}

/** Canon patterns — byte-mirror of quality-gate.ts SLOP_PATTERNS (fixed order). */
export const SLOP_PATTERNS: readonly { id: string; re: RegExp; testExempt: boolean }[] = Object.freeze([
  { id: "TODO", re: /\bTODO\b/, testExempt: false },
  { id: "FIXME", re: /\bFIXME\b/, testExempt: false },
  { id: "XXX", re: /\bXXX\b/, testExempt: false },
  { id: "HACK", re: /\bHACK\b/, testExempt: false },
  { id: "PLACEHOLDER-COMMENT", re: /\/\/\s*placeholder\b|\/\*\s*placeholder\b/i, testExempt: false },
  { id: "STUB", re: /\bstub(?:bed)?\b/i, testExempt: true },
  { id: "MOCK-RETURN", re: /\bmock(?:ed)?\s+(?:return|implementation|response)\b/i, testExempt: true },
  { id: "NOT-IMPLEMENTED", re: /\bnot\s+implemented\b/i, testExempt: false },
  { id: "UNIMPLEMENTED", re: /\bunimplemented\b/i, testExempt: false },
  { id: "TO-BE-DONE", re: /\bto\s+be\s+(?:done|implemented|filled)\b/i, testExempt: false },
]);

/** Canon structural exemption — byte-mirror of quality-gate.ts isSlopExemptPath. */
export function isSlopExemptPath(path: string): boolean {
  return (
    /(?:^|\/)(?:bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path) ||
    /(?:^|\/)(?:node_modules|dist|build|\.next|\.turbo|coverage)(?:\/|$)/.test(path) ||
    /^(?:state|db|\.git)\//.test(path) ||
    /(?:^|\/)(?:generated|\.min\.)(?:[./]|$)/.test(path)
  );
}

/** Canon test-path law — byte-mirror of quality-gate.ts isTestPath. */
function isTestPath(path: string): boolean {
  return (
    /\.test\.[jt]sx?$/.test(path) ||
    /\.spec\.[jt]sx?$/.test(path) ||
    /(?:^|\/)__(?:tests|mocks)__\//.test(path) ||
    /(?:^|\/)harness\//.test(path)
  );
}

export function scanSlop(files: readonly SourceFile[]): readonly SlopViolation[] {
  const out: SlopViolation[] = [];
  for (const file of files) {
    if (isSlopExemptPath(file.path)) continue;
    const isTest = isTestPath(file.path);
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      for (const p of SLOP_PATTERNS) {
        if (isTest && p.testExempt) continue;
        if (p.re.test(raw)) {
          out.push({ path: file.path, line: i + 1, pattern: p.id, excerpt: raw.trim().slice(0, 120) });
          break;
        }
      }
    }
  }
  return out;
}
