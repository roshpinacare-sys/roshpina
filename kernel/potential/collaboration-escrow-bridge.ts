/**
 * lib/potential/collaboration-escrow-bridge.ts — Potential→Escrow loop.
 *
 * Closes the coordination-economy loop: when the PotentialEngine recommends a
 * collaboration pairing (CollaborationMatch), this bridge automatically opens a
 * Sovereign Escrow agreement for the engagement — under orchestrator policy and
 * with an ActionPassport proving provenance.
 *
 * Flow:
 *   CollaborationMatch
 *     → CollaborationEscrowBridge.openEscrow()
 *       → TfaOrchestrator (guard → audit → passport)
 *         → EscrowService.create()          ← no money moves yet
 *           → EscrowAgreement (state: "created") returned
 *
 * The escrow creation is treated as an AUTONOMOUS action (isAutonomous: true,
 * isFinancial: false) — the system is acting on behalf of the engine, so
 * fail-closed applies: at least one guard policy is required or the call
 * is DENIED.
 *
 * Money never moves here — that is deferred to EscrowService.fund() which has
 * its own guard + ledger chokepoint when the human triggers payment.
 *
 * Tenant isolation: the bridge validates that the CollaborationMatch tenantId
 * matches the input tenantId before forwarding to the escrow service. A
 * mismatch throws immediately (fail-closed, not silent discard).
 *
 * Zero external dependencies.
 */

import { randomUUID } from "node:crypto";
import { TfaOrchestrator } from "../orchestrator/orchestrator";
import { issuePassport } from "../passport/passport";
import type { ActionPassport } from "../passport/types";
import type { GuardPolicy, AuditStore, Signer } from "../orchestrator/types";
import type { IdentityStore } from "../agent-identity/types";
import type { CollaborationMatch } from "./personality-types";
import type { EscrowAgreement } from "../escrow/types";
import { EscrowService, type EscrowStore } from "../escrow/escrow";
import type { LedgerOrchestrator } from "../ledger-orchestrator/ledger-orchestrator";
import type { AuditId } from "../orchestrator/types";

// ─── Action type ──────────────────────────────────────────────────────────────

/** Action-type string used when orchestrating the escrow-open operation. */
export const COLLABORATION_ESCROW_ACTION_TYPE = "potential.collaboration.escrow" as const;
/** Action-type string used when orchestrating the escrow-completion operation. */
export const COLLABORATION_COMPLETE_ACTION_TYPE = "potential.collaboration.complete" as const;

// ─── Input / Result ───────────────────────────────────────────────────────────

/**
 * Input to CollaborationEscrowBridge.openEscrow().
 *
 * All four account/amount fields are required — the bridge has no way to infer
 * them from the CollaborationMatch alone. The caller is responsible for
 * resolving ledger account IDs from user IDs before calling openEscrow().
 */
export interface CollaborationEscrowInput {
  /** Must match match.tenantId (enforced). */
  tenantId: string;
  /** The CollaborationMatch that triggered the escrow creation. */
  match: CollaborationMatch;
  /** The opportunity the two users are collaborating on. */
  opportunityId: string;
  /**
   * Ledger account id of the payer (opportunity requester / sponsor).
   * Typically derived from match.userA or match.userB depending on context.
   */
  payerAccountId: string;
  /**
   * Ledger account id of the worker (the collaborator who will receive payment
   * on completion). Typically the other party.
   */
  workerAccountId: string;
  /** Amount in μ¢ (BigInt). Must be > 0n. */
  amount: bigint;
  /** Who initiated this (agent id or user id — recorded in the audit chain). */
  initiatedBy: string;
}

/**
 * Result of CollaborationEscrowBridge.openEscrow().
 *
 * On the ok=true branch the escrow agreement is in state "created" (no funds
 * have moved). The optional passport is present when a Signer is wired.
 */
export type CollaborationEscrowResult =
  | { ok: true; agreement: EscrowAgreement; auditId: AuditId; passport?: ActionPassport }
  | { ok: false; reason: string; auditId: AuditId };

// ─── Input / Result for completion ───────────────────────────────────────────

/** Input to CollaborationEscrowBridge.completeCollaboration(). */
export interface CollaborationCompleteInput {
  tenantId: string;
  escrowId: string;
  initiatedBy: string;
}

// ─── Passport wiring (mirrors PotentialEngine pattern) ────────────────────────

export interface EscrowPassportOptions {
  signer?: Signer;
  identityStore?: IdentityStore;
  onPassport?: (passport: ActionPassport) => void;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class CollaborationEscrowBridge {
  private readonly orchestrator: TfaOrchestrator;
  private readonly escrow: EscrowService;
  private readonly passportOpts: EscrowPassportOptions;
  private readonly agentSourceId: string;

  /**
   * @param policies      Guard policies. At least one required (autonomous action).
   * @param ledger        LedgerOrchestrator injected into EscrowService for account creation.
   * @param escrowStore   Optional EscrowStore. Defaults to InMemoryEscrowStore.
   * @param auditStore    Optional AuditStore. Defaults to InMemoryAuditStore.
   * @param passportOpts  Optional passport-issuance wiring.
   * @param agentSourceId Agent identity id. Defaults to "CollaborationEscrowBridge".
   */
  constructor(
    policies: GuardPolicy[],
    ledger: LedgerOrchestrator,
    escrowStore?: EscrowStore,
    auditStore?: AuditStore,
    passportOpts: EscrowPassportOptions = {},
    agentSourceId = "CollaborationEscrowBridge",
  ) {
    this.orchestrator = new TfaOrchestrator(policies, auditStore);
    this.escrow = new EscrowService(ledger, escrowStore);
    this.passportOpts = passportOpts;
    this.agentSourceId = agentSourceId;
  }

  /** Direct access to the audit store for inspection and chain verification. */
  get audit(): AuditStore {
    return this.orchestrator.audit;
  }

  /**
   * Open an Escrow agreement for a CollaborationMatch recommendation.
   *
   * Tenant isolation is enforced before the guard runs — a mismatch between
   * input.tenantId and match.tenantId throws immediately (fail-closed).
   *
   * The action is autonomous (isAutonomous: true). Without at least one guard
   * policy, this call will be DENIED and return { ok: false }.
   *
   * No money moves — EscrowService.create() only establishes the agreement and
   * its dedicated ledger account. Funding is a separate human-triggered step.
   */
  async openEscrow(input: CollaborationEscrowInput): Promise<CollaborationEscrowResult> {
    // Validate required fields up-front (fail-closed)
    if (!input?.tenantId) {
      throw new Error("CollaborationEscrowBridge.openEscrow: tenantId is required");
    }
    if (!input.match) {
      throw new Error("CollaborationEscrowBridge.openEscrow: match is required");
    }

    // Tenant isolation: match must belong to the same tenant
    if (input.match.tenantId !== input.tenantId) {
      throw new Error(
        `CollaborationEscrowBridge tenant isolation violation: ` +
        `input.tenantId=${input.tenantId} but match.tenantId=${input.match.tenantId}`,
      );
    }

    const action = {
      id: randomUUID(),
      tenantId: input.tenantId,
      type: COLLABORATION_ESCROW_ACTION_TYPE,
      payload: input,
      source: this.agentSourceId,
      isFinancial: false,
      isAutonomous: true,
      requestedAt: new Date().toISOString(),
    };

    const orchResult = await this.orchestrator.run(action, async () => {
      return this.escrow.create({
        tenantId: input.tenantId,
        opportunityId: input.opportunityId,
        payerAccountId: input.payerAccountId,
        workerAccountId: input.workerAccountId,
        amount: input.amount,
      });
    });

    if (orchResult.ok) {
      const passport = this.maybeIssuePassport(input.tenantId, orchResult.auditId);
      const out: CollaborationEscrowResult = {
        ok: true,
        agreement: orchResult.result,
        auditId: orchResult.auditId,
      };
      if (passport) out.passport = passport;
      return out;
    }

    return { ok: false, reason: orchResult.reason, auditId: orchResult.auditId };
  }

  /**
   * Complete a collaboration escrow: fund (if still in "created" state) then release
   * to the worker.  Both fund and release flow through the LedgerOrchestrator chokepoint
   * (guard→audit→passport).  The completion itself is an autonomous action wrapped in
   * the bridge's orchestrator, so it gets its own audit record + passport when a signer
   * is wired.
   *
   * Tenant isolation: the escrow must belong to the input tenantId.  A mismatch throws
   * immediately (fail-closed).
   */
  async completeCollaboration(
    input: CollaborationCompleteInput,
  ): Promise<CollaborationEscrowResult> {
    if (!input?.tenantId) {
      throw new Error("CollaborationEscrowBridge.completeCollaboration: tenantId is required");
    }
    if (!input?.escrowId) {
      throw new Error("CollaborationEscrowBridge.completeCollaboration: escrowId is required");
    }

    const agreement = await this.escrow.get(input.tenantId, input.escrowId);
    if (!agreement) {
      throw new Error("CollaborationEscrowBridge: escrow agreement not found");
    }
    if (agreement.tenantId !== input.tenantId) {
      throw new Error(
        `CollaborationEscrowBridge tenant isolation violation: ` +
          `input.tenantId=${input.tenantId} but escrow.tenantId=${agreement.tenantId}`,
      );
    }

    const action = {
      id: randomUUID(),
      tenantId: input.tenantId,
      type: COLLABORATION_COMPLETE_ACTION_TYPE,
      payload: input,
      source: this.agentSourceId,
      isFinancial: false,
      isAutonomous: true,
      requestedAt: new Date().toISOString(),
    };

    const orchResult = await this.orchestrator.run(action, async () => {
      if (agreement.state === "created") {
        await this.escrow.fund(input.tenantId, input.escrowId, input.initiatedBy);
      }
      return this.escrow.release(input.tenantId, input.escrowId, input.initiatedBy);
    });

    if (orchResult.ok) {
      const passport = this.maybeIssuePassport(input.tenantId, orchResult.auditId);
      const out: CollaborationEscrowResult = {
        ok: true,
        agreement: orchResult.result,
        auditId: orchResult.auditId,
      };
      if (passport) out.passport = passport;
      return out;
    }

    return { ok: false, reason: orchResult.reason, auditId: orchResult.auditId };
  }

  // ── Passport issuance ──────────────────────────────────────────────────────

  private maybeIssuePassport(tenantId: string, auditId: string): ActionPassport | null {
    const { signer, identityStore, onPassport } = this.passportOpts;
    if (!signer) return null;
    const passport = issuePassport({
      auditId,
      auditStore: this.orchestrator.audit,
      signer,
      identityStore,
      expectedTenantId: tenantId,
    });
    if (onPassport) onPassport(passport);
    return passport;
  }
}
