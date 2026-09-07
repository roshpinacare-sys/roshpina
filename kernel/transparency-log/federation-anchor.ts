/**
 * lib/transparency-log/federation-anchor.ts — Cross-log federation: FederationAnchor.
 *
 * WHY THIS EXISTS
 * ---------------
 * Today every tenant has a separate transparency log. When two organisations
 * transact, neither wants to expose its full audit chain to the other.
 * A FederationAnchor is a signed binding that says:
 *
 *   "At time T, log A held root R_A over N_A leaves,
 *    and log B held root R_B over N_B leaves,
 *    and a trusted signer attests to both simultaneously."
 *
 * This lets a third party (or a counterparty) verify that BOTH logs existed
 * and were consistent at a known point in time — without seeing any leaf
 * content from either log.  The logs themselves need not be public; only
 * the roots (already published by their respective consistency monitors and
 * witnesses) are embedded in the anchor.
 *
 * THIS MODULE (sub-step 3-A-1 in TRUST_INTEGRITY_ROADMAP.md §2.A)
 * ----------------------------------------------------------------
 *   • FederationAnchor — the canonical signed type.
 *   • buildFederationAnchor() — validate, canonicalise, sign → anchor.
 *   • verifyFederationAnchor() — recompute payload, check signature; fail-closed.
 *
 * DESIGN
 * ------
 * • Signer-agnostic: works with any Signer (HMAC for tests, Ed25519 in prod).
 * • Canonical payload: deterministic field order via canonicalJson, version-tagged.
 * • FAIL-CLOSED: bad/missing field → throw on build; malformed anchor → false on verify.
 * • Zero external dependencies (node:crypto only, via the Signer interface).
 * • Leaf content is NEVER included — only tree roots and sizes cross the boundary.
 */

import type { Signer } from "../orchestrator/types";
import { canonicalJson } from "../common/canonical-json";

const HEX64_RE = /^[a-f0-9]{64}$/i;

/** Schema version — bump only on a breaking payload change. */
export const FEDERATION_ANCHOR_VERSION = "tfa-federation-anchor-v1" as const;

/** One side of the cross-log binding. */
export interface LogEndpoint {
  /** Stable identifier for the log (tenant-scoped, e.g. "org.acme/audit"). */
  logId: string;
  /** Merkle root of the log at the anchor point (64-hex SHA-256). */
  root: string;
  /** Leaf count of the log at the anchor point (>= 1). */
  treeSize: number;
}

/**
 * A signed cross-log anchor that binds two transparency-log roots at a moment
 * in time.  Neither log's leaf content is exposed; only roots and sizes are
 * embedded.
 */
export interface FederationAnchor {
  /** Schema version tag. */
  version: typeof FEDERATION_ANCHOR_VERSION;
  /** Unique id for this anchor (collision-resistant, caller-supplied). */
  anchorId: string;
  /** The first log endpoint (the "local" log in a bilateral relationship). */
  logA: LogEndpoint;
  /** The second log endpoint (the "remote" log). */
  logB: LogEndpoint;
  /** ISO-8601 timestamp at which the signer observed and bound both roots. */
  anchoredAt: string;
  /** Stable identifier for the entity that produced the anchor (key fingerprint). */
  signerId: string;
  /** Signature algorithm label, copied from the Signer. */
  algorithm: string;
  /** base64 signature over the canonical signing payload. */
  signature: string;
}

/** The fields that are signed (everything except the signature field itself). */
export interface FederationAnchorPayload {
  version: typeof FEDERATION_ANCHOR_VERSION;
  anchorId: string;
  logA: LogEndpoint;
  logB: LogEndpoint;
  anchoredAt: string;
  signerId: string;
}

/**
 * Canonical, deterministic signing payload for a federation anchor.
 * Field order is stable via canonicalJson so the bytes are identical
 * whether produced by the builder or recomputed by the verifier.
 */
export function federationAnchorSigningPayload(p: FederationAnchorPayload): string {
  return canonicalJson({
    version: p.version,
    anchorId: p.anchorId,
    logA: { logId: p.logA.logId, root: p.logA.root, treeSize: p.logA.treeSize },
    logB: { logId: p.logB.logId, root: p.logB.root, treeSize: p.logB.treeSize },
    anchoredAt: p.anchoredAt,
    signerId: p.signerId,
  });
}

function validateEndpoint(ep: LogEndpoint, label: string): void {
  if (!ep || typeof ep !== "object") {
    throw new FederationAnchorError("BAD_ENDPOINT", `${label}: endpoint must be an object`);
  }
  if (typeof ep.logId !== "string" || ep.logId.length === 0) {
    throw new FederationAnchorError("BAD_ENDPOINT", `${label}: logId must be a non-empty string`);
  }
  if (typeof ep.root !== "string" || !HEX64_RE.test(ep.root)) {
    throw new FederationAnchorError("BAD_ENDPOINT", `${label}: root must be a 64-hex SHA-256 string`);
  }
  if (!Number.isInteger(ep.treeSize) || ep.treeSize < 1) {
    throw new FederationAnchorError("BAD_ENDPOINT", `${label}: treeSize must be an integer >= 1`);
  }
}

/**
 * Build a FederationAnchor by signing the cross-log binding.
 *
 * @param signer     The signing key (HMAC or Ed25519).
 * @param anchorId   Caller-supplied unique id (uuid or similar).
 * @param logA       First log endpoint (local log).
 * @param logB       Second log endpoint (remote log).
 * @param anchoredAt ISO-8601 timestamp of the observation.
 * @param signerId   Stable identifier for the signing entity.
 *
 * Throws FederationAnchorError if any argument is invalid.
 * Fail-closed: signing never happens if validation fails.
 */
export function buildFederationAnchor(
  signer: Signer,
  anchorId: string,
  logA: LogEndpoint,
  logB: LogEndpoint,
  anchoredAt: string,
  signerId: string,
): FederationAnchor {
  if (!signer || typeof signer.sign !== "function") {
    throw new FederationAnchorError("BAD_SIGNER", "buildFederationAnchor: a Signer with sign() is required");
  }
  if (typeof anchorId !== "string" || anchorId.length === 0) {
    throw new FederationAnchorError("BAD_INPUT", "buildFederationAnchor: anchorId must be a non-empty string");
  }
  if (typeof anchoredAt !== "string" || anchoredAt.length === 0) {
    throw new FederationAnchorError("BAD_INPUT", "buildFederationAnchor: anchoredAt must be a non-empty string");
  }
  if (typeof signerId !== "string" || signerId.length === 0) {
    throw new FederationAnchorError("BAD_INPUT", "buildFederationAnchor: signerId must be a non-empty string");
  }

  validateEndpoint(logA, "logA");
  validateEndpoint(logB, "logB");

  const payload = federationAnchorSigningPayload({
    version: FEDERATION_ANCHOR_VERSION,
    anchorId,
    logA,
    logB,
    anchoredAt,
    signerId,
  });

  return {
    version: FEDERATION_ANCHOR_VERSION,
    anchorId,
    logA: { logId: logA.logId, root: logA.root, treeSize: logA.treeSize },
    logB: { logId: logB.logId, root: logB.root, treeSize: logB.treeSize },
    anchoredAt,
    signerId,
    algorithm: signer.algorithm,
    signature: signer.sign(payload),
  };
}

/**
 * Verify a FederationAnchor against the signer that produced it.
 *
 * Fail-closed: any structural defect (missing field, wrong version, bad
 * endpoint, signature mismatch) returns false — never throws.
 *
 * @param anchor  The anchor to verify.
 * @param signer  The verifying signer (must hold the verifying key).
 */
export function verifyFederationAnchor(anchor: FederationAnchor, signer: Signer): boolean {
  try {
    if (!anchor || typeof anchor !== "object") return false;
    if (anchor.version !== FEDERATION_ANCHOR_VERSION) return false;
    if (!signer || typeof signer.verify !== "function") return false;

    if (typeof anchor.anchorId !== "string" || anchor.anchorId.length === 0) return false;
    if (typeof anchor.anchoredAt !== "string" || anchor.anchoredAt.length === 0) return false;
    if (typeof anchor.signerId !== "string" || anchor.signerId.length === 0) return false;
    if (typeof anchor.signature !== "string" || anchor.signature.length === 0) return false;

    // Validate both endpoints structurally (no throw — catch below handles it).
    for (const [ep, label] of [[anchor.logA, "logA"], [anchor.logB, "logB"]] as const) {
      if (!ep || typeof ep !== "object") return false;
      if (typeof ep.logId !== "string" || ep.logId.length === 0) return false;
      if (typeof ep.root !== "string" || !HEX64_RE.test(ep.root)) return false;
      if (!Number.isInteger(ep.treeSize) || ep.treeSize < 1) return false;
      void label; // used only for typing
    }

    const payload = federationAnchorSigningPayload({
      version: FEDERATION_ANCHOR_VERSION,
      anchorId: anchor.anchorId,
      logA: anchor.logA,
      logB: anchor.logB,
      anchoredAt: anchor.anchoredAt,
      signerId: anchor.signerId,
    });

    return signer.verify(payload, anchor.signature);
  } catch {
    return false;
  }
}

export type FederationAnchorErrorCode = "BAD_SIGNER" | "BAD_INPUT" | "BAD_ENDPOINT";

export class FederationAnchorError extends Error {
  readonly code: FederationAnchorErrorCode;
  constructor(code: FederationAnchorErrorCode, message: string) {
    super(message);
    this.name = "FederationAnchorError";
    this.code = code;
  }
}
