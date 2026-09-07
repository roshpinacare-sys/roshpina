/**
 * lib/ledger-orchestrator/types.ts — LedgerOrchestrator: shared types.
 *
 * LedgerOrchestrator is the Phase 4 "shared-success economy" chokepoint.
 * Every financial ledger operation (mint / withdraw / transfer) flows through
 * the TfaOrchestrator guard+audit pipeline before touching the PaymentProvider.
 *
 * Invariants (all inherited from Orchestrator + Ledger):
 *   • Mint / withdraw / transfer = isFinancial=true → fail-closed without policies.
 *   • Autonomous mints (agent-driven) = isAutonomous=true → doubly guarded.
 *   • proofOfSolvency = read-only, non-financial → no policy required.
 *   • Audit chain is hash-linked and per-tenant; every op writes a record.
 *   • Tenant isolation: tenantId checked both by ledger and orchestrator.
 *   • All amounts are BigInt μ¢. Never number.
 */

import type { AuditId } from "../orchestrator/types";
import type { ActionPassport } from "../passport/types";
import type {
  Account,
  AccountType,
  LedgerTransaction,
  MicroCents,
  SolvencyProof,
} from "../ledger/types";

// ─── Action-type constants ────────────────────────────────────────────────────

export const LEDGER_ACTION_TYPES = {
  MINT:            "ledger.mint",
  WITHDRAW:        "ledger.withdraw",
  TRANSFER:        "ledger.transfer",
  SOLVENCY_CHECK:  "ledger.solvency_check",
} as const;

export type LedgerActionType =
  (typeof LEDGER_ACTION_TYPES)[keyof typeof LEDGER_ACTION_TYPES];

// ─── Action payloads ──────────────────────────────────────────────────────────

export interface MintPayload {
  toAccountId: string;
  amount: MicroCents;
  memo: string;
  initiatedBy: string;
}

export interface WithdrawPayload {
  fromAccountId: string;
  amount: MicroCents;
  memo: string;
  initiatedBy: string;
}

export interface TransferPayload {
  fromAccountId: string;
  toAccountId: string;
  amount: MicroCents;
  memo: string;
  initiatedBy: string;
}

export interface SolvencyCheckPayload {
  requestedBy: string;
}

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * LedgerOpResult<T> — outcome of a ledger operation routed through Orchestrator.
 *
 * ok=true  → the operation executed and the ledger was mutated.
 * ok=false → guard denied or executor threw; ledger was NOT mutated.
 * Both branches always carry auditId for cross-referencing the audit chain.
 */
export type LedgerOpResult<T> =
  | { ok: true;  value: T; auditId: AuditId; passport?: ActionPassport }
  | { ok: false; reason: string; auditId: AuditId };

// ─── LedgerOrchestrator interface ─────────────────────────────────────────────

/**
 * LedgerOrchestrator — the single chokepoint for all financial operations.
 *
 * Wraps a PaymentProvider (default: InMemoryLedger) and a TfaOrchestrator.
 * Financial operations (mint/withdraw/transfer) are wrapped in Actions and
 * routed through the guard+audit pipeline before the ledger is touched.
 *
 * Read operations (createAccount, getAccount, listAccounts, getTransactions)
 * are passed through directly — they are non-mutating and do not require
 * guard evaluation (though they may add non-financial audit records in future).
 *
 * proofOfSolvency is a read-only integrity check (non-financial) — it is
 * audited but does not require financial guard policies to be present.
 */
export interface ILedgerOrchestrator {
  // ── Financial operations (all guarded) ──────────────────────────────────
  mint(
    tenantId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous?: boolean,
  ): Promise<LedgerOpResult<LedgerTransaction>>;

  withdraw(
    tenantId: string,
    fromAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous?: boolean,
  ): Promise<LedgerOpResult<LedgerTransaction>>;

  transfer(
    tenantId: string,
    fromAccountId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
    isAutonomous?: boolean,
  ): Promise<LedgerOpResult<LedgerTransaction>>;

  // ── Integrity check (non-financial, always allowed) ──────────────────────
  proofOfSolvency(
    tenantId: string,
    requestedBy: string,
  ): Promise<LedgerOpResult<SolvencyProof>>;

  // ── Pass-through account management (no guard) ────────────────────────────
  createAccount(
    tenantId: string,
    ownerId: string,
    type: AccountType,
    name: string,
  ): Promise<Account>;

  getAccount(tenantId: string, accountId: string): Promise<Account>;
  listAccounts(tenantId: string): Promise<Account[]>;
  getTransactions(
    tenantId: string,
    accountId: string,
  ): Promise<LedgerTransaction[]>;
}
