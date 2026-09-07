/**
 * lib/ledger — barrel export.
 * Services import from here; never from individual files directly.
 *
 * @example
 * ```ts
 * import { InMemoryLedger, LedgerError } from "../../lib/ledger/index";
 * import type { PaymentProvider, MicroCents, Account } from "../../lib/ledger/index";
 * ```
 */

export type {
  Account,
  AccountType,
  EntryType,
  JournalEntry,
  LedgerTransaction,
  MicroCents,
  PaymentProvider,
  SolvencyProof,
  TransactionKind,
} from "./types";

export { InMemoryLedger, LedgerError } from "./in-memory-ledger";
