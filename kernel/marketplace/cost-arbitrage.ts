/**
 * lib/marketplace/cost-arbitrage.ts
 *
 * Cross-vendor cost arbitrage — primitive (MANIFEST §4, item 4).
 *
 * WHAT IT DOES
 * ─────────────
 * Given estimated costs for the same action from N vendors, this module:
 *   1. Identifies the cheapest vendor (the "winner").
 *   2. Computes the spread — the cost difference between the cheapest and
 *      the next-cheapest (second-best) option. The spread is the maximum
 *      amount TFA can route through on each action and still be cheaper
 *      than every alternative; it is TFA's per-action revenue headroom.
 *   3. Returns a deterministic ArbitrageResult that callers can log, sign,
 *      or attach to a passport proof.
 *
 * WHY THIS IS A TECH REVENUE PRIMITIVE
 * ──────────────────────────────────────
 * TFA sits between the caller and every vendor. If TFA charges a routing fee
 * ≤ spread, the caller still pays ≤ the best available market price. The spread
 * is therefore the natural, fully-justified fee ceiling on every routed action —
 * not a markup on the winner, but the *market-implied* value of knowing which
 * vendor to pick. A caller that doesn't use TFA would pay the next-best price.
 *
 * DESIGN
 * ───────
 * • All monetary values are BigInt micro-cents (μ¢), 1/10000 of a USD dollar,
 *   matching the rest of the repo. No floats touch money anywhere in this file.
 * • Zero external dependencies — node:crypto is not even needed here.
 * • Deterministic: identical inputs → identical output, including tie-breaking
 *   (ties broken by vendorId lexicographic order, smallest first).
 * • Fail-closed: any invalid input → throw ArbitrageError. Unknown/empty input
 *   → deny (never return a silently wrong answer).
 * • The module is pure (no I/O, no side effects). Callers wire it into routes,
 *   orchestrator decisions, or proof bundles as needed.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single vendor's cost estimate for an action. */
export interface VendorQuote {
  /** Unique, non-empty vendor identifier (e.g. "openai", "anthropic", "gcp"). */
  vendorId: string;
  /** Estimated cost in μ¢ (BigInt). Must be ≥ 0. */
  estimatedCostMc: bigint;
}

/** The result of running arbitrage across a set of vendor quotes. */
export interface ArbitrageResult {
  /** The cheapest vendor. Ties broken by vendorId lexicographic order (ascending). */
  winner: VendorQuote;
  /**
   * The second-cheapest option, or null when only one vendor is given.
   * When null, spread is 0n (no alternative to compare against).
   */
  runnerUp: VendorQuote | null;
  /**
   * Cost difference: runnerUp.estimatedCostMc − winner.estimatedCostMc, in μ¢.
   * This is the per-action revenue headroom: a routing fee ≤ spread still
   * leaves the caller paying ≤ the next-best market price.
   * 0n when only one vendor is given, or when winner and runnerUp are tied.
   */
  spreadMc: bigint;
  /**
   * All input quotes, sorted ascending by (estimatedCostMc, vendorId).
   * Callers can use this for audit logging or display.
   */
  sortedQuotes: VendorQuote[];
}

// ─── Error ────────────────────────────────────────────────────────────────────

export type ArbitrageErrorCode =
  | "EMPTY_QUOTES"
  | "INVALID_VENDOR_ID"
  | "INVALID_COST"
  | "DUPLICATE_VENDOR_ID";

export class ArbitrageError extends Error {
  readonly code: ArbitrageErrorCode;
  constructor(code: ArbitrageErrorCode, message: string) {
    super(message);
    this.name = "ArbitrageError";
    this.code = code;
  }
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Run cost arbitrage across a set of vendor quotes.
 *
 * Fail-closed contract:
 *   • Empty array → throw ArbitrageError("EMPTY_QUOTES")
 *   • Any vendorId that is not a non-empty string → throw("INVALID_VENDOR_ID")
 *   • Any estimatedCostMc that is not a non-negative bigint → throw("INVALID_COST")
 *   • Any duplicate vendorId → throw("DUPLICATE_VENDOR_ID")
 *
 * Determinism contract:
 *   • Cheapest by estimatedCostMc wins.
 *   • Ties (same cost) broken by vendorId lexicographic ascending order.
 *   • sortedQuotes is stable relative to the same total-order comparator.
 *
 * Efficiency: O(n log n) sort, single pass for validation. No re-parsing,
 * no repeated scans — the sort and winner/runner-up extraction are one pass
 * over the already-sorted array.
 */
export function selectCheapestVendor(quotes: VendorQuote[]): ArbitrageResult {
  // ── Validation (fail fast before any compute) ─────────────────────────────
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new ArbitrageError("EMPTY_QUOTES", "selectCheapestVendor: quotes must be a non-empty array");
  }

  const seen = new Set<string>();
  for (const q of quotes) {
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      throw new ArbitrageError(
        "INVALID_VENDOR_ID",
        `selectCheapestVendor: each quote must be an object, got ${JSON.stringify(q)}`,
      );
    }
    if (!q.vendorId || typeof q.vendorId !== "string") {
      throw new ArbitrageError(
        "INVALID_VENDOR_ID",
        `selectCheapestVendor: vendorId must be a non-empty string, got ${JSON.stringify(q.vendorId)}`,
      );
    }
    if (typeof q.estimatedCostMc !== "bigint" || q.estimatedCostMc < 0n) {
      throw new ArbitrageError(
        "INVALID_COST",
        `selectCheapestVendor: estimatedCostMc must be a non-negative bigint for vendor "${q.vendorId}", got ${q.estimatedCostMc}`,
      );
    }
    if (seen.has(q.vendorId)) {
      throw new ArbitrageError(
        "DUPLICATE_VENDOR_ID",
        `selectCheapestVendor: duplicate vendorId "${q.vendorId}"`,
      );
    }
    seen.add(q.vendorId);
  }

  // ── Sort: ascending by (estimatedCostMc, vendorId) ─────────────────────────
  // Immutable — never mutate the caller's array.
  const sorted: VendorQuote[] = quotes.slice().sort((a, b) => {
    if (a.estimatedCostMc < b.estimatedCostMc) return -1;
    if (a.estimatedCostMc > b.estimatedCostMc) return 1;
    // Tie-break: lexicographic vendorId ascending (deterministic, stable, no locale).
    return a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0;
  });

  const winner = sorted[0];
  const runnerUp = sorted.length > 1 ? sorted[1] : null;
  const spreadMc = runnerUp !== null ? runnerUp.estimatedCostMc - winner.estimatedCostMc : 0n;

  return { winner, runnerUp, spreadMc, sortedQuotes: sorted };
}

// ─── Fee helpers ──────────────────────────────────────────────────────────────

/**
 * Compute the maximum routing fee that keeps the effective caller price at or
 * below a given cap, expressed as a fraction of the spread.
 *
 *   routingFee = floor(spreadMc * numerator / denominator)
 *
 * This lets callers express "charge up to 50% of spread" as (1n, 2n) without
 * floating-point arithmetic. Division is integer (floor), always exact.
 *
 * Fail-closed: denominator = 0 → throw; fraction > 1 (numerator > denominator) → throw.
 * Always returns a non-negative bigint ≤ spreadMc.
 */
export function routingFeeFromSpread(
  spreadMc: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator === 0n) {
    throw new ArbitrageError(
      "INVALID_COST",
      "routingFeeFromSpread: denominator must not be 0",
    );
  }
  if (numerator < 0n || denominator < 0n) {
    throw new ArbitrageError(
      "INVALID_COST",
      "routingFeeFromSpread: numerator and denominator must be non-negative",
    );
  }
  if (numerator > denominator) {
    throw new ArbitrageError(
      "INVALID_COST",
      "routingFeeFromSpread: numerator must be ≤ denominator (fraction may not exceed 1)",
    );
  }
  // Integer floor division — no floats.
  return (spreadMc * numerator) / denominator;
}
