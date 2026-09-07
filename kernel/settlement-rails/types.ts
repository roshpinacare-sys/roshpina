/**
 * lib/settlement-rails/types.ts — SettlementRail interface.
 *
 * WHY THIS EXISTS
 * ---------------
 * TFA's SettlementService manages the *state machine* (created → held → released)
 * and the *internal ledger* (BigInt μ¢ transfers through LedgerOrchestrator).
 * But the *external disbursement* — actually moving money out to a payee — is
 * provider-specific: manual/stub (dev/test), Stripe payout, stablecoin transfer,
 * bank wire, etc.
 *
 * `SettlementRail` is the seam between TFA's trust-and-audit plane and the
 * external payment network. One rail per tenant (or a shared default). The
 * composition root wires the rail; no core logic touches provider SDKs.
 *
 * DESIGN INVARIANTS
 * -----------------
 * • BigInt μ¢ (micro-cents) everywhere — NO floats.
 * • Every disbursement returns a `DisbursementResult` with a stable `externalRef`
 *   so TFA can cross-reference the payment in settlement records and audit logs.
 * • fail-closed: an unknown / unsupported disbursement throws `SettlementRailError`.
 * • Idempotency: callers MAY retry with the same `idempotencyKey`; a rail SHOULD
 *   return the same `externalRef` for a repeated key (best-effort; not a hard contract).
 * • Zero external dependencies in this file (pure interface).
 *
 * EXTENSION GUIDE
 * ---------------
 * To add a new rail: (1) implement `SettlementRail` in a new file; (2) register it
 * in `composition.ts` under `railRegistry`; (3) add tests. No core code changes.
 */

// ─── Money types ─────────────────────────────────────────────────────────────

/** Amount in micro-cents (μ¢). MUST be BigInt — never a float. */
export type MicroCents = bigint;

// ─── Disbursement request ────────────────────────────────────────────────────

/**
 * DisbursementRequest — everything a rail needs to disburse funds to a payee.
 *
 * The rail is NOT responsible for ledger accounting — that is already done by
 * SettlementService before this is called. The rail's sole job is to instruct
 * an external system to move money from the platform's holding account to the
 * payee.
 */
export interface DisbursementRequest {
  /** Stable idempotency key (e.g. `${tenantId}:${settlementId}:${releaseSeq}`). */
  readonly idempotencyKey: string;
  /** TFA tenant id — for logging and per-tenant rail lookup. */
  readonly tenantId: string;
  /** TFA settlement agreement id — for cross-referencing. */
  readonly settlementId: string;
  /**
   * Payee identifier. Format is rail-specific:
   *   manual: any string (logged only)
   *   stripe: Stripe Connect account id (acct_xxx)
   *   crypto: wallet address
   *   bank:   account number + routing (encoded as a string)
   */
  readonly payeeId: string;
  /** Amount to disburse in μ¢ (micro-cents). MUST be > 0. */
  readonly amountMicrounits: MicroCents;
  /** ISO 4217 currency code. Default "USD". */
  readonly currency: string;
  /** Human-readable description for the payee's bank / wallet statement. */
  readonly description: string;
  /**
   * Metadata bag passed to the external provider verbatim (rail-specific).
   * May be undefined; callers must not rely on its presence.
   */
  readonly metadata?: Record<string, string>;
}

// ─── Disbursement result ─────────────────────────────────────────────────────

/** Terminal state of a disbursement. */
export type DisbursementStatus =
  | "succeeded"   // money confirmed received by external network
  | "pending"     // submitted; awaiting external confirmation (async rails)
  | "failed"      // rail rejected the request; NOT retryable without fixing the cause
  | "skipped";    // rail intentionally did nothing (e.g. zero amount, dry-run mode)

export interface DisbursementResult {
  /** The idempotencyKey from the request (returned for correlation). */
  readonly idempotencyKey: string;
  /** Final or intermediate status. */
  readonly status: DisbursementStatus;
  /**
   * Stable external reference from the payment network (e.g. Stripe transfer id,
   * blockchain tx hash, bank reference number). Present for succeeded/pending.
   * MAY be the idempotencyKey itself for manual/stub rails.
   */
  readonly externalRef: string | null;
  /** ISO 8601 timestamp when the rail processed this request. */
  readonly processedAt: string;
  /** Rail-specific message (success note, failure reason, or skip rationale). */
  readonly message: string;
  /**
   * Provider-specific raw response (for audit / debugging).
   * MUST NOT contain PII or credentials. Stored in audit log.
   */
  readonly providerResponse?: Record<string, unknown>;
}

// ─── Rail interface ──────────────────────────────────────────────────────────

/**
 * SettlementRail — the single extension point for external disbursement.
 *
 * Implementations MUST:
 *   • Accept BigInt μ¢ amounts.
 *   • Throw `SettlementRailError` (not generic Error) for domain failures.
 *   • Be idempotent on repeated calls with the same `idempotencyKey`.
 *   • Never mutate the `DisbursementRequest` object.
 *   • Never block indefinitely — set timeouts internally.
 */
export interface SettlementRail {
  /** Stable identifier for this rail implementation (e.g. "manual", "stripe"). */
  readonly railId: string;

  /**
   * Disburse funds to the payee identified in `request`.
   * This is called AFTER the internal ledger transfer has been committed.
   * Throws `SettlementRailError` on fatal configuration or input errors.
   * Returns `{ status: "failed" }` for transient network errors so the caller
   * can log and decide whether to retry.
   */
  disburse(request: DisbursementRequest): Promise<DisbursementResult>;

  /**
   * Look up the status of a previously submitted disbursement by idempotencyKey.
   * Returns `null` if the key is unknown to this rail.
   * Useful for async rails (bank wire, stablecoin) where `disburse` returns "pending".
   */
  getStatus(idempotencyKey: string): Promise<DisbursementResult | null>;

  /**
   * Optional health check — verify the rail is configured and reachable.
   * Returns `{ ok: true }` if healthy, `{ ok: false, reason: string }` otherwise.
   * If not implemented, the rail is assumed always healthy.
   */
  healthCheck?(): Promise<{ ok: boolean; reason?: string }>;
}

// ─── Error type ───────────────────────────────────────────────────────────────

/** Error codes for SettlementRailError. */
export type SettlementRailErrorCode =
  | "invalid_amount"        // amountMicrounits ≤ 0 or not a BigInt
  | "invalid_payee"         // payeeId empty or malformed for this rail
  | "invalid_currency"      // currency not supported by this rail
  | "not_configured"        // rail missing required config (API key, etc.)
  | "provider_error"        // external provider returned an unrecoverable error
  | "unsupported_operation" // operation not supported by this rail
  | "timeout";              // rail call exceeded its internal timeout

export class SettlementRailError extends Error {
  readonly code: SettlementRailErrorCode;
  readonly railId: string;
  constructor(code: SettlementRailErrorCode, message: string, railId: string) {
    super(`[rail:${railId}] ${code}: ${message}`);
    this.name = "SettlementRailError";
    this.code = code;
    this.railId = railId;
  }
}

// ─── Registry types ──────────────────────────────────────────────────────────

/**
 * RailRegistry — per-tenant rail lookup.
 *
 * A tenant may have a custom rail (e.g. their own Stripe account), otherwise
 * falls back to the platform default. Returns `null` if neither is configured.
 */
export interface RailRegistry {
  /** Get the rail for a specific tenant, or the default, or null. */
  getRail(tenantId: string): SettlementRail | null;
  /** Register a rail for a specific tenant (or as the default with tenantId="*"). */
  register(tenantId: string, rail: SettlementRail): void;
  /** List all registered tenant ids (and "*" if a default is registered). */
  listTenants(): string[];
}
