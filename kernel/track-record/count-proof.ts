/**
 * lib/track-record/count-proof.ts — Selective disclosure: count proof.
 *
 * WHY THIS EXISTS
 * ---------------
 * A track record contains raw action history — settled escrows, denied
 * attempts. To share a proof of quality with a counterparty, an agent should
 * not have to reveal *which* specific actions occurred (commercial sensitivity,
 * privacy). The count proof lets a prover state:
 *
 *   "I have ≥N actions on record, and 0 of them were denied."
 *
 * without revealing the content of any action.  The counterparty can verify
 * this claim offline using only the proof and the prover's public key.
 *
 * THIS MODULE (sub-step first of §2.B in TRUST_INTEGRITY_ROADMAP.md)
 * ------------------------------------------------------------------
 *   • CountProof — the canonical portable proof type.
 *   • buildCountProof() — build a deterministic count proof from blinded leaves.
 *   • verifyCountProof() — recompute and verify; fail-closed.
 *
 * ALGORITHM
 * ---------
 * 1. Caller hashes each action into a leaf:
 *      leafHash = SHA-256(salt || canonicalJson(action fields))
 *    The salt keeps the hash opaque to anyone who does not know the action.
 * 2. buildCountProof() builds a Merkle tree from all leafHashes and selects
 *    `minCount` leaves as witnesses (first N leaves, deterministic).
 * 3. The signed payload commits to: version · tenantId · identityId ·
 *    root · treeSize · minCount · deniedCount · issuedAt.
 *    Tampering with any of these fields breaks the signature (fail-closed).
 * 4. The proof carries one Merkle inclusion proof per witness leaf.
 *
 * DESIGN PROPERTIES
 * -----------------
 * • Zero external dependencies — node:crypto only.
 * • Fail-closed: bad input → throw on build; malformed proof → false on verify.
 * • Deterministic: identical inputs → identical proof (same root, same witnesses).
 * • Tenant-scoped: tenantId is part of the signed payload; cross-tenant
 *   substitution attacks are rejected by signature mismatch.
 * • Verifier recomputes everything — trusts nothing in the proof beyond the
 *   signature.
 */

import { canonicalJson } from "../common/canonical-json";
import {
  buildMerkleTree,
  verifyInclusionProof,
  type MerkleProof,
} from "../transparency-log/merkle-tree";
import type { Signer } from "../orchestrator/types";

// ─── Schema ────────────────────────────────────────────────────────────────────

export const COUNT_PROOF_VERSION = "tfa-count-proof-v1" as const;

/** One witness leaf: its position in the tree, its (blinded) hash, and its inclusion proof. */
export interface CountProofWitness {
  /** 0-based index of this leaf in the Merkle tree. */
  leafIndex: number;
  /** SHA-256 hex of the blinded action leaf (salt || content). */
  leafHash: string;
  /** Merkle inclusion proof from this leaf to the tree root. */
  merkleProof: MerkleProof;
}

/**
 * A portable selective-disclosure count proof.
 *
 * Proves: "the agent has ≥minCount actions in a Merkle tree whose root is
 * `root`, and exactly `deniedCount` of the tree's treeSize actions were denied."
 *
 * The verifier checks the signature, then checks each witness's inclusion proof
 * against `root`.  The contents of the actions are never revealed.
 */
export interface CountProof {
  /** Schema version — fail-closed on unknown versions. */
  version: typeof COUNT_PROOF_VERSION;
  tenantId: string;
  identityId: string;
  /** Merkle root of ALL action leaves (blinded). */
  root: string;
  /** Total number of action leaves in the tree. */
  treeSize: number;
  /**
   * The count lower-bound being proved: treeSize >= minCount.
   * The verifier checks that at least minCount *distinct* witness inclusion
   * proofs pass — this proves the tree contains at least minCount leaves.
   */
  minCount: number;
  /**
   * Number of denied actions among the treeSize leaves.
   * Part of the signed payload so the claim cannot be altered post-signing.
   * A verifier asserting "0 denials" should check deniedCount === 0 after
   * verifyCountProof() returns true.
   */
  deniedCount: number;
  /** Witness leaves (inclusion proofs). Length >= minCount. */
  witnesses: CountProofWitness[];
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
export interface CountProofPayloadFields {
  version: typeof COUNT_PROOF_VERSION;
  tenantId: string;
  identityId: string;
  root: string;
  treeSize: number;
  minCount: number;
  deniedCount: number;
  issuedAt: string;
  signerId: string;
}

/**
 * Deterministic canonical payload for signing/verification.
 * Uses canonicalJson (sorted keys) so builder and verifier produce identical bytes.
 */
export function countProofSigningPayload(fields: CountProofPayloadFields): string {
  return canonicalJson({
    version: fields.version,
    tenantId: fields.tenantId,
    identityId: fields.identityId,
    root: fields.root,
    treeSize: fields.treeSize,
    minCount: fields.minCount,
    deniedCount: fields.deniedCount,
    issuedAt: fields.issuedAt,
    signerId: fields.signerId,
  });
}

// ─── Builder ───────────────────────────────────────────────────────────────────

export interface BuildCountProofInput {
  tenantId: string;
  identityId: string;
  /**
   * Pre-blinded leaf hashes (64-hex SHA-256), one per action.
   * Caller is responsible for blinding: e.g. SHA-256(salt || canonicalJson(action)).
   * Must have at least 1 leaf.
   */
  leafHashes: string[];
  /**
   * Number of the leafHashes that represent denied actions.
   * Must be 0..leafHashes.length.  Part of the signed claim.
   */
  deniedCount: number;
  /**
   * The count lower-bound to prove: treeSize >= minCount.
   * Must be 1..leafHashes.length.
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
 * Build a deterministic selective-disclosure count proof.
 *
 * Fail-closed: throws CountProofError on any invalid input.
 * Deterministic: identical inputs → identical proof.
 */
export function buildCountProof(input: BuildCountProofInput): CountProof {
  const { tenantId, identityId, leafHashes, deniedCount, minCount, signer, signerId } = input;

  if (!tenantId || typeof tenantId !== "string") {
    throw new CountProofError("BAD_INPUT", "buildCountProof: tenantId must be a non-empty string");
  }
  if (!identityId || typeof identityId !== "string") {
    throw new CountProofError("BAD_INPUT", "buildCountProof: identityId must be a non-empty string");
  }
  if (!Array.isArray(leafHashes) || leafHashes.length === 0) {
    throw new CountProofError("BAD_INPUT", "buildCountProof: leafHashes must be a non-empty array");
  }
  if (!Number.isInteger(deniedCount) || deniedCount < 0 || deniedCount > leafHashes.length) {
    throw new CountProofError(
      "BAD_INPUT",
      `buildCountProof: deniedCount must be an integer 0..${leafHashes.length}, got ${deniedCount}`,
    );
  }
  if (!Number.isInteger(minCount) || minCount < 1 || minCount > leafHashes.length) {
    throw new CountProofError(
      "BAD_INPUT",
      `buildCountProof: minCount must be an integer 1..${leafHashes.length}, got ${minCount}`,
    );
  }
  if (!signer || typeof signer.sign !== "function") {
    throw new CountProofError("BAD_SIGNER", "buildCountProof: signer with sign() is required");
  }
  if (!signerId || typeof signerId !== "string") {
    throw new CountProofError("BAD_INPUT", "buildCountProof: signerId must be a non-empty string");
  }

  const { root, proofs } = buildMerkleTree(leafHashes);
  const treeSize = leafHashes.length;

  // Select the first minCount leaves as witnesses (deterministic).
  const witnesses: CountProofWitness[] = [];
  for (let i = 0; i < minCount; i++) {
    witnesses.push({
      leafIndex: i,
      leafHash: leafHashes[i],
      merkleProof: proofs[i],
    });
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();

  const payloadFields: CountProofPayloadFields = {
    version: COUNT_PROOF_VERSION,
    tenantId,
    identityId,
    root,
    treeSize,
    minCount,
    deniedCount,
    issuedAt,
    signerId,
  };
  const signature = signer.sign(countProofSigningPayload(payloadFields));

  return {
    version: COUNT_PROOF_VERSION,
    tenantId,
    identityId,
    root,
    treeSize,
    minCount,
    deniedCount,
    witnesses,
    issuedAt,
    signerId,
    algorithm: signer.algorithm,
    signature,
  };
}

// ─── Verifier ──────────────────────────────────────────────────────────────────

/**
 * Verify a CountProof offline.
 *
 * Checks:
 *   1. Structural integrity (version, types, arrays).
 *   2. Signature over the canonical payload (fail-closed: mismatch → false).
 *   3. Each witness has a valid Merkle inclusion proof against `root`.
 *   4. All witness leafIndex values are distinct (no duplicates).
 *   5. witnesses.length >= minCount (the count claim is substantiated).
 *
 * Returns false on any defect — never throws.
 */
export function verifyCountProof(proof: unknown, signer: Signer): boolean {
  try {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
    const p = proof as Partial<CountProof>;

    if (p.version !== COUNT_PROOF_VERSION) return false;
    if (!p.tenantId || typeof p.tenantId !== "string") return false;
    if (!p.identityId || typeof p.identityId !== "string") return false;
    if (!p.root || typeof p.root !== "string") return false;
    if (!Number.isInteger(p.treeSize) || (p.treeSize as number) < 1) return false;
    if (!Number.isInteger(p.minCount) || (p.minCount as number) < 1) return false;
    if (!Number.isInteger(p.deniedCount) || (p.deniedCount as number) < 0) return false;
    if (!p.issuedAt || typeof p.issuedAt !== "string") return false;
    if (!p.signerId || typeof p.signerId !== "string") return false;
    if (!p.signature || typeof p.signature !== "string") return false;
    if (!Array.isArray(p.witnesses)) return false;

    if (!signer || typeof signer.verify !== "function") return false;

    // 2. Verify signature — recompute canonical payload.
    const payload = countProofSigningPayload({
      version: COUNT_PROOF_VERSION,
      tenantId: p.tenantId,
      identityId: p.identityId,
      root: p.root,
      treeSize: p.treeSize as number,
      minCount: p.minCount as number,
      deniedCount: p.deniedCount as number,
      issuedAt: p.issuedAt,
      signerId: p.signerId,
    });
    if (!signer.verify(payload, p.signature)) return false;

    // 3+4. Single pass: each witness has a valid Merkle inclusion proof AND
    // all leafIndex values are distinct. Previously two separate O(n) loops
    // over p.witnesses (one for inclusion proofs, one for the Set-based
    // duplicate check); now one loop does both checks per witness.
    const seen = new Set<number>();
    for (const w of p.witnesses) {
      if (!w || typeof w !== "object") return false;
      if (!Number.isInteger(w.leafIndex) || w.leafIndex < 0) return false;
      if (!w.leafHash || typeof w.leafHash !== "string") return false;
      if (!w.merkleProof || typeof w.merkleProof !== "object") return false;
      if (!verifyInclusionProof(w.leafHash, p.root, w.merkleProof)) return false;
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

export type CountProofErrorCode = "BAD_INPUT" | "BAD_SIGNER";

export class CountProofError extends Error {
  readonly code: CountProofErrorCode;
  constructor(code: CountProofErrorCode, message: string) {
    super(message);
    this.name = "CountProofError";
    this.code = code;
  }
}
