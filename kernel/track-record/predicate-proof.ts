/**
 * lib/track-record/predicate-proof.ts — Selective disclosure: predicate proof.
 *
 * WHY THIS EXISTS (sub-step of §2.B-2 in TRUST_INTEGRITY_ROADMAP.md)
 * --------------------------------------------------------------------
 * The count proof (count-proof.ts) lets an agent prove "I have ≥N actions,
 * 0 denied" without revealing which actions occurred. This module extends
 * the same idea to a numeric predicate:
 *
 *   "Every one of my settled actions was below threshold-value X
 *    (e.g. under a risk-tier dollar limit)"
 *
 * without revealing any individual action's actual value.
 *
 * HONESTY NOTE — this is NOT zero-knowledge cryptography
 * --------------------------------------------------------
 * The roadmap is explicit: build on the existing Merkle commitment, do not
 * bring in a ZK library (the repo is zero-dep). A real zero-knowledge range
 * proof (e.g. Bulletproofs) would let the verifier confirm the predicate
 * mathematically from the commitments alone, trusting no one. That is not
 * what this module does, and it would be dishonest to imply otherwise.
 *
 * What this module actually provides — identical trust model to
 * count-proof.ts's `deniedCount` claim — is a SIGNED SELECTIVE-DISCLOSURE
 * CLAIM: the issuer (who holds the raw, unblinded track record) asserts
 * `allBelowThreshold` and signs it together with a Merkle root over blinded
 * action leaves. The verifier gets two independent guarantees:
 *   1. Cryptographic: the exact committed dataset (root, treeSize, witness
 *      inclusion proofs) cannot be altered after signing without breaking
 *      the signature.
 *   2. Trust-the-issuer: the predicate claim itself is only as true as the
 *      issuer's signature is trustworthy — exactly like deniedCount today.
 * A verifier that needs the predicate to be independently checkable from
 * the leaf contents (true ZK) should not treat this as sufficient; it is
 * sufficient for the same use cases count proofs already serve (a trusted
 * TFA-operated issuer attesting to data it has audited).
 *
 * ALGORITHM
 * ---------
 * 1. Caller blinds each action into a leaf the same way as count-proof:
 *      leafHash = SHA-256(salt || canonicalJson(action fields))
 * 2. buildPredicateProof() builds a Merkle tree over all leafHashes and
 *    selects `minCount` leaves as witnesses (first N, deterministic).
 * 3. The signed payload commits to: version · tenantId · identityId · root ·
 *    treeSize · threshold · allBelowThreshold · minCount · issuedAt.
 *    Tampering with any of these fields breaks the signature (fail-closed).
 *
 * DESIGN PROPERTIES
 * ------------------
 * • Zero external dependencies — node:crypto only (via merkle-tree.ts).
 * • Fail-closed: bad input → throw on build; malformed proof → false on verify.
 * • Deterministic: identical inputs → identical proof (same root, same witnesses).
 * • Tenant-scoped: tenantId is part of the signed payload.
 * • threshold is BigInt micro-cents (repo money convention) at the build
 *   boundary; carried as a decimal string in the wire proof (JSON has no
 *   bigint) and re-parsed with BigInt() on verify — never floats.
 */

import { canonicalJson } from "../common/canonical-json";
import {
  buildMerkleTree,
  verifyInclusionProof,
  type MerkleProof,
} from "../transparency-log/merkle-tree";
import type { Signer } from "../orchestrator/types";

// ─── Schema ────────────────────────────────────────────────────────────────────

export const PREDICATE_PROOF_VERSION = "tfa-predicate-proof-v1" as const;

/** One witness leaf: its position in the tree, its (blinded) hash, and its inclusion proof. */
export interface PredicateProofWitness {
  /** 0-based index of this leaf in the Merkle tree. */
  leafIndex: number;
  /** SHA-256 hex of the blinded action leaf (salt || content). */
  leafHash: string;
  /** Merkle inclusion proof from this leaf to the tree root. */
  merkleProof: MerkleProof;
}

/**
 * A portable selective-disclosure predicate proof.
 *
 * Proves (issuer-signed claim, see HONESTY NOTE above): "every one of the
 * treeSize committed actions has a value below `threshold`", evidenced by a
 * Merkle root with at least `minCount` verified witness inclusions. No
 * individual action value is ever revealed.
 */
export interface PredicateProof {
  /** Schema version — fail-closed on unknown versions. */
  version: typeof PREDICATE_PROOF_VERSION;
  tenantId: string;
  identityId: string;
  /** Merkle root of ALL action leaves (blinded). */
  root: string;
  /** Total number of action leaves in the tree. */
  treeSize: number;
  /** BigInt micro-cents threshold, as a decimal string (JSON has no bigint). */
  threshold: string;
  /**
   * The predicate claim: true means every one of the treeSize actions had a
   * value strictly below `threshold`. Part of the signed payload — the
   * claim cannot be altered post-signing without breaking verification.
   */
  allBelowThreshold: boolean;
  /**
   * The verifier checks at least minCount *distinct* witness inclusion
   * proofs pass — substantiates that the committed tree really has this
   * many leaves, the same way count-proof's minCount does.
   */
  minCount: number;
  /** Witness leaves (inclusion proofs). Length >= minCount. */
  witnesses: PredicateProofWitness[];
  /** ISO-8601 timestamp at which the proof was built. */
  issuedAt: string;
  /** Stable identifier for the signing key. */
  signerId: string;
  /** Algorithm label copied from the Signer. */
  algorithm: string;
  /** base64 signature over the canonical signing payload. */
  signature: string;
}

// ─── Canonical signing payload ─────────────────────────────────────────────────

/** The fields that are signed (everything except `signature` itself). */
export interface PredicateProofPayloadFields {
  version: typeof PREDICATE_PROOF_VERSION;
  tenantId: string;
  identityId: string;
  root: string;
  treeSize: number;
  threshold: string;
  allBelowThreshold: boolean;
  minCount: number;
  issuedAt: string;
  signerId: string;
}

/**
 * Deterministic canonical payload for signing/verification.
 * Uses canonicalJson (sorted keys) so builder and verifier produce identical bytes.
 */
export function predicateProofSigningPayload(fields: PredicateProofPayloadFields): string {
  return canonicalJson({
    version: fields.version,
    tenantId: fields.tenantId,
    identityId: fields.identityId,
    root: fields.root,
    treeSize: fields.treeSize,
    threshold: fields.threshold,
    allBelowThreshold: fields.allBelowThreshold,
    minCount: fields.minCount,
    issuedAt: fields.issuedAt,
    signerId: fields.signerId,
  });
}

// ─── Builder ───────────────────────────────────────────────────────────────────

export interface BuildPredicateProofInput {
  tenantId: string;
  identityId: string;
  /**
   * Pre-blinded leaf hashes (64-hex SHA-256), one per action.
   * Caller is responsible for blinding: e.g. SHA-256(salt || canonicalJson(action)).
   * Must have at least 1 leaf.
   */
  leafHashes: string[];
  /**
   * BigInt micro-cents threshold the predicate is proven against. Must be > 0n.
   */
  threshold: bigint;
  /**
   * The predicate claim being attested: true asserts every one of the
   * leafHashes' underlying actions had a value strictly below `threshold`.
   * The issuer computes this from the raw (unblinded) track record before
   * calling this builder — this module only ever sees blinded leaf hashes.
   */
  allBelowThreshold: boolean;
  /**
   * The witness-count lower-bound to substantiate: must be 1..leafHashes.length.
   */
  minCount: number;
  /** The signing key. */
  signer: Signer;
  /** Stable identifier for the signing key (e.g. key fingerprint). */
  signerId: string;
  /** Optional override for issuedAt (ISO-8601). Defaults to now. */
  issuedAt?: string;
}

/**
 * Build a deterministic selective-disclosure predicate proof.
 *
 * Fail-closed: throws PredicateProofError on any invalid input.
 * Deterministic: identical inputs → identical proof.
 */
export function buildPredicateProof(input: BuildPredicateProofInput): PredicateProof {
  const { tenantId, identityId, leafHashes, threshold, allBelowThreshold, minCount, signer, signerId } = input;

  if (!tenantId || typeof tenantId !== "string") {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: tenantId must be a non-empty string");
  }
  if (!identityId || typeof identityId !== "string") {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: identityId must be a non-empty string");
  }
  if (!Array.isArray(leafHashes) || leafHashes.length === 0) {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: leafHashes must be a non-empty array");
  }
  if (typeof threshold !== "bigint" || threshold <= 0n) {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: threshold must be a positive bigint (micro-cents)");
  }
  if (typeof allBelowThreshold !== "boolean") {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: allBelowThreshold must be a boolean");
  }
  if (!Number.isInteger(minCount) || minCount < 1 || minCount > leafHashes.length) {
    throw new PredicateProofError(
      "BAD_INPUT",
      `buildPredicateProof: minCount must be an integer 1..${leafHashes.length}, got ${minCount}`,
    );
  }
  if (!signer || typeof signer.sign !== "function") {
    throw new PredicateProofError("BAD_SIGNER", "buildPredicateProof: signer with sign() is required");
  }
  if (!signerId || typeof signerId !== "string") {
    throw new PredicateProofError("BAD_INPUT", "buildPredicateProof: signerId must be a non-empty string");
  }

  const { root, proofs } = buildMerkleTree(leafHashes);
  const treeSize = leafHashes.length;

  // Select the first minCount leaves as witnesses (deterministic).
  const witnesses: PredicateProofWitness[] = [];
  for (let i = 0; i < minCount; i++) {
    witnesses.push({
      leafIndex: i,
      leafHash: leafHashes[i],
      merkleProof: proofs[i],
    });
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const thresholdStr = threshold.toString();

  const payloadFields: PredicateProofPayloadFields = {
    version: PREDICATE_PROOF_VERSION,
    tenantId,
    identityId,
    root,
    treeSize,
    threshold: thresholdStr,
    allBelowThreshold,
    minCount,
    issuedAt,
    signerId,
  };
  const signature = signer.sign(predicateProofSigningPayload(payloadFields));

  return {
    version: PREDICATE_PROOF_VERSION,
    tenantId,
    identityId,
    root,
    treeSize,
    threshold: thresholdStr,
    allBelowThreshold,
    minCount,
    witnesses,
    issuedAt,
    signerId,
    algorithm: signer.algorithm,
    signature,
  };
}

// ─── Verifier ──────────────────────────────────────────────────────────────────

/**
 * Verify a PredicateProof offline.
 *
 * Checks:
 *   1. Structural integrity (version, types, arrays, threshold is a valid
 *      positive bigint string).
 *   2. Signature over the canonical payload (fail-closed: mismatch → false).
 *   3. Each witness has a valid Merkle inclusion proof against `root`.
 *   4. All witness leafIndex values are distinct (no duplicates).
 *   5. witnesses.length >= minCount (the count claim is substantiated).
 *
 * Returns false on any defect — never throws. Does NOT independently verify
 * `allBelowThreshold` from leaf contents (see HONESTY NOTE in module docstring) —
 * a true verification confirms the signed claim is intact and the committed
 * dataset's size is substantiated, not that the predicate is mathematically
 * derivable from the (blinded, undisclosed) leaf values.
 */
export function verifyPredicateProof(proof: unknown, signer: Signer): boolean {
  try {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
    const p = proof as Partial<PredicateProof>;

    if (p.version !== PREDICATE_PROOF_VERSION) return false;
    if (!p.tenantId || typeof p.tenantId !== "string") return false;
    if (!p.identityId || typeof p.identityId !== "string") return false;
    if (!p.root || typeof p.root !== "string") return false;
    if (!Number.isInteger(p.treeSize) || (p.treeSize as number) < 1) return false;
    if (!Number.isInteger(p.minCount) || (p.minCount as number) < 1) return false;
    if (typeof p.allBelowThreshold !== "boolean") return false;
    if (!p.issuedAt || typeof p.issuedAt !== "string") return false;
    if (!p.signerId || typeof p.signerId !== "string") return false;
    if (!p.signature || typeof p.signature !== "string") return false;
    if (!Array.isArray(p.witnesses)) return false;

    // threshold must be a decimal string parseable as a positive bigint —
    // fail-closed on malformed/negative/non-numeric values (never throws past here).
    if (typeof p.threshold !== "string" || !/^[0-9]+$/.test(p.threshold)) return false;
    let thresholdBig: bigint;
    try {
      thresholdBig = BigInt(p.threshold);
    } catch {
      return false;
    }
    if (thresholdBig <= 0n) return false;

    if (!signer || typeof signer.verify !== "function") return false;

    // 2. Verify signature — recompute canonical payload.
    const payload = predicateProofSigningPayload({
      version: PREDICATE_PROOF_VERSION,
      tenantId: p.tenantId,
      identityId: p.identityId,
      root: p.root,
      treeSize: p.treeSize as number,
      threshold: p.threshold,
      allBelowThreshold: p.allBelowThreshold,
      minCount: p.minCount as number,
      issuedAt: p.issuedAt,
      signerId: p.signerId,
    });
    if (!signer.verify(payload, p.signature)) return false;

    // 3. Each witness has a valid Merkle inclusion proof.
    for (const w of p.witnesses) {
      if (!w || typeof w !== "object") return false;
      if (!Number.isInteger(w.leafIndex) || w.leafIndex < 0) return false;
      if (!w.leafHash || typeof w.leafHash !== "string") return false;
      if (!w.merkleProof || typeof w.merkleProof !== "object") return false;
      if (!verifyInclusionProof(w.leafHash, p.root, w.merkleProof)) return false;
    }

    // 4. All leafIndex values must be distinct.
    const seen = new Set<number>();
    for (const w of p.witnesses) {
      if (seen.has(w.leafIndex)) return false;
      seen.add(w.leafIndex);
    }

    // 5. Witness count substantiates the minCount claim.
    if (p.witnesses.length < (p.minCount as number)) return false;

    return true;
  } catch {
    return false;
  }
}

// ─── Error class ───────────────────────────────────────────────────────────────

export type PredicateProofErrorCode = "BAD_INPUT" | "BAD_SIGNER";

export class PredicateProofError extends Error {
  readonly code: PredicateProofErrorCode;
  constructor(code: PredicateProofErrorCode, message: string) {
    super(message);
    this.name = "PredicateProofError";
    this.code = code;
  }
}
