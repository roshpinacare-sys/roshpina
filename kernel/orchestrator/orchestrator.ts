/**
 * lib/orchestrator/orchestrator.ts — TfaOrchestrator: the autonomous action spine.
 *
 * Every autonomous or financial action in TFA must flow through this class.
 * The contract is strict and never bypassed:
 *
 *   1. Guard — all policies evaluated (fail-closed).
 *      If denied: write DENIED audit record, return { ok: false }.
 *      Executor is NOT called.
 *
 *   2. Execute — call the provided executor with the action and context.
 *      If throws: catch, write ERROR audit record, return { ok: false }.
 *
 *   3. Audit — write ALLOWED audit record, return { ok: true, result, auditId }.
 *
 * Audit is ALWAYS written, regardless of outcome.
 * The audit chain is per-tenant and hash-linked (tamper-evident).
 *
 * ExecutionWorkflow integration (additive, optional via `executionStore` param):
 *   When provided, every autonomous or financial action creates and advances an
 *   ExecutionWorkflow for durable tracking and scheduler-driven retry:
 *     planned → (guard allows) approved → running → evidence_collected → settled → proved
 *     planned → (guard denies) rejected
 *     running → (executor throws) failed   ← scheduler retries this
 *   Fail-closed: if the store cannot create a workflow, the action is denied —
 *   untracked autonomous/financial work is not permitted.
 *   Post-success transitions (evidence_collected → proved) are best-effort.
 *
 * Zero external dependencies — node:crypto only.
 */

import { randomUUID } from "node:crypto";
import type {
  Action,
  ActionExecutor,
  ActionContext,
  AuditStore,
  GuardPolicy,
  Orchestrator,
  OrchestrationResult,
  Signer,
  ExecutionStore,
  AsyncExecutionStore,
} from "./types.ts";
import { GuardEvaluator } from "./guard.ts";
import { InMemoryAuditStore } from "./audit.ts";
import type { ActorBaselineStore } from "../risk/actor-baseline.ts";
import type { SpendBudgetGuard } from "../policy/spend-budget-guard.ts";
import { extractValueMicrounits } from "../policy/spend-budget-policy.ts";

/** Actor id stamped on orchestrator-driven workflow transitions. */
const ORCHESTRATOR_ACTOR = "tfa-orchestrator";

export class TfaOrchestrator implements Orchestrator {
  private readonly guard: GuardEvaluator;
  readonly audit: AuditStore;
  private readonly _executionStore: ExecutionStore | AsyncExecutionStore | null;
  private readonly _actorBaselineStore: ActorBaselineStore | null;
  private readonly _spendBudgetGuard: SpendBudgetGuard | null;

  /**
   * @param policies - Guard policies evaluated in order (all must allow).
   * @param auditStore - Audit store to use. Defaults to InMemoryAuditStore.
   *                     Pass a PgAuditStore for production persistence.
   * @param signer - Optional cryptographic signer for audit record provenance.
   *                 When provided, the default InMemoryAuditStore is created
   *                 with signing enabled. Ignored when a custom auditStore is passed.
   * @param executionStore - Optional durable execution store. When provided, every
   *                         autonomous or financial action creates and advances an
   *                         ExecutionWorkflow (fail-closed: if store is unavailable
   *                         the action is denied).
   * @param actorBaselineStore - Optional per-actor anomaly baseline store. When provided,
   *                             successful actions are recorded post-execution so the
   *                             baseline learns only from approved operations.
   * @param spendBudgetGuard - Optional cumulative spend guard. When provided, every
   *                           successful financial action commits its value so the
   *                           running window total stays accurate. Denial is handled
   *                           by the spend-budget GuardPolicy (see spendBudgetPolicy()).
   */
  constructor(
    policies: GuardPolicy[],
    auditStore?: AuditStore,
    signer?: Signer,
    executionStore?: ExecutionStore | AsyncExecutionStore,
    actorBaselineStore?: ActorBaselineStore,
    spendBudgetGuard?: SpendBudgetGuard,
  ) {
    this.guard = new GuardEvaluator(policies);
    this.audit = auditStore ?? new InMemoryAuditStore(signer);
    this._executionStore = executionStore ?? null;
    this._actorBaselineStore = actorBaselineStore ?? null;
    this._spendBudgetGuard = spendBudgetGuard ?? null;
  }

  /**
   * Run an action through the full guard → execute → audit pipeline.
   *
   * When an executionStore is wired and the action is autonomous or financial,
   * an ExecutionWorkflow is created before the guard runs and advanced through
   * the state machine as execution progresses. The `workflowId` field of the
   * result (optional) identifies that workflow for cross-reference.
   *
   * Type parameters:
   *   T — the action payload type
   *   R — the executor return type
   */
  async run<T, R>(
    action: Action<T>,
    executor: ActionExecutor<T, R>,
  ): Promise<OrchestrationResult<R>> {
    const ctx: ActionContext = {
      action: action as Action,
      tenantId: action.tenantId,
      timestamp: new Date().toISOString(),
    };

    const store = this._executionStore;
    const needsWorkflow = store !== null && (action.isAutonomous || action.isFinancial);
    let workflowId: string | undefined;

    // ── 0. Create ExecutionWorkflow (fail-closed for autonomous/financial) ────
    if (needsWorkflow) {
      try {
        const wf = await Promise.resolve(
          store!.create({ tenantId: action.tenantId, actionId: action.id }),
        );
        workflowId = wf.id;
      } catch (storeErr) {
        const reason =
          storeErr instanceof Error
            ? `execution store unavailable: ${storeErr.message}`
            : "execution store unavailable";
        const record = this.audit.append({
          id: randomUUID(),
          tenantId: action.tenantId,
          actionId: action.id,
          actionType: action.type,
          source: action.source,
          outcome: "denied",
          reason,
          occurredAt: ctx.timestamp,
        });
        return { ok: false, reason, auditId: record.id } as OrchestrationResult<R>;
      }
    }

    // ── 1. Guard ──────────────────────────────────────────────────────────────
    const decision = await this.guard.evaluate(ctx);

    if (!decision.allow) {
      const record = this.audit.append({
        id: randomUUID(),
        tenantId: action.tenantId,
        actionId: action.id,
        actionType: action.type,
        source: action.source,
        outcome: "denied",
        reason: decision.reason,
        occurredAt: ctx.timestamp,
      });
      if (workflowId) {
        // Guard denied → reject the workflow (planned → rejected)
        await Promise.resolve(
          store!.transition(workflowId, action.tenantId, "rejected", ORCHESTRATOR_ACTOR, decision.reason),
        ).catch(() => {});
      }
      return { ok: false, reason: decision.reason, auditId: record.id } as OrchestrationResult<R>;
    }

    // ── 1b. Workflow: planned → approved → running ────────────────────────────
    if (workflowId) {
      await Promise.resolve(
        store!.transition(workflowId, action.tenantId, "approved", ORCHESTRATOR_ACTOR, "guard allowed"),
      ).catch(() => {});
      await Promise.resolve(
        store!.transition(workflowId, action.tenantId, "running", ORCHESTRATOR_ACTOR, "execution started"),
      ).catch(() => {});
    }

    // ── 2. Execute ────────────────────────────────────────────────────────────
    try {
      const result = await executor(action, ctx);

      // ── 3. Audit (allowed) ─────────────────────────────────────────────────
      const record = this.audit.append({
        id: randomUUID(),
        tenantId: action.tenantId,
        actionId: action.id,
        actionType: action.type,
        source: action.source,
        outcome: "allowed",
        reason: ctx.approvalTrace,
        occurredAt: ctx.timestamp,
      });

      // running → evidence_collected → settled → proved (best-effort, non-blocking)
      if (workflowId) {
        await Promise.resolve(
          store!.transition(workflowId, action.tenantId, "evidence_collected", ORCHESTRATOR_ACTOR, "execution succeeded"),
        ).catch(() => {});
        await Promise.resolve(
          store!.transition(workflowId, action.tenantId, "settled", ORCHESTRATOR_ACTOR, "evidence collected"),
        ).catch(() => {});
        await Promise.resolve(
          store!.transition(workflowId, action.tenantId, "proved", ORCHESTRATOR_ACTOR, "settled"),
        ).catch(() => {});
      }

      // Record successful action in actor baseline store so baseline learns only approved ops.
      if (this._actorBaselineStore) {
        try {
          this._actorBaselineStore.recordAction(action.tenantId, action.source, Date.now());
        } catch {
          // Best-effort: baseline store failure must not break the orchestration result.
        }
      }

      // Commit spend for financial actions so the cumulative window total stays accurate.
      if (this._spendBudgetGuard && action.isFinancial) {
        try {
          const value = extractValueMicrounits(action);
          if (value > 0n) {
            this._spendBudgetGuard.commit(action.tenantId, value, Date.now());
          }
        } catch {
          // Best-effort: spend tracking failure must not break the orchestration result.
        }
      }

      return { ok: true, result, auditId: record.id } as OrchestrationResult<R>;

    } catch (err) {
      // ── 3. Audit (error) ───────────────────────────────────────────────────
      const reason = err instanceof Error ? err.message : String(err);
      const record = this.audit.append({
        id: randomUUID(),
        tenantId: action.tenantId,
        actionId: action.id,
        actionType: action.type,
        source: action.source,
        outcome: "error",
        reason,
        occurredAt: ctx.timestamp,
      });

      // running → failed (scheduler will retry)
      if (workflowId) {
        await Promise.resolve(
          store!.transition(workflowId, action.tenantId, "failed", ORCHESTRATOR_ACTOR, reason),
        ).catch(() => {});
      }

      return { ok: false, reason, auditId: record.id } as OrchestrationResult<R>;
    }
  }
}
