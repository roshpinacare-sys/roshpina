/**
 * lib/transparency-log/merkle-tree.ts — Cryptographic Merkle tree for receipt anchoring.
 *
 * PURPOSE
 * -------
 * A Merkle tree lets TFA publish a single, small root hash that commits to an
 * arbitrary number of receipts. Anyone with a receipt can request an inclusion
 * proof and verify that the receipt was anchored in a tree with that root,
 * without trusting TFA's servers after the fact.
 *
 * This is "verify-after-revocation": even if TFA later deletes the receipt
 * from its hot store, the published root + inclusion proof still attest that
 * the receipt was accepted by the kernel at a specific time.
 *
 * ALGORITHM
 * ---------
 *   • Leaves: SHA-256(receipt-canonical-json) — one per receipt.
 *   • Internal nodes: SHA-256(left || right) — binary, sorted by index.
 *   • Odd nodes: the last leaf is promoted upward (copied) until it meets a pair.
 *   • Inclusion proof: the list of sibling hashes from leaf to root,
 *     plus direction bits (0 = sibling is left, 1 = sibling is right).
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash } from "node:crypto";

/**
 * Pre-compiled regex for a 64-hex SHA-256 hash string.
 * Hoisted to module scope so it is compiled once, not on every validation call.
 * Used in buildMerkleTree (per-leaf), verifyInclusionProof (leaf + root + per-sibling).
 * Efficiency: eliminates O(n) regex constructions per proof-verification call,
 * where n = proof depth (log₂ leaves), and one construction per leaf on build.
 */
const HEX64_RE = /^[a-f0-9]{64}$/i;

/** A Merkle inclusion proof: sibling hashes + direction bits. */
export interface MerkleProof {
  /** The sibling hash at each level, from leaf up to root-1. */
  siblings: string[];
  /**
   * Bit mask: 0 means the sibling is on the LEFT of the current hash,
   * 1 means the sibling is on the RIGHT. One bit per level.
   */
  directionBits: number;
}

/** Result of building a tree: root + per-leaf proofs. */
export interface MerkleTreeResult {
  root: string;
  proofs: MerkleProof[];
}

/**
 * Build a Merkle tree from leaf hashes and compute inclusion proofs for every leaf.
 *
 * @param leaves — hex-encoded SHA-256 leaf hashes (32 bytes each = 64 hex chars).
 *                 Must be non-empty. Duplicates are allowed (they produce distinct
 *                 leaf hashes at different indices).
 * @returns root hash + one proof per leaf.
 */
export function buildMerkleTree(leaves: string[]): MerkleTreeResult {
  if (leaves.length === 0) {
    throw new MerkleTreeError("EMPTY_TREE", "Cannot build Merkle tree from zero leaves");
  }

  // Validate leaf format (uses module-level HEX64_RE — compiled once)
  for (const leaf of leaves) {
    if (!HEX64_RE.test(leaf)) {
      throw new MerkleTreeError("INVALID_LEAF", `Leaf must be 64-hex SHA-256: got ${leaf}`);
    }
  }

  // ── Bottom-up tree construction ─────────────────────────────────────────────
  // levels[i] = array of hashes at height i (0 = leaves)
  const levels: string[][] = [leaves.slice()];

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? left; // odd count: promote last leaf
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }

  const root = levels[levels.length - 1][0];

  // ── Inclusion proofs ────────────────────────────────────────────────────────
  const proofs: MerkleProof[] = [];
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const siblings: string[] = [];
    let directionBits = 0;
    let idx = leafIdx;

    for (let h = 0; h < levels.length - 1; h++) {
      const level = levels[h];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      // If sibling is beyond the level, it means the current node was promoted
      // (odd count). The sibling is the same hash.
      const siblingHash = siblingIdx < level.length ? level[siblingIdx] : level[idx];
      siblings.push(siblingHash);

      if (isRight) {
        directionBits |= (1 << h);
      }
      idx = Math.floor(idx / 2);
    }

    proofs.push({ siblings, directionBits });
  }

  return { root, proofs };
}

/**
 * Verify that `leaf` is included in a Merkle tree whose root is `root`,
 * using the provided `proof`.
 *
 * @returns true if the proof reconstructs the root; false otherwise.
 */
export function verifyInclusionProof(
  leaf: string,
  root: string,
  proof: MerkleProof,
): boolean {
  if (!HEX64_RE.test(leaf) || !HEX64_RE.test(root)) return false;
  if (!proof || !Array.isArray(proof.siblings)) return false;

  let current = leaf;
  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    if (!HEX64_RE.test(sibling)) return false;

    const isRight = (proof.directionBits & (1 << i)) !== 0;
    current = isRight ? hashPair(sibling, current) : hashPair(current, sibling);
  }

  return current === root;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Hash two hex-encoded 32-byte values together.
 * Uses two `.update()` calls instead of string concatenation to avoid
 * allocating a 128-char intermediate string on every internal node.
 */
function hashPair(left: string, right: string): string {
  return createHash("sha256")
    .update(Buffer.from(left, "hex"))
    .update(Buffer.from(right, "hex"))
    .digest("hex");
}

export type MerkleTreeErrorCode = "EMPTY_TREE" | "INVALID_LEAF";

export class MerkleTreeError extends Error {
  readonly code: MerkleTreeErrorCode;
  constructor(code: MerkleTreeErrorCode, message: string) {
    super(message);
    this.name = "MerkleTreeError";
    this.code = code;
  }
}
