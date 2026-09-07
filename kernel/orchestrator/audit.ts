/**
 * lib/orchestrator/audit.ts — InMemoryAuditStore: tamper-evident hash chain.
 *
 * Each tenant has its own ordered chain of AuditRecords.
 * Every record's hash covers: id, tenantId, actionType, outcome, prevHash.
 * The first record per tenant has prevHash = "genesis".
 *
 * Verification: recompute every hash and confirm prevHash links.
 * Any insertion, deletion, or field mutation breaks the chain.
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuditId, AuditRecord, AuditStore, Signer } from "./types.ts";

// ─── Hash computation ─────────────────────────────────────────────────────────

/**
 * Canonical hash over the immutable fields of a record.
 * Fields are joined with "|" — the separator is not a valid UUID/type character.
 */
function computeHash(record: Omit<AuditRecord, "hash">): string {
  const data = [
    record.id,
    record.tenantId,
    record.actionType,
    record.outcome,
    record.prevHash,
  ].join("|");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ─── InMemoryAuditStore ───────────────────────────────────────────────────────

/**
 * InMemoryAuditStore — reference implementation of AuditStore.
 *
 * Data lives in process memory. Use PgAuditStore (src/) for production
 * persistence. Suitable for tests, dev, and in-process agents.
 *
 * Thread safety: JavaScript is single-threaded; no locking needed.
 * Multi-process requires a real DB with row locking.
 */
export class InMemoryAuditStore implements AuditStore {
  /** Per-tenant ordered chains: tenantId → AuditRecord[]. */
  private readonly chains = new Map<string, AuditRecord[]>();
  private readonly signer?: Signer;

  constructor(signer?: Signer) {
    this.signer = signer;
  }

  // ─── append ───────────────────────────────────────────────────────────────

  /**
   * Append a new record to the tenant's chain.
   * prevHash is set automatically from the chain tail.
   * hash is computed from the canonical fields.
   * If a Signer was provided at construction, the record's hash is also
   * cryptographically signed (provenance, not just sequence).
   */
  append(input: Omit<AuditRecord, "hash" | "prevHash">): AuditRecord {
    if (!input.tenantId) {
      throw new AuditError("MISSING_TENANT", "tenantId is required");
    }
    if (!input.actionId) {
      throw new AuditError("MISSING_ACTION", "actionId is required");
    }

    const chain = this.chains.get(input.tenantId) ?? [];

    const prevHash =
      chain.length > 0 ? chain[chain.length - 1].hash : "genesis";

    // Strip any incoming signature — the store is the source of truth.
    const { signature: _ignored, ...cleanInput } = input as AuditRecord;
    const partial: Omit<AuditRecord, "hash"> = { ...cleanInput, prevHash };
    const hash = computeHash(partial);
    let record: AuditRecord = { ...partial, hash };

    if (this.signer) {
      record = { ...record, signature: this.signer.sign(hash) };
    }

    chain.push(record);
    this.chains.set(input.tenantId, chain);
    return record;
  }

  // ─── getChain ─────────────────────────────────────────────────────────────

  /**
   * Return a shallow copy of the tenant's chain in insertion order.
   * Returns [] if the tenant has no records.
   * NEVER returns records belonging to another tenant.
   */
  getChain(tenantId: string): AuditRecord[] {
    return [...(this.chains.get(tenantId) ?? [])];
  }

  // ─── verifyChain ──────────────────────────────────────────────────────────

  /**
   * Walk the chain and recompute every hash.
   * Returns true iff the chain is intact (all hashes match, all prevHashes link).
   * If a Signer was provided, also verifies the cryptographic signature on each
   * record's hash (provenance check).
   * An empty chain is considered intact.
   */
  verifyChain(tenantId: string): boolean {
    const chain = this.chains.get(tenantId);
    if (!chain || chain.length === 0) return true;

    for (let i = 0; i < chain.length; i++) {
      const rec = chain[i];

      // Verify prevHash link
      const expectedPrev = i === 0 ? "genesis" : chain[i - 1].hash;
      if (rec.prevHash !== expectedPrev) return false;

      // Recompute and verify hash
      const { hash, signature, ...partial } = rec;
      const expected = computeHash(partial);
      if (hash !== expected) return false;

      // Verify signature if signer configured
      if (this.signer) {
        if (!signature || !this.signer.verify(hash, signature)) return false;
      }
    }
    return true;
  }

  // ─── getRecord ────────────────────────────────────────────────────────────

  /**
   * Look up a single record by its audit id.
   * Scans all chains — audit ids are globally unique (UUID).
   * Returns null if not found.
   */
  getRecord(id: AuditId): AuditRecord | null {
    for (const chain of this.chains.values()) {
      const rec = chain.find((r) => r.id === id);
      if (rec) return rec;
    }
    return null;
  }
}

// ─── AuditError ───────────────────────────────────────────────────────────────

export type AuditErrorCode = "MISSING_TENANT" | "MISSING_ACTION";

export class AuditError extends Error {
  readonly code: AuditErrorCode;
  constructor(code: AuditErrorCode, message: string) {
    super(message);
    this.name = "AuditError";
    this.code = code;
  }
}
