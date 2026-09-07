/**
 * lib/transparency-log/consistency-proof.ts — append-only consistency proofs.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The transparency log already produces INCLUSION proofs ("receipt X is in the
 * tree with root R"). But inclusion alone does not stop a malicious or
 * compromised operator from a SPLIT-VIEW attack: forking the log and showing
 * party A one history and party B a different one. The defence — used by
 * Certificate Transparency (RFC 6962) and Sigstore's Rekor — is a CONSISTENCY
 * proof: given an older signed tree head (root R_m over m leaves) and a newer
 * one (root R_n over n leaves, n >= m), prove that the first m leaves are an
 * unchanged PREFIX of the n-leaf tree. If every monitor checks consistency
 * between the roots it sees over time, the operator cannot rewrite or reorder
 * history without producing a root that fails to reconcile — making tampering
 * detectable by anyone, not just the operator.
 *
 * MATCHING THIS TREE
 * ------------------
 * This proof reconstructs roots using the SAME convention as merkle-tree.ts:
 *   • hashPair(left,right) = SHA-256(left_bytes || right_bytes)
 *   • odd node: the last node is PROMOTED upward (paired with itself),
 *     i.e. right = current[i+1] ?? left.
 * Because that convention is shared, an oldRoot/newRoot recomputed here equals
 * the roots the log actually published — so a verifier can compare against the
 * AnchoredRoot.root values it already holds.
 *
 * DESIGN
 * ------
 * • PURE: no I/O, no state. node:crypto only. Zero external dependencies.
 * • SELF-VERIFYING: the proof carries the node hashes needed to RECOMPUTE both
 *   roots; the verifier trusts nothing the prover claims, it recomputes.
 * • FAIL-CLOSED: m < 1, m > n, malformed hashes, or any mismatch → not consistent.
 */

import { createHash } from "node:crypto";

const HEX64_RE = /^[a-f0-9]{64}$/i;

/** Hash two hex-encoded 32-byte values: SHA-256(left||right). Matches merkle-tree.ts. */
function hashPair(left: string, right: string): string {
  return createHash("sha256")
    .update(Buffer.from(left, "hex"))
    .update(Buffer.from(right, "hex"))
    .digest("hex");
}

/**
 * Compute the root of a tree over `leaves`, using the promote-last-odd
 * convention. Identical result to merkle-tree.ts buildMerkleTree().root.
 */
export function computeRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    throw new ConsistencyProofError("EMPTY", "cannot compute root of zero leaves");
  }
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left; // promote last odd node
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

/**
 * A consistency proof between an m-leaf tree and an n-leaf tree (m <= n).
 *
 * The proof is the set of LEAF hashes of the newer tree plus the old size.
 * Carrying leaves keeps the proof self-verifying and convention-exact: the
 * verifier recomputes oldRoot from the first m leaves and newRoot from all n,
 * and checks both against the roots it independently holds. (Leaf hashes are
 * already public commitments — they reveal nothing beyond what an inclusion
 * proof already exposes — and a tenant log's n is bounded by its own activity.)
 *
 * A future optimisation can replace `leaves` with the minimal RFC-6962-style
 * node set; the verifier API is intentionally stable so that swap stays additive.
 */
export interface ConsistencyProof {
  /** Size of the older tree (number of leaves committed by the old root). */
  oldSize: number;
  /** Size of the newer tree. */
  newSize: number;
  /** Leaf hashes of the newer tree, index 0..newSize-1 (64-hex each). */
  leaves: string[];
}

/**
 * Build a consistency proof that the first `oldSize` leaves are a prefix of the
 * full `leaves` set.
 *
 * @param leaves   all leaf hashes of the CURRENT (newer) tree, in order.
 * @param oldSize  the leaf count committed by the OLDER root (1 <= oldSize <= leaves.length).
 */
export function buildConsistencyProof(leaves: string[], oldSize: number): ConsistencyProof {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new ConsistencyProofError("EMPTY", "leaves must be a non-empty array");
  }
  if (!Number.isInteger(oldSize) || oldSize < 1 || oldSize > leaves.length) {
    throw new ConsistencyProofError(
      "BAD_SIZE",
      `oldSize must be an integer in [1, ${leaves.length}]; got ${String(oldSize)}`,
    );
  }
  for (const leaf of leaves) {
    if (!HEX64_RE.test(leaf)) {
      throw new ConsistencyProofError("INVALID_LEAF", `leaf must be 64-hex SHA-256: got ${String(leaf)}`);
    }
  }
  return { oldSize, newSize: leaves.length, leaves: leaves.slice() };
}

/**
 * Verify a consistency proof against an old root and a new root that the caller
 * already holds (e.g. two AnchoredRoot.root values seen at different times).
 *
 * Returns true ONLY IF, recomputing from the proof's leaves:
 *   • the first oldSize leaves reproduce `oldRoot`, AND
 *   • all newSize leaves reproduce `newRoot`, AND
 *   • oldSize <= newSize and sizes/format are well-formed.
 * Any deviation (history rewritten, reordered, truncated, forked) → false.
 *
 * Fail-closed: malformed input returns false, never throws.
 */
export function verifyConsistencyProof(
  proof: ConsistencyProof,
  oldRoot: string,
  newRoot: string,
): boolean {
  if (!proof || typeof proof !== "object") return false;
  if (!HEX64_RE.test(oldRoot) || !HEX64_RE.test(newRoot)) return false;
  const { oldSize, newSize, leaves } = proof;
  if (!Number.isInteger(oldSize) || !Number.isInteger(newSize)) return false;
  if (oldSize < 1 || newSize < 1 || oldSize > newSize) return false;
  if (!Array.isArray(leaves) || leaves.length !== newSize) return false;
  for (const leaf of leaves) {
    if (typeof leaf !== "string" || !HEX64_RE.test(leaf)) return false;
  }

  let recomputedOld: string;
  let recomputedNew: string;
  try {
    recomputedOld = computeRoot(leaves.slice(0, oldSize));
    recomputedNew = computeRoot(leaves);
  } catch {
    return false;
  }

  return recomputedOld === oldRoot && recomputedNew === newRoot;
}

export type ConsistencyProofErrorCode = "EMPTY" | "BAD_SIZE" | "INVALID_LEAF";

export class ConsistencyProofError extends Error {
  readonly code: ConsistencyProofErrorCode;
  constructor(code: ConsistencyProofErrorCode, message: string) {
    super(message);
    this.name = "ConsistencyProofError";
    this.code = code;
  }
}
