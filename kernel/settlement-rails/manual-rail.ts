/**
 * lib/settlement-rails/manual-rail.ts — ManualSettlementRail + InMemoryRailRegistry.
 *
 * ManualSettlementRail
 * --------------------
 * The default stub rail. It records every disbursement request in memory and
 * immediately returns `status: "succeeded"` (or `"skipped"` for zero-amount).
 *
 * Use cases:
 *   • Dev / test environments — no external network needed.
 *   • Proof-of-concept deployments where human review replaces automated disbursement.
 *   • CI — deterministic, instant, no mocking required.
 *
 * Failure simulation: set `ManualRailConfig.failMode = true` to make all disburse()
 * calls return `status: "failed"`. Useful for testing error handling in callers.
 *
 * InMemoryRailRegistry
 * --------------------
 * Simple per-tenant rail registry backed by a Map. Thread-safe for Node.js
 * single-threaded use. Use `register("*", rail)` to set the platform default.
 *
 * Zero external dependencies.
 */

import type {
  DisbursementRequest,
  DisbursementResult,
  DisbursementStatus,
  RailRegistry,
  SettlementRail,
} from "./types";
import { SettlementRailError } from "./types";

// ─── ManualSettlementRail ─────────────────────────────────────────────────────

export interface ManualRailConfig {
  /**
   * When true, all disburse() calls return `status: "failed"` (for error-path testing).
   * Default: false.
   */
  failMode?: boolean;
  /**
   * Optional label added to every disbursement's `message` field.
   * Useful when multiple manual rails are registered (e.g. "tenant-A-manual").
   */
  label?: string;
}

/**
 * A single completed disbursement record (in-memory audit log).
 * Accessible via `ManualSettlementRail.getDisbursements()` in tests.
 */
export interface ManualDisbursementRecord {
  readonly request: DisbursementRequest;
  readonly result: DisbursementResult;
}

export class ManualSettlementRail implements SettlementRail {
  readonly railId: string;
  private readonly config: ManualRailConfig;
  private readonly _records = new Map<string, ManualDisbursementRecord>();

  constructor(config: ManualRailConfig = {}, railId = "manual") {
    this.railId = railId;
    this.config = config;
  }

  async disburse(request: DisbursementRequest): Promise<DisbursementResult> {
    // ── Input validation (fail-closed) ────────────────────────────────────
    if (typeof request.amountMicrounits !== "bigint") {
      throw new SettlementRailError(
        "invalid_amount",
        "amountMicrounits must be a BigInt",
        this.railId,
      );
    }
    if (request.amountMicrounits < 0n) {
      throw new SettlementRailError(
        "invalid_amount",
        "amountMicrounits must be ≥ 0",
        this.railId,
      );
    }
    if (!request.payeeId || request.payeeId.trim().length === 0) {
      throw new SettlementRailError(
        "invalid_payee",
        "payeeId must be a non-empty string",
        this.railId,
      );
    }
    if (!request.currency || request.currency.trim().length === 0) {
      throw new SettlementRailError(
        "invalid_currency",
        "currency must be a non-empty ISO 4217 code",
        this.railId,
      );
    }

    // ── Idempotency: return existing result if key already processed ──────
    const existing = this._records.get(request.idempotencyKey);
    if (existing) {
      return existing.result;
    }

    const processedAt = new Date().toISOString();
    const label = this.config.label ? ` [${this.config.label}]` : "";

    // ── Zero-amount → skipped ─────────────────────────────────────────────
    if (request.amountMicrounits === 0n) {
      const result: DisbursementResult = {
        idempotencyKey: request.idempotencyKey,
        status: "skipped",
        externalRef: null,
        processedAt,
        message: `ManualRail${label}: zero-amount disbursement skipped`,
        providerResponse: { reason: "zero_amount" },
      };
      this._records.set(request.idempotencyKey, { request, result });
      return result;
    }

    // ── Fail mode (test harness) ──────────────────────────────────────────
    if (this.config.failMode) {
      const result: DisbursementResult = {
        idempotencyKey: request.idempotencyKey,
        status: "failed",
        externalRef: null,
        processedAt,
        message: `ManualRail${label}: failMode=true — disbursement rejected`,
        providerResponse: { reason: "fail_mode" },
      };
      this._records.set(request.idempotencyKey, { request, result });
      return result;
    }

    // ── Happy path: record and succeed immediately ─────────────────────────
    const externalRef = `manual:${request.idempotencyKey}`;
    const result: DisbursementResult = {
      idempotencyKey: request.idempotencyKey,
      status: "succeeded",
      externalRef,
      processedAt,
      message: `ManualRail${label}: disbursed ${request.amountMicrounits}μ¢ to ${request.payeeId}`,
      providerResponse: {
        railId: this.railId,
        settlementId: request.settlementId,
        tenantId: request.tenantId,
        payeeId: request.payeeId,
        amountMicrounits: String(request.amountMicrounits),
        currency: request.currency,
      },
    };
    this._records.set(request.idempotencyKey, { request, result });
    return result;
  }

  async getStatus(idempotencyKey: string): Promise<DisbursementResult | null> {
    return this._records.get(idempotencyKey)?.result ?? null;
  }

  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    return this.config.failMode
      ? { ok: false, reason: "failMode=true" }
      : { ok: true };
  }

  // ── Test / admin helpers ─────────────────────────────────────────────────

  /** All disbursements recorded by this rail (newest first). */
  getDisbursements(): ManualDisbursementRecord[] {
    return Array.from(this._records.values()).reverse();
  }

  /** How many disbursements have been recorded. */
  get size(): number {
    return this._records.size;
  }

  /** Reset the in-memory log (useful between tests). */
  reset(): void {
    this._records.clear();
  }
}

// ─── InMemoryRailRegistry ────────────────────────────────────────────────────

/**
 * InMemoryRailRegistry — per-tenant rail lookup backed by a plain Map.
 *
 * Lookup order:
 *   1. Exact tenant match (`tenantId`).
 *   2. Platform default (`"*"`).
 *   3. `null` — no rail configured (caller decides whether to skip or error).
 *
 * Use `register("*", rail)` to set the platform-wide default.
 */
export class InMemoryRailRegistry implements RailRegistry {
  private readonly _registry = new Map<string, SettlementRail>();

  register(tenantId: string, rail: SettlementRail): void {
    if (!tenantId || tenantId.trim().length === 0) {
      throw new SettlementRailError(
        "invalid_payee",
        "tenantId must be a non-empty string (or '*' for platform default)",
        rail.railId,
      );
    }
    this._registry.set(tenantId, rail);
  }

  getRail(tenantId: string): SettlementRail | null {
    return (
      this._registry.get(tenantId) ??
      this._registry.get("*") ??
      null
    );
  }

  listTenants(): string[] {
    return Array.from(this._registry.keys());
  }
}
