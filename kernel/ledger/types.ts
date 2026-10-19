/**
 * lib/ledger/types.ts — TFA Sovereign Ledger: shared types.
 *
 * All monetary values in μ¢ (micro-cents, 1/100 of a cent = 1/10000 of $1).
 * Using BigInt prevents floating-point drift. Example: $1.00 = 100_000n μ¢.
 *
 * Double-entry: every financial operation writes two journal entries that sum
 * to zero (debit + credit). The ledger is always balanced.
 *
 * Tenant isolation: every account, entry, and operation is scoped to tenantId.
 * Cross-tenant operations are rejected at the guard chokepoint.
 */

// ─── Primitive types ──────────────────────────────────────────────────────────

/** Micro-cents. Always BigInt. Never number, never float. */
export type MicroCents = bigint;

/** ISO-8601 timestamp string (from Date.toISOString()). */
export type ISOTimestamp = string;

// ─── Account ──────────────────────────────────────────────────────────────────

export type AccountType =
  | "asset"      // What we hold (user wallet, reserve)
  | "liability"  // What we owe (unearned revenue)
  | "equity"     // Net worth / platform capital
  | "revenue"    // Earned income
  | "expense";   // Costs incurred

export interface Account {
  id: string;
  tenantId: string;
  ownerId: string;    // userId or "system"
  type: AccountType;
  name: string;
  /** Current balance in μ¢. Maintained via double-entry — never set directly. */
  balance: MicroCents;
  createdAt: ISOTimestamp;
}

// ─── Journal entry (one leg of a double-entry pair) ──────────────────────────

export type EntryType = "debit" | "credit";

export interface JournalEntry {
  id: string;
  tenantId: string;
  transactionId: string;
  accountId: string;
  type: EntryType;
  amount: MicroCents;   // always positive
  memo: string;
  createdAt: ISOTimestamp;
  /** Optional ExecutionWorkflow ID that produced this ledger entry. */
  executionId?: string;
  /** Optional Approval ID that authorized this ledger entry. */
  approvalId?: string;
}

// ─── Transaction (a matched pair of journal entries) ─────────────────────────

export type TransactionKind =
  | "mint"       // Platform grants credits (guardMint)
  | "withdraw"   // Platform removes credits (guardWithdraw)
  | "transfer"   // User-to-user within tenant
  | "fee"        // Platform fee on an operation
  | "refund";    // Reversal

export interface LedgerTransaction {
  id: string;
  tenantId: string;
  kind: TransactionKind;
  debitAccountId: string;
  creditAccountId: string;
  amount: MicroCents;
  memo: string;
  /** Audit: who / which service initiated this */
  initiatedBy: string;
  createdAt: ISOTimestamp;
  /** Optional ExecutionWorkflow ID that produced this transaction. */
  executionId?: string;
  /** Optional Approval ID that authorized this transaction. */
  approvalId?: string;
}

// ─── Solvency proof ───────────────────────────────────────────────────────────

/**
 * Tenant accounting model — decides which solvency law applies.
 *
 *  - "custodial": the tenant HOLDS money for others (deposits/stakes live here).
 *    Law: totalAssets >= totalLiabilities (can the vault pay its depositors).
 *
 *  - "mirror": the tenant is the signed settlement MIRROR of another book
 *    (the live market). Its liabilities are the live economy's real claims,
 *    kept converged by ledger-sync; its pools are era-corrected to ~0 BY
 *    DESIGN (sync law 3: "pool=0 — every unit of backing held as a real
 *    mirror"). Demanding assets>=liabilities here would alarm forever on the
 *    correct end-state (measured live: era corrections seq 329 + 1086 proved
 *    the dead-era pools were the phantom side). The falsifiable mirror law:
 *    zero-sum integrity (Σ ALL account balances === 0 — any debit/credit
 *    asymmetry breaks it) + no negative liability mirror (a claim the book
 *    cannot honor) + no negative asset account (invented backing).
 */
export type TenantModel = "custodial" | "mirror";

export interface SolvencyProof {
  tenantId: string;
  generatedAt: ISOTimestamp;
  /** Which solvency law was applied */
  model: TenantModel;
  /** Sum of all asset account balances */
  totalAssets: MicroCents;
  /** Sum of all liability account balances */
  totalLiabilities: MicroCents;
  /** totalAssets - totalLiabilities (informational for mirror tenants) */
  netEquity: MicroCents;
  /** Sum of ALL account balances, every type — must be exactly 0 (double-entry integrity) */
  sumAll: MicroCents;
  /** Number of accounts checked */
  accountCount: number;
  /** SHA-256 fingerprint of all balances, for tamper-evidence */
  balanceHash: string;
  isSolvent: boolean;
}

// ─── PaymentProvider interface (adapter behind which external providers sit) ──

/**
 * PaymentProvider — the adapter interface every external payment system must
 * implement. The default (in-house) implementation is InMemoryLedger.
 * Stripe, PayPal, etc. are optional adapters — never called directly by services.
 */
export interface PaymentProvider {
  /** Create a new account for a user within a tenant. */
  createAccount(
    tenantId: string,
    ownerId: string,
    type: AccountType,
    name: string,
  ): Promise<Account>;

  /** Get an account by id. Throws if tenantId doesn't match. */
  getAccount(tenantId: string, accountId: string): Promise<Account>;

  /** List all accounts for a tenant. */
  listAccounts(tenantId: string): Promise<Account[]>;

  /**
   * guardMint — the ONLY way to create credits.
   * Adds μ¢ to a user account; debits the platform reserve.
   * Writes a tamper-evident audit entry. Throws on any invalid input.
   */
  guardMint(
    tenantId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction>;

  /**
   * guardWithdraw — the ONLY way to remove credits.
   * Removes μ¢ from a user account; credits the platform reserve.
   * Fails if balance insufficient (fail-closed). Throws on any invalid input.
   */
  guardWithdraw(
    tenantId: string,
    fromAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction>;

  /**
   * transfer — user-to-user within the same tenant.
   * Both accounts must belong to tenantId. Fails if sender has insufficient funds.
   */
  transfer(
    tenantId: string,
    fromAccountId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction>;

  /** Full transaction history for an account. */
  getTransactions(
    tenantId: string,
    accountId: string,
  ): Promise<LedgerTransaction[]>;

  /**
   * proofOfSolvency — periodic integrity check.
   * Verifies that totalAssets >= totalLiabilities for all accounts in tenant.
   * Returns a tamper-evident proof record.
   */
  proofOfSolvency(tenantId: string): Promise<SolvencyProof>;
}
