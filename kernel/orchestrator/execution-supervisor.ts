/**
 * lib/orchestrator/execution-supervisor.ts — connects retry-policy to the
 * ExecutionStore: the actual "re-lease + re-run after failed" sub-step of
 * MANIFEST "החסר הבא" #1 (ExecutionWorkflow #2, continued from v138).
 *
 * `failed` is a terminal status in VALID_TRANSITIONS (by design — the run-log
 * of a workflow must never "un-fail"). A retry is therefore a NEW workflow,
 * linked to the original via `retryOfWorkflowId` (additive field, v139).
 *
 * superviseFailedWorkflow(store, id, tenantId, workerId, config?, rng?):
 *   1. Loads the failed workflow (fail-closed: not found / tenant mismatch /
 *      not "failed" all throw via planRetryForWorkflow's existing checks or
 *      ExecutionStore's own fail-closed lookups).
 *   2. Derives the retry plan from the REAL run-log (planRetryForWorkflow) —
 *      no separate mutable attempt counter.
 *   3. If retry === false (attempts exhausted): releases any held lease and
 *      returns { plan, retryWorkflow: null } — the failure is final.
 *   4. If retry === true: creates a fresh `planned` workflow that mirrors the
 *      original's actionId/intentId/executionRef/approvalId, immediately
 *      leases it for `workerId` (so the same supervisor owns it for re-run),
 *      and returns it as `retryWorkflow`. The caller is responsible for
 *      waiting `plan.delayMs` before transitioning the new workflow toward
 *      "approved" → "running" — this module makes no wall-clock assumptions.
 *
 * Zero external dependencies.
 */

import { ExecutionError } from "./execution-workflow.ts";
import {
  DEFAULT_RETRY_POLICY,
  planRetryForWorkflow,
  type RetryPlan,
  type RetryPolicyConfig,
} from "./retry-policy.ts";
import type { ExecutionStore, ExecutionWorkflow } from "./types.ts";

/** Default lease duration (ms) granted to the re-leased retry workflow. */
export const DEFAULT_RETRY_LEASE_MS = 30_000;

export interface SupervisorOutcome {
  /** The original failed workflow that was supervised. */
  original: ExecutionWorkflow;
  /** The retry decision derived from the original's run-log. */
  plan: RetryPlan;
  /**
   * The newly created `planned` workflow if a retry was scheduled, leased to
   * `workerId`. Null when attempts are exhausted (final failure).
   */
  retryWorkflow: ExecutionWorkflow | null;
}

/**
 * superviseFailedWorkflow — the supervisor's reaction to a `failed` workflow.
 *
 * fail-closed:
 *   - unknown workflow / cross-tenant access → ExecutionError("workflow_not_found"
 *     | "tenant_mismatch") via store.get.
 *   - workflow not in "failed" status → ExecutionError("invalid_retry_config")
 *     via planRetryForWorkflow.
 *   - empty workerId when a retry is scheduled → ExecutionError("lease_denied")
 *     via store.lease.
 */
export function superviseFailedWorkflow(
  store: ExecutionStore,
  id: string,
  tenantId: string,
  workerId: string,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  rng: () => number = () => 0.5,
): SupervisorOutcome {
  const original = store.get(id, tenantId);
  if (!original) {
    throw new ExecutionError("workflow_not_found", `workflow ${id} not found`);
  }

  const plan = planRetryForWorkflow(original, config, rng);

  if (!plan.retry) {
    // Attempts exhausted: this is a final failure. Release any held lease so
    // it doesn't sit claimed forever, but do not retry.
    if (original.claimedBy) {
      store.releaseLease(id, tenantId, original.claimedBy);
    }
    return { original, plan, retryWorkflow: null };
  }

  const retryWorkflow = store.create({
    tenantId: original.tenantId,
    actionId: original.actionId,
    intentId: original.intentId,
    executionRef: original.executionRef,
    approvalId: original.approvalId,
    evidenceRefs: original.evidenceRefs,
    retryOfWorkflowId: original.id,
  });

  // Re-lease: hand the fresh workflow to the same worker so it can drive it
  // through approved → running without another worker racing to claim it.
  const leased = store.lease(retryWorkflow.id, tenantId, workerId, DEFAULT_RETRY_LEASE_MS);
  if (!leased) {
    // Brand-new workflow is always unclaimed; lease() only fails on bad input
    // (empty workerId / non-positive duration) — fail-closed.
    throw new ExecutionError("lease_denied", `failed to lease retry workflow ${retryWorkflow.id}`);
  }

  const leasedWorkflow = store.get(retryWorkflow.id, tenantId)!;
  return { original, plan, retryWorkflow: leasedWorkflow };
}
