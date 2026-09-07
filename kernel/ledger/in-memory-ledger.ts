/**
 * lib/ledger/in-memory-ledger.ts — TFA Sovereign In-Memory Ledger.
 *
 * Default PaymentProvider implementation. Zero external dependencies.
 * Uses double-entry bookkeeping with BigInt μ¢. All state is in-memory
 * (replace with Drizzle+PostgreSQL persistence layer for production).
 *
 * Design invariants (enforced at every mutation):
 *   1. All amounts are BigInt μ¢ (micro-cents). Never number, never float.
 *   2. Every financial operation writes exactly two journal entries summing to 0.
 *   3. guardMint / guardWithdraw are the ONLY chokepoints for credit creation/destruction.
 *   4. Tenant isolation: cross-tenant access throws. Always filter by tenantId.
 *   5. Insufficient funds → throw LedgerError (fail-closed, never silent underflow).
 *   6. Invalid input (negative amount, missing account) → throw LedgerError.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  Account,
  AccountType,
  JournalEntry,
  LedgerTransaction,
  MicroCents,
  PaymentProvider,
  SolvencyProof,
  TransactionKind,
} from "./types";

// ─── Error type ───────────────────────────────────────────────────────────────

export class LedgerError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

// ─── Internal ID generator (no external deps) ─────────────────────────────────

function newId(): string {
  return randomBytes(16).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

// ─── Guard helpers ────────────────────────────────────────────────────────────

function guardPositive(amount: MicroCents, label = "amount"): void {
  if (typeof amount !== "bigint") {
    throw new LedgerError(
      `${label} must be BigInt μ¢, got ${typeof amount}`,
      "INVALID_TYPE",
    );
  }
  if (amount <= 0n) {
    throw new LedgerError(
      `${label} must be positive μ¢, got ${amount}`,
      "INVALID_AMOUNT",
    );
  }
}

function guardNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new LedgerError(`${label} must not be empty`, "MISSING_FIELD");
  }
}

// ─── InMemoryLedger ───────────────────────────────────────────────────────────

export class InMemoryLedger implements PaymentProvider {
  private readonly accounts = new Map<string, Account>();
  private readonly entries = new Map<string, JournalEntry[]>();
  private readonly transactions = new Map<string, LedgerTransaction[]>();

  // Each tenant gets a system "reserve" account (type=equity) used as the
  // counterparty for mint/withdraw operations.
  private readonly reserveAccounts = new Map<string, string>(); // tenantId → accountId

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  /** Ensure a system reserve account exists for the tenant. Returns its id. */
  private ensureReserve(tenantId: string): string {
    const existing = this.reserveAccounts.get(tenantId);
    if (existing) return existing;

    const id = newId();
    const account: Account = {
      id,
      tenantId,
      ownerId: "system",
      type: "equity",
      name: "Platform Reserve",
      balance: 0n,
      createdAt: now(),
    };
    this.accounts.set(id, account);
    this.reserveAccounts.set(tenantId, id);
    return id;
  }

  // ─── Tenant isolation guard ─────────────────────────────────────────────────

  private assertTenant(account: Account, tenantId: string): void {
    if (account.tenantId !== tenantId) {
      throw new LedgerError(
        `Tenant isolation violation: account ${account.id} belongs to tenant ${account.tenantId}, not ${tenantId}`,
        "TENANT_VIOLATION",
      );
    }
  }

  private getAccountOrThrow(tenantId: string, accountId: string): Account {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new LedgerError(
        `Account not found: ${accountId}`,
        "ACCOUNT_NOT_FOUND",
      );
    }
    this.assertTenant(account, tenantId);
    return account;
  }

  // ─── Double-entry writer ────────────────────────────────────────────────────

  /**
   * Write a balanced double-entry transaction.
   * Debit reduces debitAccount balance; credit increases creditAccount balance.
   * (For asset accounts: debit = add, credit = remove. Standard accounting.)
   * Here we use a simplified model: debit = from, credit = to for user-facing ops.
   */
  private writeTransaction(
    tenantId: string,
    kind: TransactionKind,
    debitAccount: Account,
    creditAccount: Account,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): LedgerTransaction {
    const txId = newId();
    const ts = now();

    // Mutate balances
    debitAccount.balance -= amount;
    creditAccount.balance += amount;

    // Write journal entries
    const debitEntry: JournalEntry = {
      id: newId(),
      tenantId,
      transactionId: txId,
      accountId: debitAccount.id,
      type: "debit",
      amount,
      memo,
      createdAt: ts,
    };
    const creditEntry: JournalEntry = {
      id: newId(),
      tenantId,
      transactionId: txId,
      accountId: creditAccount.id,
      type: "credit",
      amount,
      memo,
      createdAt: ts,
    };

    const debitList = this.entries.get(debitAccount.id) ?? [];
    const creditList = this.entries.get(creditAccount.id) ?? [];
    debitList.push(debitEntry);
    creditList.push(creditEntry);
    this.entries.set(debitAccount.id, debitList);
    this.entries.set(creditAccount.id, creditList);

    // Write transaction record
    const tx: LedgerTransaction = {
      id: txId,
      tenantId,
      kind,
      debitAccountId: debitAccount.id,
      creditAccountId: creditAccount.id,
      amount,
      memo,
      initiatedBy,
      createdAt: ts,
    };

    const txList = this.transactions.get(tenantId) ?? [];
    txList.push(tx);
    this.transactions.set(tenantId, txList);

    return tx;
  }

  // ─── PaymentProvider implementation ────────────────────────────────────────

  async createAccount(
    tenantId: string,
    ownerId: string,
    type: AccountType,
    name: string,
  ): Promise<Account> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(ownerId, "ownerId");
    guardNonEmpty(name, "name");

    const account: Account = {
      id: newId(),
      tenantId,
      ownerId,
      type,
      name,
      balance: 0n,
      createdAt: now(),
    };
    this.accounts.set(account.id, account);
    return { ...account };
  }

  async getAccount(tenantId: string, accountId: string): Promise<Account> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(accountId, "accountId");
    const account = this.getAccountOrThrow(tenantId, accountId);
    return { ...account, balance: account.balance };
  }

  async listAccounts(tenantId: string): Promise<Account[]> {
    guardNonEmpty(tenantId, "tenantId");
    const result: Account[] = [];
    for (const account of this.accounts.values()) {
      if (account.tenantId === tenantId) {
        result.push({ ...account, balance: account.balance });
      }
    }
    return result;
  }

  /**
   * guardMint — ONLY way to create credits.
   * Platform reserve → user account. Reserve balance goes negative (that's fine
   * for an equity/liability account — it means we owe that much).
   */
  async guardMint(
    tenantId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(toAccountId, "toAccountId");
    guardPositive(amount, "amount");
    guardNonEmpty(memo, "memo");
    guardNonEmpty(initiatedBy, "initiatedBy");

    const toAccount = this.getAccountOrThrow(tenantId, toAccountId);
    const reserveId = this.ensureReserve(tenantId);
    const reserveAccount = this.accounts.get(reserveId)!;

    return this.writeTransaction(
      tenantId,
      "mint",
      reserveAccount, // debit reserve (reserve gives out credits)
      toAccount,      // credit user account
      amount,
      memo,
      initiatedBy,
    );
  }

  /**
   * guardWithdraw — ONLY way to remove credits.
   * User account → platform reserve. Throws if insufficient funds (fail-closed).
   */
  async guardWithdraw(
    tenantId: string,
    fromAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(fromAccountId, "fromAccountId");
    guardPositive(amount, "amount");
    guardNonEmpty(memo, "memo");
    guardNonEmpty(initiatedBy, "initiatedBy");

    const fromAccount = this.getAccountOrThrow(tenantId, fromAccountId);

    // Fail-closed: insufficient funds
    if (fromAccount.balance < amount) {
      throw new LedgerError(
        `Insufficient funds: account ${fromAccountId} has ${fromAccount.balance} μ¢, requested ${amount} μ¢`,
        "INSUFFICIENT_FUNDS",
      );
    }

    const reserveId = this.ensureReserve(tenantId);
    const reserveAccount = this.accounts.get(reserveId)!;

    return this.writeTransaction(
      tenantId,
      "withdraw",
      fromAccount,    // debit user account (user gives back credits)
      reserveAccount, // credit reserve
      amount,
      memo,
      initiatedBy,
    );
  }

  /**
   * transfer — user-to-user within same tenant.
   * Fails if fromAccount has insufficient funds.
   * Rejects cross-tenant transfers.
   */
  async transfer(
    tenantId: string,
    fromAccountId: string,
    toAccountId: string,
    amount: MicroCents,
    memo: string,
    initiatedBy: string,
  ): Promise<LedgerTransaction> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(fromAccountId, "fromAccountId");
    guardNonEmpty(toAccountId, "toAccountId");
    guardPositive(amount, "amount");
    guardNonEmpty(memo, "memo");
    guardNonEmpty(initiatedBy, "initiatedBy");

    if (fromAccountId === toAccountId) {
      throw new LedgerError(
        "Cannot transfer to the same account",
        "SELF_TRANSFER",
      );
    }

    const fromAccount = this.getAccountOrThrow(tenantId, fromAccountId);
    const toAccount = this.getAccountOrThrow(tenantId, toAccountId);

    if (fromAccount.balance < amount) {
      throw new LedgerError(
        `Insufficient funds: account ${fromAccountId} has ${fromAccount.balance} μ¢, requested ${amount} μ¢`,
        "INSUFFICIENT_FUNDS",
      );
    }

    return this.writeTransaction(
      tenantId,
      "transfer",
      fromAccount,
      toAccount,
      amount,
      memo,
      initiatedBy,
    );
  }

  async getTransactions(
    tenantId: string,
    accountId: string,
  ): Promise<LedgerTransaction[]> {
    guardNonEmpty(tenantId, "tenantId");
    guardNonEmpty(accountId, "accountId");

    // Verify tenant isolation
    this.getAccountOrThrow(tenantId, accountId);

    const allTxs = this.transactions.get(tenantId) ?? [];
    return allTxs.filter(
      (tx) =>
        tx.debitAccountId === accountId || tx.creditAccountId === accountId,
    );
  }

  /**
   * proofOfSolvency — periodic integrity check.
   * Verifies: sum(assets) >= sum(liabilities) for all tenant accounts.
   * Produces a tamper-evident SHA-256 fingerprint of all current balances.
   */
  async proofOfSolvency(tenantId: string): Promise<SolvencyProof> {
    guardNonEmpty(tenantId, "tenantId");

    const balanceLines: string[] = [];
    let totalAssets = 0n;
    let totalLiabilities = 0n;

    // Single pass: filter, build lines, accumulate totals.
    // Sort only the string lines (cheaper than sorting Account objects).
    for (const acc of this.accounts.values()) {
      if (acc.tenantId !== tenantId) continue;
      balanceLines.push(`${acc.id}:${acc.type}:${acc.balance}`);
      if (acc.type === "asset") totalAssets += acc.balance;
      else if (acc.type === "liability") totalLiabilities += acc.balance;
      // equity/revenue/expense contribute to net worth but not the basic solvency check
    }

    balanceLines.sort((a, b) => a.localeCompare(b));

    const netEquity = totalAssets - totalLiabilities;
    const isSolvent = netEquity >= 0n;

    const balanceHash = createHash("sha256")
      .update(balanceLines.join("\n"))
      .digest("hex");

    return {
      tenantId,
      generatedAt: now(),
      totalAssets,
      totalLiabilities,
      netEquity,
      accountCount: balanceLines.length,
      balanceHash,
      isSolvent,
    };
  }
}
