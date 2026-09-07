/**
 * lib/transparency-log/witness-registry.ts — tenant-scoped witness registry.
 *
 * WHY THIS EXISTS
 * ----------------
 * witness.ts (v387) is the pure crypto core: sign/verify a tree-head
 * observation, and confirm a quorum given (a) candidate statements and (b) a
 * way to resolve a witnessId to its verifying Signer. It deliberately has no
 * notion of storage or transport.
 *
 * To expose that core over HTTP (the next missing item), something has to:
 *   1. hold the verifying Signer for each provisioned witness, per tenant
 *      (witnesses are provisioned operationally — like KeyRing kids — not by
 *      an anonymous caller claiming an id over the wire);
 *   2. accumulate submitted WitnessStatements so a later GET can compute
 *      quorum without every caller re-submitting every statement; and
 *   3. keep both of those tenant-isolated.
 *
 * This module is that storage layer. It is intentionally thin: registration
 * is a process-level operation (same trust boundary as KeyRing/revocationList
 * — provisioned by the operator, not by an HTTP caller), while submit/list
 * are the operations the HTTP routes drive.
 *
 * Fail-closed:
 *   • submit() rejects (returns null, does not store) a statement whose
 *     witnessId is not registered for the tenant, or whose signature does not
 *     verify — bad statements never enter the store.
 *   • quorumFor() delegates to collectWitnessQuorum, which itself throws
 *     SplitViewError on conflicting verified roots — that exception is not
 *     swallowed here.
 *   • Cross-tenant reads return [] / null, never another tenant's data.
 *
 * Zero external dependencies — in-memory, pure TypeScript.
 */

import type { Signer } from "../orchestrator/types";
import {
  signTreeHead,
  verifyWitnessStatement,
  collectWitnessQuorum,
  type WitnessStatement,
  type TreeHeadObservation,
  type WitnessQuorumResult,
} from "./witness";
import { checkWitnessLiveness, type WitnessLivenessOptions, type WitnessLivenessReport } from "./witness-liveness";

export class WitnessRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WitnessRegistryError";
    this.code = code;
  }
}

/**
 * WitnessRegistry — per-tenant witness key registry + submitted-statement store.
 *
 * Storage shape:
 *   tenantId → witnessId → Signer            (provisioned verifying keys)
 *   tenantId → WitnessStatement[]             (all accepted submissions, append-only)
 */
export class WitnessRegistry {
  private readonly signers = new Map<string, Map<string, Signer>>();
  private readonly statements = new Map<string, WitnessStatement[]>();

  /**
   * Provision a witness's verifying key for a tenant. Process-level operation
   * (operator-driven), idempotent — re-registering the same witnessId replaces
   * its key (e.g. operational key rotation), it does not duplicate entries.
   */
  registerWitness(tenantId: string, witnessId: string, signer: Signer): void {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new WitnessRegistryError("invalid_tenant_id", "tenantId must be a non-empty string");
    }
    if (typeof witnessId !== "string" || witnessId.length === 0) {
      throw new WitnessRegistryError("invalid_witness_id", "witnessId must be a non-empty string");
    }
    if (!signer || typeof signer.verify !== "function") {
      throw new WitnessRegistryError("invalid_signer", "signer must implement verify()");
    }
    let tenantMap = this.signers.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.signers.set(tenantId, tenantMap);
    }
    tenantMap.set(witnessId, signer);
  }

  /** Resolve a witness's verifying Signer for a tenant, or null if unknown (fail-closed). */
  resolveSigner(tenantId: string, witnessId: string): Signer | null {
    return this.signers.get(tenantId)?.get(witnessId) ?? null;
  }

  /** True iff at least one witness is registered for the tenant. */
  hasWitnesses(tenantId: string): boolean {
    const m = this.signers.get(tenantId);
    return !!m && m.size > 0;
  }

  /**
   * A registered witness signs a fresh observation and the statement is
   * stored directly. Convenience for server-side / test callers that hold
   * the witness's own Signer; HTTP submission goes through submit() instead,
   * which independently re-verifies (the server never trusts a POSTed
   * signature was actually produced by that witness without checking).
   */
  signAndSubmit(tenantId: string, signer: Signer, obs: TreeHeadObservation): WitnessStatement {
    const statement = signTreeHead(signer, obs);
    this.appendStatement(tenantId, statement);
    return statement;
  }

  /**
   * Accept a statement submitted over HTTP (or any untrusted channel).
   * Fail-closed: returns null (and stores nothing) unless the witnessId is
   * registered for this tenant AND the statement's signature verifies
   * against that witness's registered key.
   */
  submit(tenantId: string, statement: WitnessStatement): WitnessStatement | null {
    if (typeof tenantId !== "string" || tenantId.length === 0) return null;
    if (!statement || typeof statement.witnessId !== "string") return null;

    const signer = this.resolveSigner(tenantId, statement.witnessId);
    if (!signer) return null; // unregistered witness → reject, do not store

    if (!verifyWitnessStatement(statement, signer)) return null; // bad signature → reject

    this.appendStatement(tenantId, statement);
    return statement;
  }

  /** All statements stored for a tenant, oldest-first. Cross-tenant isolated. */
  list(tenantId: string): WitnessStatement[] {
    return [...(this.statements.get(tenantId) ?? [])];
  }

  /**
   * Compute quorum for a target tree head using every statement stored for
   * the tenant at that (logId, treeSize). Delegates to collectWitnessQuorum,
   * which throws SplitViewError if any verified statement disagrees on the
   * root — that throw is intentionally not caught here.
   */
  quorumFor(
    tenantId: string,
    target: { logId: string; root: string; treeSize: number },
    threshold: number,
  ): WitnessQuorumResult {
    // Read the live per-tenant array directly rather than via list()'s spread
    // copy — collectWitnessQuorum only iterates and reads, it never mutates,
    // so the defensive copy is pure overhead on every quorum check. For a
    // tenant with a long statement history this avoids an O(n) array clone
    // on what can be a hot, repeatedly-polled read path.
    const candidates = this.statements.get(tenantId) ?? [];
    return collectWitnessQuorum(candidates, target, threshold, (witnessId) =>
      this.resolveSigner(tenantId, witnessId),
    );
  }

  /**
   * Liveness/staleness check (§2.D-12): for every witness CURRENTLY
   * registered for this tenant, is there a verified statement within
   * `opts.maxAgeMs`? A registered witness that never signed, or hasn't
   * signed recently, comes back stale — same direct-Map read as quorumFor,
   * for the same reason (avoid an O(n) defensive copy on a read-only path).
   */
  checkLiveness(tenantId: string, opts: WitnessLivenessOptions): WitnessLivenessReport {
    const registeredIds = [...(this.signers.get(tenantId)?.keys() ?? [])];
    const candidates = this.statements.get(tenantId) ?? [];
    return checkWitnessLiveness(registeredIds, candidates, (witnessId) => this.resolveSigner(tenantId, witnessId), opts);
  }

  private appendStatement(tenantId: string, statement: WitnessStatement): void {
    let list = this.statements.get(tenantId);
    if (!list) {
      list = [];
      this.statements.set(tenantId, list);
    }
    list.push(statement);
  }
}
