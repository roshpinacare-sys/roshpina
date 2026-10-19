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
  TenantModel,
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

  // Tenant accounting model ("custodial" default; "mirror" = settlement
  // mirror of another book — see TenantModel docs in types.ts). Declared by
  // the service wiring at boot (operator acknowledgment), never inferred.
  private readonly tenantModels = new Map<string, TenantModel>();

  /**
   * P1-RESTORE (2026-10-17, agent4/p1-ledger-persistence): trusted-state factory.
   * Builds a live ledger from data that the CALLER has already verified
   * (journal hash-chain + per-tx conservation checks run before this is
   * invoked — see persistent-ledger.ts). No guards are re-run here by design:
   * this is the recovery path, not a user-input path. All downstream behaviour
   * (getAccount/transfer/proofOfSolvency/…) is the proven live code — zero
   * duplicated state handling.
   */
  static restore(state: {
    accounts: Account[];
    entries: JournalEntry[]; // flat; grouped by accountId internally
    transactions: LedgerTransaction[]; // flat; grouped by tenantId internally
  }): InMemoryLedger {
    const led = new InMemoryLedger();
    for (const account of state.accounts) {
      if (led.accounts.has(account.id)) {
        throw new LedgerError(`restore: duplicate account ${account.id}`, "RESTORE_DUPLICATE");
      }
      led.accounts.set(account.id, account);
      // The reserve is the EQUITY account — not merely any system-owned one.
      // Economy ops (staking, Task 11) create system-owned *asset* accounts too;
      // keying on ownerId alone let the LAST system account hijack the reserve
      // slot on restart → the next mint would debit a stranger's stake account
      // (latent corruption, first-wins + type-keyed is the honest identity).
      if (account.type === "equity" && !led.reserveAccounts.has(account.tenantId)) {
        led.reserveAccounts.set(account.tenantId, account.id);
      }
    }
    for (const entry of state.entries) {
      const list = led.entries.get(entry.accountId) ?? [];
      list.push(entry);
      led.entries.set(entry.accountId, list);
    }
    for (const tx of state.transactions) {
      const list = led.transactions.get(tx.tenantId) ?? [];
      list.push(tx);
      led.transactions.set(tx.tenantId, list);
    }
    return led;
  }

  /**
   * P1-EXPORT: trusted-state export (the mirror of restore). The caller is
   * responsible for journaling/verifying what it exports — used by the
   * persistence layer for snapshots and journal folds.
   */
  exportState(): {
    accounts: Account[];
    entries: JournalEntry[];
    transactions: LedgerTransaction[];
  } {
    const entries: JournalEntry[] = [];
    for (const list of this.entries.values()) entries.push(...list);
    const transactions: LedgerTransaction[] = [];
    for (const list of this.transactions.values()) transactions.push(...list);
    return { accounts: [...this.accounts.values()], entries, transactions };
  }

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
   * Declare the accounting model of a tenant (operator/boot acknowledgment —
   * the default is "custodial"). Mirror tenants (settlement mirrors of the
   * live market) are judged by the mirror law in proofOfSolvency.
   */
  declareTenantModel(tenantId: string, model: TenantModel): void {
    guardNonEmpty(tenantId, "tenantId");
    if (model !== "custodial" && model !== "mirror") {
      throw new LedgerError(`unknown tenant model ${String(model)}`, "INVALID_TENANT_MODEL");
    }
    this.tenantModels.set(tenantId, model);
  }

  tenantModel(tenantId: string): TenantModel {
    return this.tenantModels.get(tenantId) ?? "custodial";
  }

  /**
   * proofOfSolvency — periodic integrity check.
   * Custodial tenants: verifies sum(assets) >= sum(liabilities).
   * Mirror tenants: verifies zero-sum integrity + no negative claims/backing.
   * Produces a tamper-evident SHA-256 fingerprint of all current balances.
   */
  async proofOfSolvency(tenantId: string): Promise<SolvencyProof> {
    guardNonEmpty(tenantId, "tenantId");

    const model = this.tenantModel(tenantId);
    const balanceLines: string[] = [];
    let totalAssets = 0n;
    let totalLiabilities = 0n;
    let sumAll = 0n;
    let negativeLiability = false;
    let negativeAsset = false;

    // Single pass: filter, build lines, accumulate totals.
    // Sort only the string lines (cheaper than sorting Account objects).
    for (const acc of this.accounts.values()) {
      if (acc.tenantId !== tenantId) continue;
      balanceLines.push(`${acc.id}:${acc.type}:${acc.balance}`);
      if (acc.type === "asset") {
        totalAssets += acc.balance;
        if (acc.balance < 0n) negativeAsset = true;
      } else if (acc.type === "liability") {
        totalLiabilities += acc.balance;
        if (acc.balance < 0n) negativeLiability = true;
      }
      // equity/revenue/expense carry the plug and signed era history — they
      // count toward zero-sum integrity, not toward the custodial law.
      sumAll += acc.balance;
    }

    balanceLines.sort((a, b) => a.localeCompare(b));

    const netEquity = totalAssets - totalLiabilities;
    // Custodial law: can the vault pay its depositors.
    // Mirror law: zero-sum integrity + no negative claims + no invented backing.
    const isSolvent =
      model === "mirror"
        ? sumAll === 0n && !negativeLiability && !negativeAsset
        : netEquity >= 0n;

    const balanceHash = createHash("sha256")
      .update(balanceLines.join("\n"))
      .digest("hex");

    return {
      tenantId,
      model,
      generatedAt: now(),
      totalAssets,
      totalLiabilities,
      netEquity,
      sumAll,
      accountCount: balanceLines.length,
      balanceHash,
      isSolvent,
    };
  }
}
