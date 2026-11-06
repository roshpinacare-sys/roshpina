/* ═══ saos-architect-daemon · executive.ts — evidence → selection ═══════════
 * Parses live tsc evidence into contracts, ranks deterministically, selects
 * the top contract that has a registered deterministic cure. No clock, no
 * RNG — same evidence always yields the same selection. (§1: audit → TDD
 * issues → select; §5: 100% deterministic verification.)
 */

export interface TsContract {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Severity ladder: breakage codes first, then stable alphabetical tiebreak. */
const CODE_SEVERITY: Record<string, number> = {
  TS2307: 2, // missing module (import breakage)
  TS2322: 3, // type not assignable (contract lie)
  TS2345: 3,
  TS2339: 2, // missing property
  TS2554: 2,
  TS2867: 1, // ambient/types class
};

const TSC_LINE = /^([^\s(]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --noEmit` output into contracts. Noise skipped honestly. */
export function parseEvidence(tscOutput: string): TsContract[] {
  const out: TsContract[] = [];
  for (const line of tscOutput.split("\n")) {
    const m = TSC_LINE.exec(line.trim());
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }
  return out;
}

export interface CurePlan {
  /** repo-relative files this cure touches */
  files: string[];
  /** idempotent, pure edit applied against the given root */
  apply(root: string): void;
  /** human/honest description appended to receipts */
  describe: string;
}

export interface Cure {
  id: string;
  /** stable signature matcher — resilient to line drift */
  matches(c: TsContract): boolean;
  build(root: string, c: TsContract): CurePlan;
}

export interface Selection {
  contract: TsContract;
  cureId: string;
  cure: Cure;
}

/** Deterministic ranking: curable-first, then severity, then file/line/col/code. */
export function rankContracts(contracts: TsContract[], registry: Cure[]): TsContract[] {
  const curable = (c: TsContract) => (registry.some((r) => r.matches(c)) ? 0 : 1);
  return contracts.slice().sort((a, b) => {
    const ca = curable(a);
    const cb = curable(b);
    if (ca !== cb) return ca - cb;
    const sa = CODE_SEVERITY[a.code] ?? 4;
    const sb = CODE_SEVERITY[b.code] ?? 4;
    if (sa !== sb) return sa - sb;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.col !== b.col) return a.col - b.col;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/** Pick the top-ranked contract that has a registered cure; null = no work. */
export function selectContract(
  contracts: TsContract[],
  registry: Cure[],
): Selection | null {
  const ranked = rankContracts(contracts, registry);
  for (const c of ranked) {
    const cure = registry.find((r) => r.matches(c));
    if (cure) return { contract: c, cureId: cure.id, cure };
  }
  return null;
}
