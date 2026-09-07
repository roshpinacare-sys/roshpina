/**
 * lib/track-record/proof-bundle-v2.ts — ProofBundle v2: portable, externally-verifiable trust proof.
 *
 * Extension of v125 proof-bundle with:
 *   • canonical JSON (sorted keys, BigInt→string)
 *   • sha256 digests for evidence, ledger entries, policies
 *   • signer key manifest (kid + algorithm + publicKey)
 *   • evidence_manifest, approval_refs, ledger_refs, policy_refs
 *   • offline deterministic verifier (fail-closed)
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash } from "node:crypto";
import type { TrackRecord } from "./track-record";
import type { ProofPassportEntry } from "./proof-bundle";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A signer key entry in the bundle's key manifest. */
export interface ProofBundleSignerKey {
  /** Key identifier (e.g. "kernel-1"). */
  kid: string;
  /** Algorithm label, e.g. "hmac-sha256" or "ed25519". */
  algorithm: string;
  /** Public key material (PEM for ed25519, hex/base64 for hmac). */
  publicKey: string;
}

/** A single item in the evidence manifest with its digest. */
export interface ProofBundleEvidenceItem {
  evidenceId: string;
  evidenceType: string;
  /** SHA-256 hex digest of the canonical evidence content. */
  sha256: string;
  /** Optional locator for the raw evidence. */
  uri?: string;
}

/** Reference to an approval decision trace with its digest. */
export interface ProofBundleApprovalRef {
  auditId: string;
  /** SHA-256 hex digest of the canonical decision trace JSON. */
  traceDigest: string;
}

/** Reference to a ledger entry with its digest. */
export interface ProofBundleLedgerRef {
  ledgerEntryId: string;
  entryType: string; // e.g. "mint", "transfer", "escrow"
  /** SHA-256 hex digest of the canonical ledger entry JSON. */
  sha256: string;
}

/** Reference to a policy document with its digest. */
export interface ProofBundlePolicyRef {
  policyRef: string;
  version: string;
  /** SHA-256 hex digest of the canonical policy JSON. */
  sha256: string;
}

/** TrustProofBundle v2 — the full portable proof structure. */
export interface TrustProofBundleV2 {
  version: "2";
  tenantId: string;
  identityId: string;
  record: TrackRecord;
  passports: ProofPassportEntry[];
  /** Signer keys that can verify the bundle and passport signatures. */
  signerKeys: ProofBundleSignerKey[];
  /** Evidence manifest — digest-verifiable evidence items. */
  evidenceManifest: ProofBundleEvidenceItem[];
  /** Approval trace references — digest-verifiable decision traces. */
  approvalRefs: ProofBundleApprovalRef[];
  /** Ledger entry references — digest-verifiable ledger items. */
  ledgerRefs: ProofBundleLedgerRef[];
  /** Policy references — digest-verifiable policy documents. */
  policyRefs: ProofBundlePolicyRef[];
  /** SHA-256 over the canonical bundle body (everything except this field). */
  bundleHash: string;
  issuedAt: string;
  /**
   * Freshness bound (ISO 8601), or null for "no expiry stated" (pre-v370
   * bundles never set this — backward compatible). A non-null value is part
   * of the hashed body, so tampering with it invalidates the bundle like any
   * other field. The verifier — not the prover — decides the anchor time to
   * check it against (see ProofBundleVerifyOptions.now), so a stale bundle
   * can't be replayed by simply trusting whatever clock issued it.
   */
  validUntil: string | null;
}

/** Default freshness window the public Trust API route applies when issuing a bundle (24h). */
export const PROOF_BUNDLE_DEFAULT_VALID_MS = 24 * 60 * 60 * 1000;

import { canonicalJson } from "../common/canonical-json";

// ─── Builder ──────────────────────────────────────────────────────────────────

export interface BuildTrustProofBundleV2Input {
  tenantId: string;
  identityId: string;
  record: TrackRecord;
  passports?: ProofPassportEntry[];
  signerKeys?: ProofBundleSignerKey[];
  evidenceManifest?: ProofBundleEvidenceItem[];
  approvalRefs?: ProofBundleApprovalRef[];
  ledgerRefs?: ProofBundleLedgerRef[];
  policyRefs?: ProofBundlePolicyRef[];
  /** Explicit ISO 8601 expiry. Takes precedence over validForMs if both given. */
  validUntil?: string | null;
  /** Convenience: expire `validForMs` milliseconds from now. Ignored if validUntil is set. */
  validForMs?: number;
}

/**
 * Build a verifiable ProofBundle v2.
 * fail-closed: tenantId and identityId are mandatory; all optional arrays default to empty.
 */
export function buildTrustProofBundleV2(input: BuildTrustProofBundleV2Input): TrustProofBundleV2 {
  if (!input.tenantId || typeof input.tenantId !== "string") {
    throw new Error("buildTrustProofBundleV2: tenantId required (non-empty string)");
  }
  if (!input.identityId || typeof input.identityId !== "string") {
    throw new Error("buildTrustProofBundleV2: identityId required (non-empty string)");
  }
  if (!input.record || typeof input.record !== "object" || Array.isArray(input.record)) {
    throw new Error("buildTrustProofBundleV2: record required (object)");
  }
  let validUntil: string | null = null;
  if (input.validUntil !== undefined && input.validUntil !== null) {
    if (typeof input.validUntil !== "string" || Number.isNaN(Date.parse(input.validUntil))) {
      throw new Error("buildTrustProofBundleV2: validUntil must be a valid ISO 8601 string");
    }
    validUntil = input.validUntil;
  } else if (typeof input.validForMs === "number") {
    if (!Number.isFinite(input.validForMs) || input.validForMs <= 0) {
      throw new Error("buildTrustProofBundleV2: validForMs must be a positive finite number");
    }
    validUntil = new Date(Date.now() + input.validForMs).toISOString();
  }

  const body = {
    version: "2" as const,
    tenantId: input.tenantId,
    identityId: input.identityId,
    record: input.record,
    passports: input.passports ?? [],
    signerKeys: input.signerKeys ?? [],
    evidenceManifest: input.evidenceManifest ?? [],
    approvalRefs: input.approvalRefs ?? [],
    ledgerRefs: input.ledgerRefs ?? [],
    policyRefs: input.policyRefs ?? [],
    issuedAt: new Date().toISOString(),
    validUntil,
  };
  const bundleHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, bundleHash };
}

// ─── Offline Verifier ─────────────────────────────────────────────────────────

export interface ProofBundleVerifyOptions {
  /** If true, require at least one signer key in the bundle. */
  requireSignerKeys?: boolean;
  /** If true, require at least one evidence item. */
  requireEvidence?: boolean;
  /**
   * If true, a bundle with no validUntil claim is rejected (forces every
   * accepted bundle to be time-bounded). Default false — preserves backward
   * compatibility with bundles built before v370, which never set validUntil.
   * A bundle that DOES carry a validUntil is always checked against it
   * (expired = rejected) regardless of this flag — the claim, once made, is
   * always enforced.
   */
  requireFreshness?: boolean;
  /**
   * Anchor time to check validUntil against. Defaults to the verifier's own
   * clock (`new Date()`) — deliberately the verifier's choice, not a field
   * read from the bundle, so a prover can't extend its own freshness window.
   */
  now?: Date;
}

/**
 * Offline deterministic verifier for ProofBundle v2.
 * fail-closed: returns false for any malformed bundle, hash mismatch, or unsupported version.
 */
export function verifyProofBundleV2(
  bundle: unknown,
  _opts: ProofBundleVerifyOptions = {},
): boolean {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  const b = bundle as Partial<TrustProofBundleV2>;

  // Version check
  if (b.version !== "2") return false;

  // Mandatory scalar fields
  if (!b.tenantId || typeof b.tenantId !== "string") return false;
  if (!b.identityId || typeof b.identityId !== "string") return false;
  if (!b.bundleHash || typeof b.bundleHash !== "string") return false;
  if (!b.issuedAt || typeof b.issuedAt !== "string") return false;

  // Record must be an object
  if (!b.record || typeof b.record !== "object" || Array.isArray(b.record)) return false;

  // Arrays must be arrays
  if (!Array.isArray(b.passports)) return false;
  if (!Array.isArray(b.signerKeys)) return false;
  if (!Array.isArray(b.evidenceManifest)) return false;
  if (!Array.isArray(b.approvalRefs)) return false;
  if (!Array.isArray(b.ledgerRefs)) return false;
  if (!Array.isArray(b.policyRefs)) return false;

  // Optional strictness
  if (_opts.requireSignerKeys && b.signerKeys.length === 0) return false;
  if (_opts.requireEvidence && b.evidenceManifest.length === 0) return false;

  // validUntil: type-check, then enforce freshness (fail-closed on malformed claims).
  if (b.validUntil !== undefined && b.validUntil !== null) {
    if (typeof b.validUntil !== "string") return false;
    const expiry = Date.parse(b.validUntil);
    if (Number.isNaN(expiry)) return false; // malformed timestamp — never silently pass
    const anchor = (_opts.now ?? new Date()).getTime();
    if (expiry <= anchor) return false; // expired — the claim is always enforced once made
  } else if (_opts.requireFreshness) {
    return false; // no expiry claim, but caller opted into requiring one
  }

  // Validate signer key entries (fail-closed: any malformed entry invalidates the whole bundle)
  for (const sk of b.signerKeys) {
    if (!sk || typeof sk !== "object") return false;
    if (!sk.kid || typeof sk.kid !== "string") return false;
    if (!sk.algorithm || typeof sk.algorithm !== "string") return false;
    if (!sk.publicKey || typeof sk.publicKey !== "string") return false;
  }

  // Validate evidence entries
  for (const ev of b.evidenceManifest) {
    if (!ev || typeof ev !== "object") return false;
    if (!ev.evidenceId || typeof ev.evidenceId !== "string") return false;
    if (!ev.evidenceType || typeof ev.evidenceType !== "string") return false;
    if (!ev.sha256 || typeof ev.sha256 !== "string" || ev.sha256.length !== 64) return false;
  }

  // Validate approval refs
  for (const ar of b.approvalRefs) {
    if (!ar || typeof ar !== "object") return false;
    if (!ar.auditId || typeof ar.auditId !== "string") return false;
    if (!ar.traceDigest || typeof ar.traceDigest !== "string" || ar.traceDigest.length !== 64) return false;
  }

  // Validate ledger refs
  for (const lr of b.ledgerRefs) {
    if (!lr || typeof lr !== "object") return false;
    if (!lr.ledgerEntryId || typeof lr.ledgerEntryId !== "string") return false;
    if (!lr.entryType || typeof lr.entryType !== "string") return false;
    if (!lr.sha256 || typeof lr.sha256 !== "string" || lr.sha256.length !== 64) return false;
  }

  // Validate policy refs
  for (const pr of b.policyRefs) {
    if (!pr || typeof pr !== "object") return false;
    if (!pr.policyRef || typeof pr.policyRef !== "string") return false;
    if (!pr.version || typeof pr.version !== "string") return false;
    if (!pr.sha256 || typeof pr.sha256 !== "string" || pr.sha256.length !== 64) return false;
  }

  // Recompute bundle hash (strip bundleHash from body)
  const { bundleHash, ...body } = b as TrustProofBundleV2;
  const recomputed = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return recomputed === bundleHash;
}
