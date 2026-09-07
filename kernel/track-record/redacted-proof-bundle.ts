/**
 * lib/track-record/redacted-proof-bundle.ts — Redacted proof-bundle (§2.B-3).
 *
 * WHY THIS EXISTS
 * ---------------
 * A full TrustProofBundleV2 contains raw passport entries, evidence items,
 * ledger refs and approval traces — commercially sensitive and privacy-relevant.
 * An agent may want to prove trustworthiness to a counterparty without revealing
 * *which* specific actions, assets, or counterparties are involved.
 *
 * The redacted bundle exposes only the verdict-level fields:
 *   • TrackRecord counts/score (settledAsWorker, denied, score, explanation…)
 *   • issuedAt / validUntil (freshness, still enforced)
 *   • tenantId / identityId (scoping)
 *   • SHA-256 digests of every redacted array (passports, evidence, ledger,
 *     approval, policy, signerKeys) — commitment without disclosure.
 *
 * The counterparty can verify the redactedBundleHash (covers all the above)
 * against the disclosed fields.  They CANNOT recover the underlying passport
 * content or ledger amounts from the digests alone.
 *
 * DESIGN PROPERTIES
 * -----------------
 * • Zero external dependencies — node:crypto only.
 * • Fail-closed: bad input → throw on build; malformed bundle → false on verify.
 * • Deterministic: identical inputs → identical redacted bundle (canonical JSON).
 * • Tenant-scoped: tenantId is part of the signed body.
 * • Version: "2r" (r = redacted).  Verifier rejects "2" and any other version.
 * • originalBundleHash preserved in the redacted bundle — lets a full-bundle
 *   holder prove that a redacted bundle descends from a specific full bundle,
 *   without the counterparty needing the full bundle.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical-json";
import type { TrustProofBundleV2 } from "./proof-bundle-v2";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One redacted array commitment: how many items were present and their digest. */
export interface RedactedArrayDigest {
  /** SHA-256 hex of `canonicalJson(array)` over the original array. */
  sha256: string;
  /** How many items were in the original array (for UX — count is not sensitive). */
  count: number;
}

/**
 * A redacted TrustProofBundle — verdict-level disclosure only.
 * version "2r" distinguishes it from the full "2" bundle.
 */
export interface RedactedTrustProofBundle {
  version: "2r";
  tenantId: string;
  identityId: string;
  /**
   * TrackRecord counts and score — aggregate verdicts, never raw action content.
   * (TrackRecord fields are already aggregated: settledAsWorker, denied, score…)
   */
  record: TrustProofBundleV2["record"];
  issuedAt: string;
  /** Freshness bound from the original bundle (preserved; verifier still enforces it). */
  validUntil: string | null;
  /** Hash of the original full bundle — lets a holder prove lineage without revealing content. */
  originalBundleHash: string;
  /** Commitments to the arrays that were redacted. */
  redacted: {
    passports: RedactedArrayDigest;
    signerKeys: RedactedArrayDigest;
    evidenceManifest: RedactedArrayDigest;
    approvalRefs: RedactedArrayDigest;
    ledgerRefs: RedactedArrayDigest;
    policyRefs: RedactedArrayDigest;
  };
  /**
   * SHA-256 of the canonical body above (everything except this field).
   * Recomputed by the verifier — any modification breaks the hash.
   */
  redactedBundleHash: string;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

function arrayDigest(arr: unknown[]): RedactedArrayDigest {
  return {
    sha256: createHash("sha256").update(canonicalJson(arr)).digest("hex"),
    count: arr.length,
  };
}

/**
 * Build a RedactedTrustProofBundle from a verified full bundle.
 * Fails-closed: throws on missing required fields.
 * Does NOT re-verify the original bundle's hash — callers that care should call
 * verifyProofBundleV2() before redacting.
 */
export function buildRedactedProofBundle(
  full: TrustProofBundleV2,
): RedactedTrustProofBundle {
  if (!full || typeof full !== "object" || Array.isArray(full)) {
    throw new Error("buildRedactedProofBundle: full bundle must be an object");
  }
  if (full.version !== "2") {
    throw new Error(`buildRedactedProofBundle: expected version "2", got ${String(full.version)}`);
  }
  if (!full.tenantId || typeof full.tenantId !== "string") {
    throw new Error("buildRedactedProofBundle: tenantId required");
  }
  if (!full.identityId || typeof full.identityId !== "string") {
    throw new Error("buildRedactedProofBundle: identityId required");
  }
  if (!full.bundleHash || typeof full.bundleHash !== "string") {
    throw new Error("buildRedactedProofBundle: bundleHash required");
  }
  if (!full.record || typeof full.record !== "object" || Array.isArray(full.record)) {
    throw new Error("buildRedactedProofBundle: record required");
  }
  if (!full.issuedAt || typeof full.issuedAt !== "string") {
    throw new Error("buildRedactedProofBundle: issuedAt required");
  }

  const body = {
    version: "2r" as const,
    tenantId: full.tenantId,
    identityId: full.identityId,
    record: full.record,
    issuedAt: full.issuedAt,
    validUntil: full.validUntil ?? null,
    originalBundleHash: full.bundleHash,
    redacted: {
      passports:        arrayDigest(full.passports        ?? []),
      signerKeys:       arrayDigest(full.signerKeys       ?? []),
      evidenceManifest: arrayDigest(full.evidenceManifest ?? []),
      approvalRefs:     arrayDigest(full.approvalRefs     ?? []),
      ledgerRefs:       arrayDigest(full.ledgerRefs       ?? []),
      policyRefs:       arrayDigest(full.policyRefs       ?? []),
    },
  };

  const redactedBundleHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, redactedBundleHash };
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export interface RedactedBundleVerifyOptions {
  /**
   * If true, require at least one redacted passport commitment (count > 0).
   * Default false — an agent with no passports is still representable.
   */
  requirePassports?: boolean;
  /**
   * If true, a bundle with no validUntil claim is rejected.
   * A bundle that DOES carry a validUntil is always enforced regardless.
   */
  requireFreshness?: boolean;
  /** Anchor time to check validUntil against. Defaults to verifier's own clock. */
  now?: Date;
}

/**
 * Offline deterministic verifier for a RedactedTrustProofBundle.
 * Returns false for any malformed bundle, hash mismatch, or unsupported version.
 * Never throws — all errors produce false (fail-closed).
 */
export function verifyRedactedProofBundle(
  bundle: unknown,
  opts: RedactedBundleVerifyOptions = {},
): boolean {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  const b = bundle as Partial<RedactedTrustProofBundle>;

  if (b.version !== "2r") return false;

  if (!b.tenantId || typeof b.tenantId !== "string") return false;
  if (!b.identityId || typeof b.identityId !== "string") return false;
  if (!b.issuedAt || typeof b.issuedAt !== "string") return false;
  if (!b.originalBundleHash || typeof b.originalBundleHash !== "string") return false;
  if (!b.redactedBundleHash || typeof b.redactedBundleHash !== "string") return false;
  if (!b.record || typeof b.record !== "object" || Array.isArray(b.record)) return false;

  // validUntil freshness (same semantics as proof-bundle-v2)
  if (b.validUntil !== undefined && b.validUntil !== null) {
    if (typeof b.validUntil !== "string") return false;
    const expiry = Date.parse(b.validUntil);
    if (Number.isNaN(expiry)) return false;
    const anchor = (opts.now ?? new Date()).getTime();
    if (expiry <= anchor) return false;
  } else if (opts.requireFreshness) {
    return false;
  }

  // redacted object shape
  const rd = b.redacted;
  if (!rd || typeof rd !== "object" || Array.isArray(rd)) return false;
  for (const key of ["passports", "signerKeys", "evidenceManifest", "approvalRefs", "ledgerRefs", "policyRefs"] as const) {
    const entry = (rd as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const e = entry as Partial<RedactedArrayDigest>;
    if (typeof e.sha256 !== "string" || e.sha256.length !== 64) return false;
    if (typeof e.count !== "number" || !Number.isFinite(e.count) || e.count < 0) return false;
  }

  // Optional: require at least one passport commitment
  if (opts.requirePassports && (rd as RedactedTrustProofBundle["redacted"]).passports.count === 0) {
    return false;
  }

  // Recompute hash (strip redactedBundleHash from body)
  const { redactedBundleHash, ...body } = b as RedactedTrustProofBundle;
  const recomputed = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return recomputed === redactedBundleHash;
}
