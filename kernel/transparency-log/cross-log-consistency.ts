/**
 * lib/transparency-log/cross-log-consistency.ts — Cross-log consistency verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * A FederationAnchor (sub-step 3-A-1) binds two log roots at a point in time.
 * But an anchor alone only proves the signer OBSERVED those roots together.
 * The next question is: did independent witnesses ALSO observe those roots?
 * If yes, the roots are independently corroborated — not just self-attested.
 *
 * `verifyCrossLogConsistency` (sub-step 3-A-2 in TRUST_INTEGRITY_ROADMAP §2.A)
 * answers exactly that: given two FederationAnchors and a pool of signed
 * WitnessStatements, it verifies that a SHARED witness quorum — the same K
 * distinct witnesses — co-signed ALL of the log roots embedded across both
 * anchors.
 *
 * "Shared" is the novel invariant: it is not enough for each log to have its
 * own quorum. The same K witnesses must have attested to every root, creating
 * a single unforgeable thread of corroboration across the bilateral trust mesh.
 *
 * DESIGN
 * ------
 * 1. Validate the structure of both anchors (fail-closed; throws on bad input).
 * 2. Deduplicate unique log endpoints across the two anchors (up to 4, by
 *    logId+root+treeSize key). Shared log endpoints between the two anchors
 *    are counted once — they are already in agreement.
 * 3. For each unique endpoint, collect all verified witness IDs using the
 *    existing `collectWitnessQuorum` (threshold=1 to gather every signer).
 * 4. Intersect the per-endpoint witness sets; fail-fast once empty.
 * 5. Return consistent = (shared.size >= threshold).
 *
 * SplitViewError from any endpoint propagates immediately — it is a security
 * alarm, not a recoverable inconsistency.
 *
 * Efficiency: each unique endpoint is evaluated once. Intersection is
 * performed lazily; once the shared set is empty the remaining endpoints are
 * evaluated only for diagnostics (their witnessIds still populate endpointResults).
 *
 * Zero external dependencies. Fail-closed. Deterministic. No network I/O.
 */

import { FEDERATION_ANCHOR_VERSION } from "./federation-anchor";
import type { FederationAnchor } from "./federation-anchor";
import { collectWitnessQuorum } from "./witness";
import type { WitnessStatement } from "./witness";
import type { Signer } from "../orchestrator/types";

const HEX64_RE = /^[a-f0-9]{64}$/i;

/**
 * Result of a cross-log consistency check over two FederationAnchors.
 */
export interface CrossLogConsistencyResult {
  /**
   * True iff every unique log root across both anchors was co-signed by at
   * least `threshold` SHARED distinct witnesses (same witnesses signed all).
   */
  consistent: boolean;
  /**
   * WitnessIds that verified ALL unique log endpoints in both anchors
   * (intersection of per-endpoint witness sets). Sorted, de-duplicated.
   */
  sharedWitnessIds: string[];
  /** The threshold that was required. */
  threshold: number;
  /**
   * Per unique log endpoint: which witnesses verified that root.
   * Useful for diagnosing which endpoint broke the shared quorum.
   */
  endpointResults: Array<{
    logId: string;
    root: string;
    treeSize: number;
    witnessIds: string[];
  }>;
}

export type CrossLogConsistencyErrorCode = "BAD_ANCHOR" | "BAD_INPUT";

export class CrossLogConsistencyError extends Error {
  readonly code: CrossLogConsistencyErrorCode;
  constructor(code: CrossLogConsistencyErrorCode, message: string) {
    super(message);
    this.name = "CrossLogConsistencyError";
    this.code = code;
  }
}

/** Structural validation for a FederationAnchor (throws CrossLogConsistencyError on failure). */
function validateAnchorStructure(anchor: FederationAnchor, label: string): void {
  if (!anchor || typeof anchor !== "object") {
    throw new CrossLogConsistencyError(
      "BAD_ANCHOR", `${label}: must be a FederationAnchor object`,
    );
  }
  if (anchor.version !== FEDERATION_ANCHOR_VERSION) {
    throw new CrossLogConsistencyError(
      "BAD_ANCHOR",
      `${label}: unrecognised version "${String(anchor.version)}"`,
    );
  }
  for (const epKey of ["logA", "logB"] as const) {
    const ep = anchor[epKey];
    if (!ep || typeof ep !== "object") {
      throw new CrossLogConsistencyError(
        "BAD_ANCHOR", `${label}.${epKey}: endpoint must be an object`,
      );
    }
    if (typeof ep.logId !== "string" || ep.logId.length === 0) {
      throw new CrossLogConsistencyError(
        "BAD_ANCHOR", `${label}.${epKey}.logId: must be a non-empty string`,
      );
    }
    if (typeof ep.root !== "string" || !HEX64_RE.test(ep.root)) {
      throw new CrossLogConsistencyError(
        "BAD_ANCHOR", `${label}.${epKey}.root: must be a 64-hex SHA-256 string`,
      );
    }
    if (!Number.isInteger(ep.treeSize) || ep.treeSize < 1) {
      throw new CrossLogConsistencyError(
        "BAD_ANCHOR", `${label}.${epKey}.treeSize: must be an integer >= 1`,
      );
    }
  }
}

/**
 * Verify that two FederationAnchors reconcile with a shared witness quorum.
 *
 * "Reconcile" means: the SAME `threshold` distinct witnesses have co-signed
 * ALL of the unique log roots embedded across both anchors. A witness that
 * only signed some of the roots does not count toward the shared quorum.
 *
 * Unique endpoints are deduped by (logId, root, treeSize) — if both anchors
 * reference the same log at the same root, it counts once (already consistent).
 *
 * @param anchor1       First FederationAnchor.
 * @param anchor2       Second FederationAnchor.
 * @param statements    Pool of WitnessStatements covering one or more logs.
 * @param threshold     Minimum shared distinct witnesses required (>= 1).
 * @param resolveSigner Maps witnessId to its verifying Signer (null = unknown, ignored).
 *
 * Throws CrossLogConsistencyError if either anchor is structurally invalid,
 * statements is not an array, threshold < 1, or resolveSigner is not a function.
 *
 * Propagates SplitViewError from collectWitnessQuorum — this is a security
 * alarm indicating a conflicting root for the same (logId, treeSize) and MUST
 * NOT be swallowed by callers.
 */
export function verifyCrossLogConsistency(
  anchor1: FederationAnchor,
  anchor2: FederationAnchor,
  statements: WitnessStatement[],
  threshold: number,
  resolveSigner: (witnessId: string) => Signer | null,
): CrossLogConsistencyResult {
  validateAnchorStructure(anchor1, "anchor1");
  validateAnchorStructure(anchor2, "anchor2");

  if (!Array.isArray(statements)) {
    throw new CrossLogConsistencyError(
      "BAD_INPUT", "verifyCrossLogConsistency: statements must be an array",
    );
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new CrossLogConsistencyError(
      "BAD_INPUT", "verifyCrossLogConsistency: threshold must be an integer >= 1",
    );
  }
  if (typeof resolveSigner !== "function") {
    throw new CrossLogConsistencyError(
      "BAD_INPUT", "verifyCrossLogConsistency: resolveSigner must be a function",
    );
  }

  // Deduplicate log endpoints across both anchors by (logId, root, treeSize).
  // Shared endpoints between the two anchors count once — they are already in
  // agreement by construction and only need one witness-quorum check.
  const seen = new Set<string>();
  const endpoints: Array<{ logId: string; root: string; treeSize: number }> = [];
  for (const ep of [anchor1.logA, anchor1.logB, anchor2.logA, anchor2.logB]) {
    const key = `${ep.logId}\0${ep.root}\0${ep.treeSize}`;
    if (!seen.has(key)) {
      seen.add(key);
      endpoints.push({ logId: ep.logId, root: ep.root, treeSize: ep.treeSize });
    }
  }

  // Evaluate each unique endpoint and track the intersection of witness sets.
  // SplitViewError propagates immediately (security alarm).
  const endpointResults: CrossLogConsistencyResult["endpointResults"] = [];
  let sharedSet: Set<string> | null = null;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    // threshold=1: collect every verified witness (shared-threshold check is ours).
    const qr = collectWitnessQuorum(statements, ep, 1, resolveSigner);
    endpointResults.push({ ...ep, witnessIds: qr.witnessIds });

    if (sharedSet === null) {
      sharedSet = new Set(qr.witnessIds);
    } else {
      // Build the Set once per endpoint, not once per sharedSet member — the
      // old `.includes()` re-scanned the full witnessIds array on every id,
      // i.e. O(W) per check, O(W^2) per endpoint. A Set lookup is O(1).
      const qrIdSet = new Set(qr.witnessIds);
      for (const id of sharedSet) {
        if (!qrIdSet.has(id)) sharedSet.delete(id);
      }
    }

    // Efficiency: once shared set is empty the threshold can never be met.
    // Remaining endpoints still need diagnostics, so continue (no break).
  }

  const sharedWitnessIds = [...(sharedSet ?? new Set<string>())].sort();

  return {
    consistent: sharedWitnessIds.length >= threshold,
    sharedWitnessIds,
    threshold,
    endpointResults,
  };
}
