/**
 * lib/transparency-log/types.ts — TransparencyLog interface.
 *
 * Abstracts over InMemoryTransparencyLog and PgTransparencyLogStore
 * so the rest of the system is storage-agnostic.
 */

import type { ExecutionReceipt } from "../adapter/agent-adapter";
import type { AuditRecord } from "../orchestrator/types";
import type { MerkleProof } from "./merkle-tree";
import type { ConsistencyProof } from "./consistency-proof";

export interface AnchoredRoot {
  root: string;
  leafCount: number;
  anchoredAt: string;
}

export interface ProofResult {
  proof: MerkleProof;
  root: AnchoredRoot;
  leafIndex: number;
}

export interface TransparencyLog {
  /** Append a receipt leaf. Returns the leaf index. Optionally tags it with receiptId for later lookup. */
  appendReceipt(tenantId: string, receipt: ExecutionReceipt, receiptId?: string): Promise<number>;

  /** Append an audit-record leaf. Returns the leaf index. */
  appendAuditRecord(tenantId: string, record: AuditRecord): Promise<number>;

  /** Force a tree rebuild. Returns the new root or null if no leaves. */
  finalize(tenantId: string): Promise<AnchoredRoot | null>;

  /** The latest root for a tenant, or null. */
  currentRoot(tenantId: string): Promise<AnchoredRoot | null>;

  /** All roots ever published for a tenant. */
  getRoots(tenantId: string): Promise<AnchoredRoot[]>;

  /** Total leaf count for a tenant. */
  leafCount(tenantId: string): Promise<number>;

  /** Inclusion proof for a leaf by index. */
  getProof(tenantId: string, leafIndex: number): Promise<MerkleProof | null>;

  /** Inclusion proof for a leaf tagged with receiptId. */
  getProofByReceiptId(tenantId: string, receiptId: string): Promise<ProofResult | null>;

  /** Verify a receipt against the current root. */
  verifyReceipt(tenantId: string, receipt: ExecutionReceipt): Promise<boolean>;

  /**
   * Consistency proof that the first `oldSize` leaves are a prefix of the
   * current tree (split-view defence). Returns null if the tenant has no
   * leaves or oldSize is out of [1, currentLeafCount].
   */
  getConsistencyProof(tenantId: string, oldSize: number): Promise<ConsistencyProof | null>;
}

export type TransparencyLogErrorCode = "INVALID_BATCH_SIZE" | "MISSING_TENANT" | "INVALID_LEAF" | "EMPTY_TREE";

export class TransparencyLogError extends Error {
  readonly code: TransparencyLogErrorCode;
  constructor(code: TransparencyLogErrorCode, message: string) {
    super(message);
    this.name = "TransparencyLogError";
    this.code = code;
  }
}
