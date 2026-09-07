/**
 * lib/transparency-log/index.ts — barrel export for the Transparency Log (Merkle anchoring).
 *
 * Public surface:
 *   • MerkleTree — buildMerkleTree, verifyInclusionProof
 *   • ReceiptAnchor — anchorReceipt, anchorAuditRecord
 *   • TransparencyLog — InMemoryTransparencyLog, PgTransparencyLogStore
 *   • All types + errors
 */

export {
  buildMerkleTree,
  verifyInclusionProof,
  MerkleTreeError,
} from "./merkle-tree";

export type { MerkleProof, MerkleTreeResult } from "./merkle-tree";
export type { MerkleTreeErrorCode } from "./merkle-tree";

export {
  anchorReceipt,
  anchorAuditRecord,
  InMemoryTransparencyLog,
  TransparencyLogError,
} from "./receipt-anchor";

export type {
  AnchoredRoot,
  ProofResult,
  TransparencyLog,
  TransparencyLogErrorCode,
} from "./types";


export {
  computeRoot,
  buildConsistencyProof,
  verifyConsistencyProof,
  ConsistencyProofError,
} from "./consistency-proof";

export type { ConsistencyProof, ConsistencyProofErrorCode } from "./consistency-proof";

export { runConsistencyMonitor } from "./consistency-monitor";
export type { MonitorResult, ConsistencyCheckable } from "./consistency-monitor";

export {
  buildFederationAnchor,
  verifyFederationAnchor,
  federationAnchorSigningPayload,
  FEDERATION_ANCHOR_VERSION,
  FederationAnchorError,
} from "./federation-anchor";

export type {
  FederationAnchor,
  FederationAnchorPayload,
  FederationAnchorErrorCode,
  LogEndpoint,
} from "./federation-anchor";

export {
  verifyCrossLogConsistency,
  CrossLogConsistencyError,
} from "./cross-log-consistency";

export type {
  CrossLogConsistencyResult,
  CrossLogConsistencyErrorCode,
} from "./cross-log-consistency";

export {
  computeMeshRoot,
  buildMeshMembershipProof,
  verifyMeshMembershipProof,
  meshMemberLeaf,
  MESH_MEMBER_LEAF_VERSION,
  MeshMembershipError,
} from "./mesh-membership";

export type {
  MeshMember,
  MeshMembershipProof,
  MeshMembershipErrorCode,
} from "./mesh-membership";
