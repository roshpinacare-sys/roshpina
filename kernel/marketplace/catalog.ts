/**
 * lib/marketplace/catalog.ts — InMemoryOpportunityCatalog.
 *
 * Tenant-isolated, zero-dependency implementation of OpportunityCatalog.
 * Backed by a Map<tenantId, Map<id, Opportunity>>.
 *
 * Validation (fail-closed):
 *   • missing tenantId   → MarketplaceError("missing_tenant_id")
 *   • missing / blank title → MarketplaceError("missing_title")
 *   • duplicate id       → MarketplaceError("duplicate_id")
 *   • requiredStrength.minScore not 0–100 → MarketplaceError("invalid_min_score")
 *   • requiredStrength.category blank      → MarketplaceError("invalid_required_strength")
 *
 * Tenant isolation invariant:
 *   No code path returns an Opportunity whose tenantId ≠ the requested tenantId.
 */

import { randomUUID } from "node:crypto";
import type { Opportunity } from "../potential/types";
import {
  MarketplaceError,
  type OpportunityCatalog,
  type OpportunityInput,
} from "./types";

export class InMemoryOpportunityCatalog implements OpportunityCatalog {
  /** tenantId → (id → Opportunity) */
  private store = new Map<string, Map<string, Opportunity>>();

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: OpportunityInput): Promise<Opportunity> {
    if (!input.tenantId || typeof input.tenantId !== "string" || !input.tenantId.trim()) {
      throw new MarketplaceError("tenantId is required", "missing_tenant_id");
    }
    if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
      throw new MarketplaceError("title is required", "missing_title");
    }

    const requiredStrengths = (input.requiredStrengths ?? []).map((rs) => {
      if (!rs.category || typeof rs.category !== "string" || !rs.category.trim()) {
        throw new MarketplaceError(
          "requiredStrength.category must be a non-empty string",
          "invalid_required_strength",
        );
      }
      if (
        typeof rs.minScore !== "number" ||
        isNaN(rs.minScore) ||
        rs.minScore < 0 ||
        rs.minScore > 100
      ) {
        throw new MarketplaceError(
          `requiredStrength.minScore must be 0–100, got ${rs.minScore}`,
          "invalid_min_score",
        );
      }
      return { category: rs.category.trim(), minScore: rs.minScore };
    });

    const id = input.id ?? randomUUID();
    const tenantBucket = this.tenantBucket(input.tenantId);

    if (tenantBucket.has(id)) {
      throw new MarketplaceError(
        `Opportunity with id "${id}" already exists in tenant "${input.tenantId}"`,
        "duplicate_id",
      );
    }

    const opportunity: Opportunity = {
      id,
      tenantId: input.tenantId,
      title: input.title.trim(),
      description: (input.description ?? "").trim(),
      requiredStrengths,
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
    };

    tenantBucket.set(id, opportunity);
    return Promise.resolve(opportunity);
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(tenantId: string): Promise<Opportunity[]> {
    if (!tenantId) return Promise.resolve([]);
    const bucket = this.store.get(tenantId);
    if (!bucket) return Promise.resolve([]);
    return Promise.resolve(Array.from(bucket.values()));
  }

  // ── get ───────────────────────────────────────────────────────────────────

  async get(tenantId: string, id: string): Promise<Opportunity | null> {
    if (!tenantId || !id) return Promise.resolve(null);
    return Promise.resolve(this.store.get(tenantId)?.get(id) ?? null);
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!tenantId || !id) return Promise.resolve(false);
    const bucket = this.store.get(tenantId);
    if (!bucket) return Promise.resolve(false);
    return Promise.resolve(bucket.delete(id));
  }

  // ── totalCount ────────────────────────────────────────────────────────────

  async totalCount(): Promise<number> {
    let n = 0;
    for (const bucket of this.store.values()) n += bucket.size;
    return Promise.resolve(n);
  }

  // ── private ───────────────────────────────────────────────────────────────

  private tenantBucket(tenantId: string): Map<string, Opportunity> {
    let bucket = this.store.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.store.set(tenantId, bucket);
    }
    return bucket;
  }
}
