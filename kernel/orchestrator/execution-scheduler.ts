/**
 * lib/orchestrator/execution-scheduler.ts — timer-based supervisor loop.
 *
 * Scans registered tenants for `failed` workflows and retries them:
 *   1. superviseFailedWorkflowAsync (chain-aware) → creates `planned` retry workflow
 *   2. Waits `plan.delayMs`
 *   3. Transitions retry: planned → approved → running (ready for executor pickup)
 *
 * Chain-aware exhaustion (fixes MANIFEST debt): counts failures across the full
 * retryOfWorkflowId chain, not just the current workflow's run-log. Without this,
 * `retry===false` was unreachable because each retry workflow starts with an empty
 * run-log, making `countFailures` always return 1 (or 0) — never reaching maxAttempts.
 *
 * Pattern matches LedgerCron: registerTenant() → start(intervalMs) → stop().
 * The interval timer is unref()'d so it never blocks clean process exit.
 *
 * Zero external dependencies — node:crypto only.
 */

import { randomUUID } from "node:crypto";
import type { ExecutionStore, AsyncExecutionStore, ExecutionWorkflow } from "./types.ts";
import { ExecutionError } from "./execution-workflow.ts";
import {
  DEFAULT_RETRY_POLICY,
  nextRetry,
} from "./retry-policy.ts";
import type { RetryPolicyConfig, RetryPlan } from "./retry-policy.ts";

/** Actor id stamped on all automated transitions made by the scheduler. */
export const SCHEDULER_ACTOR = "tfa-execution-scheduler";

/** Default lease duration (ms) granted to retry workflows created by the scheduler. */
export const SCHEDULER_LEASE_MS = 30_000;

export type AnyExecutionStore = ExecutionStore | AsyncExecutionStore;

// ── Chain-aware failure counting ────────────────────────────────────────────

/**
 * countChainFailures — count total `failed` transitions across the full
 * retryOfWorkflowId ancestor chain.
 *
 * Fixes MANIFEST debt: `planRetryForWorkflow` only counts failures in a single
 * workflow's run-log. Since each retry creates a NEW workflow (terminal `failed`
 * status means a workflow can have at most one failure in its own log), the
 * per-workflow count is always ≤1, making `retry===false` unreachable. Chain
 * counting traverses all ancestors and sums their failure counts, so `maxAttempts`
 * is correctly enforced across the full retry family.
 */
export async function countChainFailures(
  store: AnyExecutionStore,
  workflow: ExecutionWorkflow,
  tenantId: string,
): Promise<number> {
  let total = 0;
  let current: ExecutionWorkflow | null = workflow;

  while (current !== null) {
    for (const entry of current.runLog) {
      if (entry.toStatus === "failed") total++;
    }
    if (!current.retryOfWorkflowId) break;
    const parent = await Promise.resolve(store.get(current.retryOfWorkflowId, tenantId));
    current = parent;
  }
  return total;
}

// ── Async supervisor outcome ──────────────────────────────────────────────────

export interface SchedulerOutcome {
  /** The original failed workflow that was supervised. */
  original: ExecutionWorkflow;
  /** The retry decision, using chain-aware failure count. */
  plan: RetryPlan;
  /**
   * The newly created `planned` workflow if a retry was scheduled, leased to the
   * scheduler's workerId. Null when attempts are exhausted (final failure).
   */
  retryWorkflow: ExecutionWorkflow | null;
}

/**
 * superviseFailedWorkflowAsync — async supervisor for both ExecutionStore and
 * AsyncExecutionStore. Uses chain-aware failure counting.
 *
 * fail-closed:
 *   - unknown workflow / cross-tenant → ExecutionError("workflow_not_found")
 *   - workflow not "failed" → ExecutionError("invalid_retry_config")
 *   - empty workerId when retry scheduled → ExecutionError("lease_denied")
 */
export async function superviseFailedWorkflowAsync(
  store: AnyExecutionStore,
  id: string,
  tenantId: string,
  workerId: string,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  rng: () => number = () => 0.5,
): Promise<SchedulerOutcome> {
  if (!workerId) {
    throw new ExecutionError("lease_denied", "workerId must not be empty");
  }

  const original = await Promise.resolve(store.get(id, tenantId));
  if (!original) {
    throw new ExecutionError("workflow_not_found", `workflow ${id} not found`);
  }
  if (original.status !== "failed") {
    throw new ExecutionError(
      "invalid_retry_config",
      `cannot retry workflow "${id}": status is "${original.status}", expected "failed"`,
    );
  }

  const chainFailures = await countChainFailures(store, original, tenantId);
  const plan = nextRetry(chainFailures, config, rng);

  if (!plan.retry) {
    if (original.claimedBy) {
      await Promise.resolve(store.releaseLease(id, tenantId, original.claimedBy)).catch(() => {});
    }
    return { original, plan, retryWorkflow: null };
  }

  const retryWf = await Promise.resolve(
    store.create({
      tenantId: original.tenantId,
      actionId: original.actionId,
      intentId: original.intentId,
      executionRef: original.executionRef,
      approvalId: original.approvalId,
      evidenceRefs: original.evidenceRefs,
      retryOfWorkflowId: original.id,
    }),
  );

  const leased = await Promise.resolve(
    store.lease(retryWf.id, tenantId, workerId, SCHEDULER_LEASE_MS),
  );
  if (!leased) {
    throw new ExecutionError(
      "lease_denied",
      `failed to lease retry workflow ${retryWf.id}`,
    );
  }

  const leasedWf = await Promise.resolve(store.get(retryWf.id, tenantId));
  return { original, plan, retryWorkflow: leasedWf! };
}

// ── ExecutionScheduler ─────────────────────────────────────────────────────────

export interface SchedulerStatus {
  running: boolean;
  intervalMs: number;
  tenants: string[];
  lastRunAt: string | null;
  totalRuns: number;
  totalRetries: number;
  totalExhausted: number;
}

/**
 * ExecutionScheduler — background supervisor loop.
 *
 * For every registered tenant, on each tick:
 *   1. Lists all `failed` workflows.
 *   2. Calls `superviseFailedWorkflowAsync` (chain-aware) on each.
 *   3. If retryWorkflow returned, schedules `plan.delayMs` then
 *      transitions: planned → approved → running.
 *
 * Usage:
 * ```ts
 * const sched = new ExecutionScheduler(stack.executionStore);
 * sched.registerTenant("tenant-1");
 * sched.start(30_000);
 * // On shutdown: sched.stop();
 * ```
 */
export class ExecutionScheduler {
  private readonly store: AnyExecutionStore;
  private readonly config: RetryPolicyConfig;
  private readonly workerId: string;

  private _intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tenants = new Set<string>();
  private lastRunAt: string | null = null;
  private totalRuns = 0;
  private totalRetries = 0;
  private totalExhausted = 0;

  constructor(
    store: AnyExecutionStore,
    config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
    intervalMs = 30_000,
  ) {
    this.store = store;
    this.config = config;
    this._intervalMs = intervalMs;
    this.workerId = `scheduler-${randomUUID()}`;
  }

  /** Register a tenant for the periodic scan. Idempotent. */
  registerTenant(tenantId: string): void {
    this.tenants.add(tenantId);
  }

  /**
   * Start the timer loop. Runs immediately, then every intervalMs.
   * Safe to call multiple times — second call is a no-op.
   */
  start(intervalMs?: number): void {
    if (this.timer !== null) return;
    if (intervalMs !== undefined) this._intervalMs = intervalMs;
    this.runAll().catch(() => {});
    this.timer = setInterval(() => {
      this.runAll().catch(() => {});
    }, this._intervalMs);
    if (typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  /** Stop the timer loop. The process can now exit cleanly. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Scan all registered tenants for failed workflows and retry them. */
  async runAll(): Promise<void> {
    this.lastRunAt = new Date().toISOString();
    this.totalRuns++;
    for (const tenantId of this.tenants) {
      await this.scanTenant(tenantId).catch(() => {});
    }
  }

  /** Scan one tenant for failed workflows and supervise each. */
  async scanTenant(tenantId: string): Promise<void> {
    const all = await Promise.resolve(this.store.list(tenantId));
    const failed = all.filter((wf) => wf.status === "failed");
    for (const wf of failed) {
      await this._superviseSingle(wf.id, tenantId).catch(() => {});
    }
  }

  private async _superviseSingle(id: string, tenantId: string): Promise<void> {
    let outcome: SchedulerOutcome;
    try {
      outcome = await superviseFailedWorkflowAsync(
        this.store,
        id,
        tenantId,
        this.workerId,
        this.config,
      );
    } catch {
      return;
    }

    if (!outcome.retryWorkflow) {
      this.totalExhausted++;
      return;
    }

    this.totalRetries++;
    const { retryWorkflow, plan } = outcome;
    const store = this.store;
    const actor = SCHEDULER_ACTOR;

    const advance = async () => {
      try {
        await Promise.resolve(
          store.transition(retryWorkflow.id, tenantId, "approved", actor, "scheduler: auto-approved"),
        );
        await Promise.resolve(
          store.transition(retryWorkflow.id, tenantId, "running", actor, "scheduler: retry running"),
        );
      } catch {
        // Transition may fail if store was reset or workflow was externally modified.
      }
    };

    if (plan.delayMs > 0) {
      const t = setTimeout(advance, plan.delayMs);
      if (typeof (t as any).unref === "function") (t as any).unref();
    } else {
      advance().catch(() => {});
    }
  }

  /** Current scheduler status for observability. */
  getStatus(): SchedulerStatus {
    return {
      running: this.timer !== null,
      intervalMs: this._intervalMs,
      tenants: Array.from(this.tenants),
      lastRunAt: this.lastRunAt,
      totalRuns: this.totalRuns,
      totalRetries: this.totalRetries,
      totalExhausted: this.totalExhausted,
    };
  }
}
