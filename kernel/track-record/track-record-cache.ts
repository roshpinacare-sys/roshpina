/**
 * lib/track-record/track-record-cache.ts — TrackRecordCache interface + InMemory implementation.
 *
 * PURPOSE
 * -------
 * Cache the result of computeTrackRecord so repeated reads are O(1) instead of O(chain).
 * Invalidation is triggered on escrow state-changes (fund/release/refund/dispute/undispute)
 * because the track record is derived from escrow outcomes + audit chain.
 *
 * CONTRACT
 * --------
 * • get() returns a previously-set record or null.
 * • set() stores a computed record with a fresh computedAt timestamp.
 * • invalidate() drops one identity's cached record.
 * • invalidateTenant() drops every record for a tenant (e.g. bulk invalidation).
 * • Tenant isolation is enforced: cross-tenant get/set never leaks.
 */
import type { TrackRecord, ChainReader, EscrowReader, TrackRecordOptions } from "./track-record";

export interface TrackRecordCache {
  get(tenantId: string, identityId: string): Promise<TrackRecord | null>;
  set(tenantId: string, identityId: string, record: TrackRecord): Promise<void>;
  invalidate(tenantId: string, identityId: string): Promise<void>;
  invalidateTenant(tenantId: string): Promise<void>;
}

/** In-memory cache for tests and local dev. Zero external dependencies. */
export class InMemoryTrackRecordCache implements TrackRecordCache {
  private readonly data = new Map<string, TrackRecord>();

  private key(tenantId: string, identityId: string): string {
    return `${tenantId}::${identityId}`;
  }

  async get(tenantId: string, identityId: string): Promise<TrackRecord | null> {
    if (!tenantId || !identityId) return null;
    return this.data.get(this.key(tenantId, identityId)) ?? null;
  }

  async set(tenantId: string, identityId: string, record: TrackRecord): Promise<void> {
    if (!tenantId || !identityId) return;
    this.data.set(this.key(tenantId, identityId), record);
  }

  async invalidate(tenantId: string, identityId: string): Promise<void> {
    if (!tenantId || !identityId) return;
    this.data.delete(this.key(tenantId, identityId));
  }

  async invalidateTenant(tenantId: string): Promise<void> {
    if (!tenantId) return;
    const prefix = `${tenantId}::`;
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) this.data.delete(k);
    }
  }
}

/**
 * getCachedOrCompute — convenience helper.
 * If the cache has a hit, return it. Otherwise compute via computeTrackRecord,
 * store in cache, and return.
 */
export async function getCachedOrCompute(
  cache: TrackRecordCache | undefined,
  chain: ChainReader,
  escrows: EscrowReader,
  tenantId: string,
  identityId: string,
  opts: TrackRecordOptions = {},
): Promise<TrackRecord> {
  const { computeTrackRecord } = await import("./track-record");
  if (cache) {
    const hit = await cache.get(tenantId, identityId);
    if (hit) return hit;
  }
  const record = await computeTrackRecord(chain, escrows, tenantId, identityId, opts);
  if (cache) {
    await cache.set(tenantId, identityId, record);
  }
  return record;
}
