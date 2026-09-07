/**
 * lib/transparency-log/mesh-membership.ts — trust-mesh membership proofs.
 *
 * WHY (TRUST_INTEGRITY_ROADMAP §2.A, sub-step 3)
 * ----------------------------------------------
 * Federation anchors (federation-anchor.ts) link one log's root to another's;
 * cross-log-consistency.ts verifies a pair. The missing piece is letting a
 * tenant prove "I am a member of trust-mesh M" to a counterparty WITHOUT
 * revealing who the other members are. That privacy property is exactly what a
 * cross-org trust network needs and what a single vendor cannot neutrally offer.
 *
 * MECHANISM
 * ---------
 * A mesh is committed as a Merkle tree over its members' trust-anchor leaves
 * (one leaf per member = SHA-256 over the member's canonical identity). The
 * tree's root is the public MESH ROOT — a stable commitment to the membership
 * set. A member proves belonging by presenting a Merkle INCLUSION proof of its
 * own leaf against the mesh root. The sibling hashes in that proof are opaque,
 * so the verifier learns only "this member is in the set", never the rest of
 * the set. The verifier RECOMPUTES the member's leaf from the claimed identity
 * and checks the inclusion proof — zero trust in the prover.
 *
 * DESIGN
 * ------
 * • Built on the canonical merkle-tree.ts (same hashing/promote-last-odd), so a
 *   mesh root computed here is verifiable by the existing inclusion verifier.
 * • Deterministic, canonical leaf derivation (version-tagged) so the same member
 *   always maps to the same leaf across processes.
 * • Members are sorted by identity before tree construction, so the mesh root is
 *   independent of insertion order (a set commitment, not a list commitment).
 * • FAIL-CLOSED: unknown member, tampered proof, wrong root, malformed input →
 *   false (verify) or throw (build). Zero external dependencies.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical-json";
import {
  buildMerkleTree,
  verifyInclusionProof,
  type MerkleProof,
} from "./merkle-tree";

const HEX64_RE = /^[a-f0-9]{64}$/i;

/** Leaf-derivation schema version. Bump only on a breaking change. */
export const MESH_MEMBER_LEAF_VERSION = "tfa-mesh-member-v1" as const;

/** A member of a trust mesh — its stable, canonical identity. */
export interface MeshMember {
  /** Stable log identifier, e.g. "org.acme/audit". */
  logId: string;
  /**
   * Identity anchor the member is bound to (e.g. did:web / SPIFFE / FQDN).
   * Part of the leaf so a logId cannot be impersonated under a different identity.
   */
  identity: string;
}

/** A membership proof: an inclusion proof of one member against the mesh root. */
export interface MeshMembershipProof {
  /** Schema tag for the leaf derivation used. */
  version: typeof MESH_MEMBER_LEAF_VERSION;
  /** The mesh root this proof is against (64-hex). */
  meshRoot: string;
  /** Total number of members committed by the mesh root. */
  meshSize: number;
  /** The member being proven (verifier recomputes its leaf — not trusted as-is). */
  member: MeshMember;
  /** Inclusion proof of the member's leaf against meshRoot. */
  inclusion: MerkleProof;
}

/** Canonical, deterministic leaf hash for a mesh member. */
export function meshMemberLeaf(member: MeshMember): string {
  const payload = canonicalJson({
    version: MESH_MEMBER_LEAF_VERSION,
    logId: member.logId,
    identity: member.identity,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function isValidMember(m: unknown): m is MeshMember {
  return (
    !!m &&
    typeof (m as MeshMember).logId === "string" && (m as MeshMember).logId.length > 0 &&
    typeof (m as MeshMember).identity === "string" && (m as MeshMember).identity.length > 0
  );
}

/** Sort members deterministically so the mesh root is order-independent (a set commitment). */
function sortMembers(members: MeshMember[]): MeshMember[] {
  return [...members].sort((a, b) =>
    a.logId === b.logId
      ? (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
      : (a.logId < b.logId ? -1 : 1),
  );
}

/** The mesh root: a set commitment to the membership. Order-independent. */
export function computeMeshRoot(members: MeshMember[]): string {
  if (!Array.isArray(members) || members.length === 0) {
    throw new MeshMembershipError("EMPTY", "computeMeshRoot: members must be a non-empty array");
  }
  for (const m of members) {
    if (!isValidMember(m)) {
      throw new MeshMembershipError("BAD_MEMBER", "computeMeshRoot: each member needs logId and identity");
    }
  }
  const leaves = sortMembers(members).map(meshMemberLeaf);
  return buildMerkleTree(leaves).root;
}

/**
 * Build a membership proof for `target` within `members`.
 * Fail-closed: target not in the set, or invalid input, throws.
 */
export function buildMeshMembershipProof(
  members: MeshMember[],
  target: MeshMember,
): MeshMembershipProof {
  if (!isValidMember(target)) {
    throw new MeshMembershipError("BAD_MEMBER", "buildMeshMembershipProof: invalid target member");
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new MeshMembershipError("EMPTY", "buildMeshMembershipProof: members must be a non-empty array");
  }
  for (const m of members) {
    if (!isValidMember(m)) {
      throw new MeshMembershipError("BAD_MEMBER", "buildMeshMembershipProof: each member needs logId and identity");
    }
  }

  const sorted = sortMembers(members);
  const leaves = sorted.map(meshMemberLeaf);
  const targetLeaf = meshMemberLeaf(target);
  const index = leaves.indexOf(targetLeaf);
  if (index === -1) {
    throw new MeshMembershipError("NOT_A_MEMBER", "buildMeshMembershipProof: target is not in the mesh");
  }

  const { root, proofs } = buildMerkleTree(leaves);
  return {
    version: MESH_MEMBER_LEAF_VERSION,
    meshRoot: root,
    meshSize: leaves.length,
    member: { logId: target.logId, identity: target.identity },
    inclusion: proofs[index],
  };
}

/**
 * Verify a membership proof against a KNOWN mesh root the caller already trusts
 * (e.g. a published mesh root). The verifier RECOMPUTES the member's leaf from
 * the claimed identity and checks the inclusion proof — it does not trust any
 * leaf value supplied by the prover.
 *
 * Returns true ONLY IF: version matches, roots match, the recomputed leaf is
 * included under expectedMeshRoot. Fail-closed: any defect → false, no throw.
 */
export function verifyMeshMembershipProof(
  proof: MeshMembershipProof,
  expectedMeshRoot: string,
): boolean {
  if (!proof || typeof proof !== "object") return false;
  if (proof.version !== MESH_MEMBER_LEAF_VERSION) return false;
  if (!HEX64_RE.test(expectedMeshRoot)) return false;
  if (!HEX64_RE.test(proof.meshRoot)) return false;
  // The proof must be about the root the caller trusts.
  if (proof.meshRoot !== expectedMeshRoot) return false;
  if (!Number.isInteger(proof.meshSize) || proof.meshSize < 1) return false;
  if (!isValidMember(proof.member)) return false;
  if (!proof.inclusion || !Array.isArray(proof.inclusion.siblings)) return false;

  // Recompute the leaf — never trust a prover-supplied leaf.
  const leaf = meshMemberLeaf(proof.member);
  try {
    return verifyInclusionProof(leaf, expectedMeshRoot, proof.inclusion);
  } catch {
    return false;
  }
}

export type MeshMembershipErrorCode = "EMPTY" | "BAD_MEMBER" | "NOT_A_MEMBER";

export class MeshMembershipError extends Error {
  readonly code: MeshMembershipErrorCode;
  constructor(code: MeshMembershipErrorCode, message: string) {
    super(message);
    this.name = "MeshMembershipError";
    this.code = code;
  }
}
