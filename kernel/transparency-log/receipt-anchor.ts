/**
 * lib/transparency-log/receipt-anchor.ts — Anchoring receipts into a transparency log.
 *
 * PURPOSE
 * -------
 * Turns an ExecutionReceipt (or AuditRecord) into a leaf hash that can be
 * batched into a Merkle tree. The TransparencyLog is an in-memory, append-only,
 * tenant-scoped log that periodically builds a Merkle tree and publishes the root.
 *
 * INVARIANTS
 *   • Tenant isolation: each tenant has its own sequence of leaves and roots.
 *   • Deterministic leaf hash: canonical JSON, sorted keys, SHA-256.
 *   • Append-only: leaves are never removed or reordered.
 *   • fail-closed: cross-tenant queries return null; invalid receipts throw.
 *
 * Zero external dependencies.
 */

import { createHash } from "node:crypto";
import type { AuditRecord } from "../orchestrator/types";
import type { ExecutionReceipt } from "../adapter/agent-adapter";
import { canonicalJson } from "../common/canonical-json";
import { buildMerkleTree, verifyInclusionProof, type MerkleProof } from "./merkle-tree";
import { buildConsistencyProof, type ConsistencyProof } from "./consistency-proof";
import type { AnchoredRoot, ProofResult, TransparencyLog, TransparencyLogErrorCode } from "./types";

// ─── Leaf hashing ─────────────────────────────────────────────────────────────

/** Hash a single receipt into a 64-hex Merkle leaf. */
export function anchorReceipt(receipt: ExecutionReceipt): string {
  const canonical = canonicalReceiptJson(receipt);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Hash an audit record into a 64-hex Merkle leaf. */
export function anchorAuditRecord(record: AuditRecord): string {
  const canonical = canonicalAuditJson(record);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── TransparencyLog ────────────────────────────────────────────────────────

/**
 * InMemoryTransparencyLog — per-tenant append-only log with periodic Merkle anchoring.
 * Implements the TransparencyLog interface (drop-in for PgTransparencyLogStore).
 *
 * Batching strategy: every `batchSize` receipts (default 8) the log builds a new
 * Merkle tree and emits a root. The tree includes ALL leaves since genesis, not
 * just the latest batch — this keeps the root monotonically committing to the
 * growing history.
 */
export class InMemoryTransparencyLog implements TransparencyLog {
  private readonly tenantLeaves = new Map<string, string[]>();
  private readonly tenantRoots = new Map<string, AnchoredRoot[]>();
  private readonly tenantReceiptIds = new Map<string, Map<string, number>>();
  // Efficiency: leaf-hash → first-occurrence index, maintained incrementally on
  // append. Lets verifyReceipt() do an O(1) Map.get instead of an O(n) array
  // scan over every leaf ever anchored for the tenant (the log is append-only,
  // so this scan only grows over the life of the tenant).
  private readonly tenantLeafIndex = new Map<string, Map<string, number>>();
  private readonly batchSize: number;

  constructor(batchSize = 8) {
    if (batchSize < 1) throw new TransparencyLogError("INVALID_BATCH_SIZE", "batchSize must be >= 1");
    this.batchSize = batchSize;
  }

  /** Append a receipt leaf for a tenant. Returns the new leaf index. */
  async appendReceipt(tenantId: string, receipt: ExecutionReceipt, receiptId?: string): Promise<number> {
    if (!tenantId) throw new TransparencyLogError("MISSING_TENANT", "tenantId required");
    const leaf = anchorReceipt(receipt);
    const idx = this.appendLeaf(tenantId, leaf);
    if (receiptId) {
      const map = this.tenantReceiptIds.get(tenantId) ?? new Map<string, number>();
      map.set(receiptId, idx);
      this.tenantReceiptIds.set(tenantId, map);
    }
    return idx;
  }

  /** Append an audit-record leaf for a tenant. Returns the new leaf index. */
  async appendAuditRecord(tenantId: string, record: AuditRecord): Promise<number> {
    if (!tenantId) throw new TransparencyLogError("MISSING_TENANT", "tenantId required");
    const leaf = anchorAuditRecord(record);
    return this.appendLeaf(tenantId, leaf);
  }

  private appendLeaf(tenantId: string, leaf: string): number {
    const leaves = this.tenantLeaves.get(tenantId) ?? [];
    const idx = leaves.length;
    leaves.push(leaf);
    this.tenantLeaves.set(tenantId, leaves);

    // Mirror Array.indexOf semantics: only the FIRST occurrence of a given
    // leaf hash is recorded, so a re-anchored (duplicate) receipt resolves to
    // the same index indexOf would have found.
    const leafIndex = this.tenantLeafIndex.get(tenantId) ?? new Map<string, number>();
    if (!leafIndex.has(leaf)) leafIndex.set(leaf, idx);
    this.tenantLeafIndex.set(tenantId, leafIndex);

    // Rebuild tree every batchSize leaves
    if (leaves.length % this.batchSize === 0) {
      this.rebuildTree(tenantId);
    }

    return leaves.length - 1;
  }

  /** Force a tree rebuild for a tenant (useful for testing or finalization). */
  async finalize(tenantId: string): Promise<AnchoredRoot | null> {
    const leaves = this.tenantLeaves.get(tenantId);
    if (!leaves || leaves.length === 0) return null;
    return this.rebuildTree(tenantId);
  }

  private rebuildTree(tenantId: string): AnchoredRoot {
    const leaves = this.tenantLeaves.get(tenantId)!;
    const { root } = buildMerkleTree(leaves);
    const anchoredRoot: AnchoredRoot = {
      root,
      leafCount: leaves.length,
      anchoredAt: new Date().toISOString(),
    };
    const roots = this.tenantRoots.get(tenantId) ?? [];
    roots.push(anchoredRoot);
    this.tenantRoots.set(tenantId, roots);
    return anchoredRoot;
  }

  /** The latest root for a tenant, or null if no tree has been built yet. */
  async currentRoot(tenantId: string): Promise<AnchoredRoot | null> {
    const roots = this.tenantRoots.get(tenantId);
    return roots && roots.length > 0 ? roots[roots.length - 1] : null;
  }

  /** All roots ever published for a tenant. */
  async getRoots(tenantId: string): Promise<AnchoredRoot[]> {
    return this.tenantRoots.get(tenantId) ?? [];
  }

  /** Total leaf count for a tenant. */
  async leafCount(tenantId: string): Promise<number> {
    return this.tenantLeaves.get(tenantId)?.length ?? 0;
  }

  /** Generate an inclusion proof for a specific leaf index. Returns null if out of range. */
  async getProof(tenantId: string, leafIndex: number): Promise<MerkleProof | null> {
    const leaves = this.tenantLeaves.get(tenantId);
    if (!leaves || leafIndex < 0 || leafIndex >= leaves.length) return null;
    const { proofs } = buildMerkleTree(leaves);
    return proofs[leafIndex] ?? null;
  }

  /**
   * Consistency proof between an older tree (oldSize leaves) and the tenant's
   * current tree. Lets a monitor that saw an earlier root verify the log only
   * grew — the defence against split-view / history-rewrite. Returns null if
   * the tenant has no leaves or oldSize is out of [1, currentSize].
   */
  async getConsistencyProof(tenantId: string, oldSize: number): Promise<ConsistencyProof | null> {
    const leaves = this.tenantLeaves.get(tenantId);
    if (!leaves || leaves.length === 0) return null;
    if (!Number.isInteger(oldSize) || oldSize < 1 || oldSize > leaves.length) return null;
    return buildConsistencyProof(leaves, oldSize);
  }

  /** Find proof by the receiptId that was supplied during appendReceipt. */
  async getProofByReceiptId(tenantId: string, receiptId: string): Promise<ProofResult | null> {
    const map = this.tenantReceiptIds.get(tenantId);
    if (!map) return null;
    const leafIndex = map.get(receiptId);
    if (leafIndex === undefined) return null;
    const proof = await this.getProof(tenantId, leafIndex);
    if (!proof) return null;
    const root = await this.currentRoot(tenantId);
    if (!root) return null;
    return { proof, root, leafIndex };
  }

  /** Verify a receipt against the current root for its tenant. */
  async verifyReceipt(tenantId: string, receipt: ExecutionReceipt): Promise<boolean> {
    const root = await this.currentRoot(tenantId);
    if (!root) return false;
    const leaves = this.tenantLeaves.get(tenantId);
    if (!leaves) return false;

    const leaf = anchorReceipt(receipt);
    const idx = this.tenantLeafIndex.get(tenantId)?.get(leaf) ?? -1;
    if (idx === -1) return false;

    const proof = await this.getProof(tenantId, idx);
    if (!proof) return false;

    return verifyInclusionProof(leaf, root.root, proof);
  }
}

// ─── Canonical helpers ────────────────────────────────────────────────────────

function canonicalReceiptJson(receipt: ExecutionReceipt): string {
  const obj: Record<string, unknown> = {
    version: receipt.version,
    intentId: receipt.intentId,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    toolId: receipt.toolId,
    resourceRef: receipt.resourceRef,
    riskClass: receipt.riskClass,
    approvalClass: receipt.approvalClass,
    decision: receipt.decision,
    valueMicrounits: receipt.valueMicrounits,
    issuedAt: receipt.issuedAt,
    serverRiskClass: receipt.serverRiskClass,
    clientClaimedRiskClass: receipt.clientClaimedRiskClass,
    riskSource: receipt.riskSource,
    executionId: receipt.executionId ?? "",
    approvalToken: receipt.approvalToken ?? "",
    approvalCapabilityToken: receipt.approvalCapabilityToken ?? "",
    kid: receipt.kid ?? "",
  };
  if (receipt.killSwitchVerdict) {
    obj.killSwitchVerdict = {
      tripped: receipt.killSwitchVerdict.tripped,
      scope: receipt.killSwitchVerdict.scope ?? "",
      reason: receipt.killSwitchVerdict.reason ?? "",
    };
  }
  return canonicalJson(obj);
}

function canonicalAuditJson(record: AuditRecord): string {
  const obj: Record<string, unknown> = {
    id: record.id,
    tenantId: record.tenantId,
    actionId: record.actionId,
    actionType: record.actionType,
    source: record.source,
    outcome: record.outcome,
    reason: record.reason ?? "",
    occurredAt: record.occurredAt,
    prevHash: record.prevHash,
    hash: record.hash,
    signature: record.signature ?? "",
  };
  return canonicalJson(obj);
}

export class TransparencyLogError extends Error {
  readonly code: TransparencyLogErrorCode;
  constructor(code: TransparencyLogErrorCode, message: string) {
    super(message);
    this.name = "TransparencyLogError";
    this.code = code;
  }
}
