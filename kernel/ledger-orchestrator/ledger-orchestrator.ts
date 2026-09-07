/**
 * lib/ledger-orchestrator/ledger-orchestrator.ts
 *
 * Phase 4: כלכלת ההצלחה המשותפת (Shared-Success Economy).
 *
 * LedgerOrchestrator is the definitive chokepoint for all financial operations
 * in TFA. It composes two sovereign subsystems:
 *
 *   PaymentProvider (InMemoryLedger by default) — double-entry ledger in μ¢.
 *   TfaOrchestrator — guard + audit spine for autonomous / financial actions.
 *
 * Every mint, withdraw, and transfer is wrapped in an Action<T> tagged with
 * isFinancial=true and routed through the Orchestrator before the ledger is
 * mutated. If the guard denies (or throws), the ledger is NOT touched.
 *
 * proofOfSolvency is a non-financial integrity check — it is audited but is
 * not blocked by the financial fail-closed rule.
 *
 * Zero external dependencies — only node:crypto (via orchestrator + ledger).
 */

import { randomUUID } from "node:crypto";
import type { PaymentProvider } from "../ledger/types";
import type { Orchestrator, Signer } from "../orchestrator/types";
import type { IdentityStore } from "../agent-identity/types";
import { issuePassport } from "../passport/passport";
import type { ActionPassport } from "../passport/types";
import type {
  ILedgerOrchestrator,
  LedgerOpResult,
  MintPayload,
  WithdrawPayload,
  TransferPayload,
  SolvencyCheckPayload,
} from "./types";
import { LEDGER_ACTION_TYPES } from "./types";
import type {
  Account,
  AccountType,
  LedgerTransaction,
  MicroCents,
  SolvencyProof,
} from "../ledger/types";

/**
 * Optional passport-issuance wiring for LedgerOrchestrator.
 *
 * When `signer` is provided, every successful mint / withdraw / transfer
 * automatically issues an ActionPassport anchored on the audit record and
 * carrying the LedgerTransaction as `ledgerEffect`. The passport is:
 *   • attached to the returned LedgerOpResult as `passport`
 *   • emitted to the optional `onPassport(passport)` hook
 *
 * Fail-safe: passport issuance happens AFTER the solvency invariant. A
 * passport-issuance error never rolls back the (already-committed) ledger
 * mutation; instead it surfaces as a thrown error so callers / tests notice.
 */
export interface PassportIssuanceOptions {
  signer?: Signer;
  identityStore?: IdentityStore;
  onPassport?: (passport: ActionPassport) => void;
}

export class LedgerOrchestrator implements ILedgerOrchestrator {
  /**
   * Expose the underlying orchestrator so callers can inspect the audit chain:
   *   ledgerOrch.orchestrator.audit.getChain(tenantId)
   *   ledgerOrch.orchestrator.audit.verifyChain(tenantId)
   */
  readonly orchestrator: Orchestrator;
  private readonly provider: PaymentProvider;
  private readonly passportOpts: PassportIssuanceOptions;

  /**
   * @param provider    - The PaymentProvider implementation (default: InMemoryLedger).
   * @param orchestrator - A configured TfaOrchestrator with guard policies.
   *                       Financial operations are DENIED if no policies are registered.
   * @param passportOpts - Optional auto-passport issuance wiring. When `signer`
   *                       is supplied, every successful financial op produces an
   *                       ActionPassport (attached to result + onPassport hook).
   */
  constructor(
    provider: PaymentProvider,
    orchestrator: Orchestrator,
    passportOpts: PassportIssuanceOptions = {},
  ) {
    this.provider = provider;
    this.orchestrator = orchestrator;
    this.passportOpts = passportOpts;
  }

  // ── Passport issuance (auto, on every successful mutation) ─────────────────

  /**
   * Issue an ActionPassport for a successful financial operation, if a signer
   * is configured. Returns null when no signer is wired (backward compat).
   */
  private maybeIssuePassport(
    tenantId: string,
    auditId: string,
    tx: LedgerTransaction,
  ): ActionPassport | null {
    const { signer, identityStore, onPassport } = this.passportOpts;
    if (!signer) return null;
    const passport = issuePassport({
      auditId,
      auditStore: this.orchestrator.audit,
      signer,
      identityStore,
      ledgerEffect: tx,
      expectedTenantId: tenantId,
    });
    if (onPassport) onPassport(passport);
    return passport;
  }

  // ── Solvency invariant (runs after every successful mutation) ──────────────

  /**
   * After every successful mint / withdraw / transfer, verify that the tenant
   * remains solvent (totalAssets >= totalLiabilities).  Failure is a loud
   * invariant violation that writes an ERROR audit record and throws.
   */
  private async assertSolvencyInvariant(
    tenantId: string,
    actionId: string,
    actionType: string,
    source: string,
  ): Promise<void> {
    const proof = await this.provider.proofOfSolvency(tenantId);
    if (!proof.isSolvent) {
      const reason =
        `Solvency invariant violated after ${actionType}: ` +
        `netEquity=${proof.netEquity} μ¢, ` +
        `totalAssets=${proof.totalAssets} μ¢, ` +
        `totalLiabilities=${proof.totalLiabilities} μ¢`;
      this.orchestrator.audit.append({
        id: randomUUID(),
        tenantId,
        actionId,
        actionType: "ledger.invariant.solvency",
        source,
        outcome: "error",
        reason,
        occurredAt: new Date().toISOString(),
      });
      throw new Error(reason);
    }
  }

  // ── Financial operations ────────────────────────────────────────────────────

  /**
   * mint — the ONLY way to create credits for a tenant account.
   *
   * Routed through TfaOrchestrator as a financial action.
   * Fail-closed: DENIED if no guard policies are registered.
   *
   * @param isAutonomous - true when triggered by an agent (not a human).
   *                       Autonomous financial actions require explicit policy
   *                       allowance for BOTH financial AND autonomous tags.
   */
  async mint(
    tenantId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous = false,
  ): Promise<LedgerOpResult<LedgerTransaction>> {
    const payload: MintPayload = { toAccountId, amount, memo, initiatedBy };
    const actionId = randomUUID();
    const result = await this.orchestrator.run<MintPayload, LedgerTransaction>(
      {
        id: actionId,
        tenantId,
        type: LEDGER_ACTION_TYPES.MINT,
        payload,
        source: initiatedBy,
        isFinancial: true,
        isAutonomous,
        requestedAt: new Date().toISOString(),
        valueMicrounits: amount,
      },
      async (action) => {
        return this.provider.guardMint(
          action.tenantId,
          action.payload.toAccountId,
          action.payload.amount,
          action.payload.memo,
          action.payload.initiatedBy,
        );
      },
    );

    if (result.ok) {
      await this.assertSolvencyInvariant(
        tenantId,
        actionId,
        LEDGER_ACTION_TYPES.MINT,
        initiatedBy,
      );
      const passport = this.maybeIssuePassport(tenantId, result.auditId, result.result);
      const out: LedgerOpResult<LedgerTransaction> = { ok: true, value: result.result, auditId: result.auditId };
      if (passport) out.passport = passport;
      return out;
    }
    return { ok: false, reason: result.reason, auditId: result.auditId };
  }

  /**
   * withdraw — the ONLY way to remove credits from a tenant account.
   *
   * Fail-closed: DENIED if no guard policies are registered.
   * Also DENIED if the account has insufficient funds (LedgerError propagates
   * as an "error" audit outcome — the ledger is NOT mutated).
   */
  async withdraw(
    tenantId: string,
    fromAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous = false,
  ): Promise<LedgerOpResult<LedgerTransaction>> {
    const payload: WithdrawPayload = {
      fromAccountId,
      amount,
      memo,
      initiatedBy,
    };
    const actionId = randomUUID();
    const result = await this.orchestrator.run<
      WithdrawPayload,
      LedgerTransaction
    >(
      {
        id: actionId,
        tenantId,
        type: LEDGER_ACTION_TYPES.WITHDRAW,
        payload,
        source: initiatedBy,
        isFinancial: true,
        isAutonomous,
        requestedAt: new Date().toISOString(),
        valueMicrounits: amount,
      },
      async (action) => {
        return this.provider.guardWithdraw(
          action.tenantId,
          action.payload.fromAccountId,
          action.payload.amount,
          action.payload.memo,
          action.payload.initiatedBy,
        );
      },
    );

    if (result.ok) {
      await this.assertSolvencyInvariant(
        tenantId,
        actionId,
        LEDGER_ACTION_TYPES.WITHDRAW,
        initiatedBy,
      );
      const passport = this.maybeIssuePassport(tenantId, result.auditId, result.result);
      const out: LedgerOpResult<LedgerTransaction> = { ok: true, value: result.result, auditId: result.auditId };
      if (passport) out.passport = passport;
      return out;
    }
    return { ok: false, reason: result.reason, auditId: result.auditId };
  }

  /**
   * transfer — user-to-user within the same tenant.
   *
   * Financial action — guarded and audited. Fail-closed without policies.
   * The ledger rejects cross-tenant transfers independently.
   */
  async transfer(
    tenantId: string,
    fromAccountId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous = false,
  ): Promise<LedgerOpResult<LedgerTransaction>> {
    const payload: TransferPayload = {
      fromAccountId,
      toAccountId,
      amount,
      memo,
      initiatedBy,
    };
    const actionId = randomUUID();
    const result = await this.orchestrator.run<
      TransferPayload,
      LedgerTransaction
    >(
      {
        id: actionId,
        tenantId,
        type: LEDGER_ACTION_TYPES.TRANSFER,
        payload,
        source: initiatedBy,
        isFinancial: true,
        isAutonomous,
        requestedAt: new Date().toISOString(),
        valueMicrounits: amount,
      },
      async (action) => {
        return this.provider.transfer(
          action.tenantId,
          action.payload.fromAccountId,
          action.payload.toAccountId,
          action.payload.amount,
          action.payload.memo,
          action.payload.initiatedBy,
        );
      },
    );

    if (result.ok) {
      await this.assertSolvencyInvariant(
        tenantId,
        actionId,
        LEDGER_ACTION_TYPES.TRANSFER,
        initiatedBy,
      );
      const passport = this.maybeIssuePassport(tenantId, result.auditId, result.result);
      const out: LedgerOpResult<LedgerTransaction> = { ok: true, value: result.result, auditId: result.auditId };
      if (passport) out.passport = passport;
      return out;
    }
    return { ok: false, reason: result.reason, auditId: result.auditId };
  }

  // ── Integrity check (non-financial) ────────────────────────────────────────

  /**
   * proofOfSolvency — periodic tamper-evident integrity check.
   *
   * Non-financial, non-autonomous action — always allowed regardless of policies.
   * Still audited so the proof request appears in the audit chain.
   */
  async proofOfSolvency(
    tenantId: string,
    requestedBy: string,
  ): Promise<LedgerOpResult<SolvencyProof>> {
    const payload: SolvencyCheckPayload = { requestedBy };
    const result = await this.orchestrator.run<
      SolvencyCheckPayload,
      SolvencyProof
    >(
      {
        id: randomUUID(),
        tenantId,
        type: LEDGER_ACTION_TYPES.SOLVENCY_CHECK,
        payload,
        source: requestedBy,
        isFinancial: false,
        isAutonomous: false,
        requestedAt: new Date().toISOString(),
      },
      async (action) => {
        return this.provider.proofOfSolvency(action.tenantId);
      },
    );

    if (result.ok) {
      return { ok: true, value: result.result, auditId: result.auditId };
    }
    return { ok: false, reason: result.reason, auditId: result.auditId };
  }

  // ── Pass-through account management (no guard) ─────────────────────────────

  createAccount(
    tenantId: string,
    ownerId: string,
    type: AccountType,
    name: string,
  ): Promise<Account> {
    return this.provider.createAccount(tenantId, ownerId, type, name);
  }

  getAccount(tenantId: string, accountId: string): Promise<Account> {
    return this.provider.getAccount(tenantId, accountId);
  }

  listAccounts(tenantId: string): Promise<Account[]> {
    return this.provider.listAccounts(tenantId);
  }

  getTransactions(
    tenantId: string,
    accountId: string,
  ): Promise<LedgerTransaction[]> {
    return this.provider.getTransactions(tenantId, accountId);
  }
}
