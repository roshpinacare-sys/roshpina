/**
 * lib/policy/spend-budget-guard.ts — cumulative spend cap (runaway-cost protection).
 *
 * THE PROBLEM THIS SOLVES (a real, expensive, unmet need)
 * ------------------------------------------------------
 * Per-action value thresholds (approvalPolicyRouter's valueEscalationThreshold)
 * stop ONE big action. They do NOT stop a runaway agent making thousands of
 * individually-small actions whose SUM is enormous — the exact pattern behind
 * the surprise five-figure API/agent bills people get from a loop gone wrong or
 * a mispriced call. No vendor offers a neutral, cross-vendor cumulative spend
 * cap, because a vendor billing for usage has no incentive to cap it.
 *
 * TFA is positioned to be that neutral guard: it already sits in front of every
 * value-bearing action with a signed ActionIntent carrying valueMicrounits.
 *
 * WHAT THIS IS
 * ------------
 * A deterministic, tenant-scoped, rolling-window cumulative spend tracker that
 * answers BEFORE execution: "does this pending action fit the remaining budget?"
 * If not, it denies (fail-closed) and reports the exact overage — turning a
 * silent runaway charge into a blocked, auditable event.
 *
 * DESIGN (mirrors the repo's established patterns)
 * -----------------------------------------------
 * • Money is BigInt micro-cents (MicroCents). $1.00 = 100_000n μ¢. Never float.
 * • Rolling window with injected nowMs (deterministic, testable) — spend ages
 *   out, so an hourly/daily budget resets naturally without a cron.
 * • Pre-authorize → record: `authorize()` is a pure check; `commit()` records a
 *   spend only after the action actually happened. (Two-phase, so a denied or
 *   failed action never inflates the running total.)
 * • Tenant isolation: every entry is keyed by tenantId; one tenant's spend can
 *   never count against another's budget.
 * • FAIL-CLOSED: unknown budget → deny; negative/invalid amount → throw; an
 *   amount that would exceed budget → deny with exact overage.
 * • Zero external dependencies.
 */

import type { MicroCents } from "../ledger/types";

/** A spend that has been committed within a window. */
interface SpendEntry {
  atMs: number;
  amount: MicroCents;
}

/** Configuration for one tenant's budget. */
export interface SpendBudgetConfig {
  /** Maximum cumulative spend allowed within the window (μ¢, > 0). */
  limitMicroCents: MicroCents;
  /** Rolling window length in milliseconds (> 0). */
  windowMs: number;
}

/** The verdict of a pre-authorization check. */
export interface SpendAuthorization {
  /** True iff the pending amount fits within the remaining budget. */
  allowed: boolean;
  /** Spend already committed within the current window (μ¢). */
  spentMicroCents: MicroCents;
  /** Budget remaining BEFORE this action (μ¢, never negative). */
  remainingMicroCents: MicroCents;
  /** The pending amount that was checked (μ¢). */
  pendingMicroCents: MicroCents;
  /** If denied, how far over budget the action would push (μ¢, > 0); else 0n. */
  overageMicroCents: MicroCents;
  /** The configured limit (μ¢). */
  limitMicroCents: MicroCents;
}

function assertAmount(amount: unknown, label: string): MicroCents {
  if (typeof amount !== "bigint") {
    throw new SpendBudgetError("INVALID_AMOUNT", `${label} must be a BigInt (micro-cents)`);
  }
  if (amount < 0n) {
    throw new SpendBudgetError("INVALID_AMOUNT", `${label} must not be negative`);
  }
  return amount;
}

/**
 * Cumulative spend guard. One instance tracks many tenants; each tenant carries
 * its own budget config. Storage-agnostic (in-memory here; the same shape ports
 * to a durable store behind the same interface).
 */
export class SpendBudgetGuard {
  private readonly budgets = new Map<string, SpendBudgetConfig>();
  private readonly spend = new Map<string, SpendEntry[]>();

  /** Register or replace a tenant's budget. Fail-closed: invalid config throws. */
  setBudget(tenantId: string, config: SpendBudgetConfig): void {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new SpendBudgetError("INVALID_TENANT", "tenantId must be a non-empty string");
    }
    const limit = assertAmount(config?.limitMicroCents, "limitMicroCents");
    if (limit <= 0n) {
      throw new SpendBudgetError("INVALID_CONFIG", "limitMicroCents must be > 0");
    }
    if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
      throw new SpendBudgetError("INVALID_CONFIG", "windowMs must be a positive number");
    }
    this.budgets.set(tenantId, { limitMicroCents: limit, windowMs: config.windowMs });
  }

  /** Sum of spend still inside the window for a tenant (prunes aged entries). */
  private spentWithinWindow(tenantId: string, nowMs: number, windowMs: number): MicroCents {
    const entries = this.spend.get(tenantId);
    if (!entries || entries.length === 0) return 0n;
    const windowStart = nowMs - windowMs;
    // Entries are appended in non-decreasing atMs order; drop the aged prefix.
    let firstFresh = 0;
    while (firstFresh < entries.length && entries[firstFresh].atMs <= windowStart) {
      firstFresh++;
    }
    if (firstFresh > 0) entries.splice(0, firstFresh);
    let total = 0n;
    for (const e of entries) total += e.amount;
    return total;
  }

  /**
   * Pre-authorize a pending spend WITHOUT recording it. Pure check.
   * Fail-closed: no budget for the tenant → denied (not allowed by default).
   */
  authorize(tenantId: string, pendingMicroCents: MicroCents, nowMs: number): SpendAuthorization {
    const pending = assertAmount(pendingMicroCents, "pendingMicroCents");
    const budget = this.budgets.get(tenantId);
    if (!budget) {
      // Unknown budget → fail-closed deny. Caller must set a budget explicitly.
      return {
        allowed: false,
        spentMicroCents: 0n,
        remainingMicroCents: 0n,
        pendingMicroCents: pending,
        overageMicroCents: pending,
        limitMicroCents: 0n,
      };
    }
    const spent = this.spentWithinWindow(tenantId, nowMs, budget.windowMs);
    const remaining = spent >= budget.limitMicroCents ? 0n : budget.limitMicroCents - spent;
    const projected = spent + pending;
    const allowed = projected <= budget.limitMicroCents;
    const overage = allowed ? 0n : projected - budget.limitMicroCents;
    return {
      allowed,
      spentMicroCents: spent,
      remainingMicroCents: remaining,
      pendingMicroCents: pending,
      overageMicroCents: overage,
      limitMicroCents: budget.limitMicroCents,
    };
  }

  /**
   * Record an actually-incurred spend. Call ONLY after the action executed.
   * Returns the authorization snapshot AFTER recording. Fail-closed: recording
   * against an unknown budget throws (you cannot spend without a budget).
   *
   * NOTE: commit records unconditionally (the money was spent). To enforce the
   * cap, call authorize() first and refuse the action when allowed === false.
   */
  commit(tenantId: string, amountMicroCents: MicroCents, nowMs: number): SpendAuthorization {
    const amount = assertAmount(amountMicroCents, "amountMicroCents");
    if (!this.budgets.has(tenantId)) {
      throw new SpendBudgetError("NO_BUDGET", "cannot commit spend for a tenant with no budget set");
    }
    const list = this.spend.get(tenantId) ?? [];
    list.push({ atMs: nowMs, amount });
    this.spend.set(tenantId, list);
    // Return the post-commit view (pending 0 → just the running totals).
    return this.authorize(tenantId, 0n, nowMs);
  }

  /** Convenience: authorize then, only if allowed, commit. Atomic for one tenant. */
  authorizeAndCommit(tenantId: string, amountMicroCents: MicroCents, nowMs: number): SpendAuthorization {
    const auth = this.authorize(tenantId, amountMicroCents, nowMs);
    if (auth.allowed && amountMicroCents > 0n) {
      // Record the spend and return the POST-commit snapshot, so callers see the
      // updated running total (not the stale pre-commit view).
      return this.commit(tenantId, amountMicroCents, nowMs);
    }
    return auth;
  }

  /** Return true iff a budget has been set for this tenant. */
  hasBudget(tenantId: string): boolean {
    return this.budgets.has(tenantId);
  }

  /**
   * Remove a tenant's budget and clear their spend history. Returns true if a
   * budget existed and was removed, false if none was set (idempotent).
   * With requireBudget=false (the default), the guard becomes a no-op for
   * this tenant until a new budget is set.
   */
  deleteBudget(tenantId: string): boolean {
    const had = this.budgets.delete(tenantId);
    this.spend.delete(tenantId);
    return had;
  }
}

export type SpendBudgetErrorCode =
  | "INVALID_TENANT"
  | "INVALID_CONFIG"
  | "INVALID_AMOUNT"
  | "NO_BUDGET";

export class SpendBudgetError extends Error {
  readonly code: SpendBudgetErrorCode;
  constructor(code: SpendBudgetErrorCode, message: string) {
    super(message);
    this.name = "SpendBudgetError";
    this.code = code;
  }
}
