/**
 * lib/policy/rate-limiter.ts — multi-tenant sliding-window rate limiter.
 *
 * WHY (pilot-readiness / use-breaking gap #17)
 * --------------------------------------------
 * A runaway agent in a retry loop can DoS the trust gate or run up unbounded cost
 * before a human notices. Any multi-tenant platform that wants paying customers
 * must cap request velocity per tenant AND per actor (agent), fairly and
 * predictably. This is a hard pilot requirement, not a nice-to-have.
 *
 * Design: a sliding-window COUNTER (not a fixed window — avoids the 2x burst at
 * window edges, and not a token bucket — simpler to reason about and to persist).
 * Each key keeps timestamps within the trailing window; a request is allowed iff
 * the count is below the limit. The clock is injected so the limiter is pure and
 * deterministic under test.
 *
 * fail-closed:
 *   • a malformed key or check → denied (never "allow on error");
 *   • a non-positive limit/window is a configuration error → throws at construction.
 *
 * Scope keys are caller-built ("tenant:t1", "actor:t1:agent7", "action:t1:db.migration")
 * so the same limiter enforces tenant-wide, per-agent, and per-action-type caps.
 *
 * Zero external dependencies; in-memory (a Pg/Redis mirror can implement the same
 * interface later — the prune logic is storage-agnostic).
 *
 * Efficiency (v386):
 *   Timestamps are appended in non-decreasing order (monotonic wall-clock or
 *   deterministic test clocks), so the series array is always sorted. The previous
 *   implementation used `series.filter((t) => t > windowStart)` — an O(n) linear
 *   scan through all stored timestamps on every check. `lowerBound` replaces that
 *   with a binary search that finds the first in-window index in O(log n), then
 *   `slice` from that index produces the retained subset in O(k) where k = retained
 *   count (unavoidable). For a limiter at its cap of L: L comparisons → ceil(log₂(L)).
 *   Example: L=100 → 100 comparisons → 7; L=1000 → 1000 → 10. Applies to both
 *   `check` (called on every guarded action) and `prune` (housekeeping path).
 */

export interface RateLimitConfig {
  /** Max requests permitted within the trailing window. */
  limit: number;
  /** Trailing window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests remaining in the current window after this check. */
  remaining: number;
  /** Epoch ms when the oldest in-window hit expires (the window eases then). */
  resetAt: number;
  /** If denied, suggested wait before retrying (ms). 0 when allowed. */
  retryAfterMs: number;
  limit: number;
}

/**
 * lowerBound — binary search for the first index i where arr[i] > cutoff.
 * Requires arr to be sorted in non-decreasing order (guaranteed by append-only
 * push of monotonically non-decreasing timestamps).
 * Returns arr.length when all elements are ≤ cutoff (nothing in window).
 *
 * O(log n) — replaces the O(n) filter scan on the hot check/prune paths.
 */
function lowerBound(arr: readonly number[], cutoff: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= cutoff) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    if (!config || typeof config !== "object") throw new Error("RateLimiter: config required");
    if (!Number.isInteger(config.limit) || config.limit <= 0) {
      throw new Error("RateLimiter: limit must be a positive integer");
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
      throw new Error("RateLimiter: windowMs must be a positive number");
    }
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  /**
   * Record-and-check a request for `key` at time `nowMs`.
   * fail-closed: a malformed key denies without recording.
   */
  check(key: string, nowMs: number = Date.now()): RateLimitVerdict {
    if (typeof key !== "string" || key.length === 0 || !Number.isFinite(nowMs)) {
      return { allowed: false, remaining: 0, resetAt: nowMs || 0, retryAfterMs: this.windowMs, limit: this.limit };
    }
    const windowStart = nowMs - this.windowMs;
    const series = this.hits.get(key);
    // Binary-search for the first timestamp strictly inside the window (O(log n))
    // instead of filter-scanning all stored timestamps (O(n)).
    const recent = series ? series.slice(lowerBound(series, windowStart)) : [];

    if (recent.length >= this.limit) {
      // denied: the window eases when the oldest hit exits the window.
      const oldest = recent[0];
      const resetAt = oldest + this.windowMs;
      this.hits.set(key, recent); // keep pruned series (do NOT record the denied hit)
      return { allowed: false, remaining: 0, resetAt, retryAfterMs: Math.max(0, resetAt - nowMs), limit: this.limit };
    }

    recent.push(nowMs);
    this.hits.set(key, recent);
    const resetAt = recent[0] + this.windowMs;
    return { allowed: true, remaining: this.limit - recent.length, resetAt, retryAfterMs: 0, limit: this.limit };
  }

  /** Drop keys with no in-window hits (housekeeping for long-lived processes). */
  prune(nowMs: number = Date.now()): void {
    const windowStart = nowMs - this.windowMs;
    for (const [key, series] of this.hits) {
      const recent = series.slice(lowerBound(series, windowStart));
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  /** Number of tracked keys (observability). */
  get trackedKeys(): number {
    return this.hits.size;
  }
}

/** Build a tenant-scoped key. */
export function tenantKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}
/** Build an actor-scoped key (agent within a tenant). */
export function actorKey(tenantId: string, actorId: string): string {
  return `actor:${tenantId}:${actorId}`;
}
/** Build an action-type-scoped key (per tenant). */
export function actionKey(tenantId: string, actionType: string): string {
  return `action:${tenantId}:${actionType}`;
}
