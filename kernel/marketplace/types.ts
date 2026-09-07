/**
 * lib/marketplace/types.ts — TFA Marketplace: opportunity catalog types.
 *
 * The marketplace is the bridge between the PotentialEngine (who matches users
 * to opportunities) and a persistent, tenant-scoped opportunity catalog. It is
 * intentionally a thin CRUD layer — matching logic lives in OpportunityRouter.
 *
 * "שלב E" rules:
 *   • Every opportunity is scoped to a tenantId (no cross-tenant leakage).
 *   • Listing returns only opportunities owned by the requesting tenant.
 *   • Creating / deleting requires a valid tenantId (fail-closed on missing).
 *   • Monetary integration (listing fee, claiming fee) is a later sub-step.
 *
 * Zero external dependencies.
 */

import type { Opportunity } from "../potential/types";

// ─── Action types (for guard allowlist) ──────────────────────────────────────

/**
 * Canonical action-type strings for marketplace operations.
 * Add these to your guard policy allowlist alongside LEDGER_ACTION_TYPES
 * and POTENTIAL_ACTION_TYPES so marketplace calls pass the audit spine.
 */
export const MARKETPLACE_ACTION_TYPES = {
  CREATE:  "marketplace.create",
  LIST:    "marketplace.list",
  DELETE:  "marketplace.delete",
  ROUTE:   "marketplace.route",
  CLAIM:   "marketplace.claim",
} as const;

export type MarketplaceActionType =
  (typeof MARKETPLACE_ACTION_TYPES)[keyof typeof MARKETPLACE_ACTION_TYPES];

/**
 * Default claim fee in μ¢ (micro-cents).
 * 10,000 μ¢ = 0.10 USD (10 cents).
 * Callers may override by supplying a `claimFee` in the request body.
 */
export const DEFAULT_CLAIM_FEE_MC = 10_000n;

/**
 * Default listing fee in μ¢ (micro-cents).
 * 5,000 μ¢ = 0.05 USD (5 cents).
 * A tenant pays this when publishing an opportunity in the catalog.
 * Callers may override by supplying a `listingFee` in the request body.
 * Pass 0 to list for free (must be explicit — not the default).
 */
export const DEFAULT_LISTING_FEE_MC = 5_000n;

// ─── Catalog interface ────────────────────────────────────────────────────────

/**
 * OpportunityCatalog — the tenant-scoped store for Opportunity records.
 *
 * All mutations are synchronous / in-memory by default (InMemoryOpportunityCatalog).
 * A production implementation would delegate to a database table.
 */
export interface OpportunityCatalog {
  /**
   * Persist a new opportunity. Assigns `id` and stores under the tenant.
   * Returns the created Opportunity (with the generated id).
   * Throws MarketplaceError("duplicate_id") if the id already exists.
   */
  create(input: OpportunityInput): Promise<Opportunity>;

  /**
   * Return all opportunities for a given tenant.
   * Never leaks to other tenants.
   */
  list(tenantId: string): Promise<Opportunity[]>;

  /**
   * Retrieve a single opportunity by id within a tenant.
   * Returns null if not found or belongs to a different tenant.
   */
  get(tenantId: string, id: string): Promise<Opportunity | null>;

  /**
   * Remove an opportunity by id within a tenant.
   * Returns true if deleted, false if not found.
   * Fail-closed: deleting another tenant's opportunity returns false (not an error).
   */
  delete(tenantId: string, id: string): Promise<boolean>;

  /** Number of opportunities across all tenants (for audit / solvency purposes). */
  totalCount(): Promise<number>;
}

// ─── Input / output types ────────────────────────────────────────────────────

/**
 * Fields required to create a new opportunity.
 * `id` is optional — the catalog generates one if omitted (UUID).
 */
export interface OpportunityInput {
  /** Caller-supplied id — useful for deterministic tests. Defaults to UUID. */
  id?: string;
  tenantId: string;
  title: string;
  description: string;
  requiredStrengths?: Array<{ category: string; minScore: number }>;
  /**
   * Optional budget in μ¢ (BigInt). When provided, a claim on this opportunity
   * automatically creates + funds an escrow agreement. The claim body must include
   * `payerAccountId` and `workerAccountId` for escrow wiring.
   */
  budget?: bigint;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type MarketplaceErrorCode =
  | "missing_tenant_id"
  | "missing_title"
  | "duplicate_id"
  | "invalid_min_score"   // minScore must be 0–100
  | "invalid_required_strength"; // category must be a non-empty string

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  constructor(message: string, code: MarketplaceErrorCode) {
    super(message);
    this.name = "MarketplaceError";
    this.code = code;
  }
}
