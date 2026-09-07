/**
 * lib/risk/reputation-policy.ts — injectReputationScore: GuardPolicy that wires
 * TrackRecordCache → ctx.reputationScore before the approval policy router.
 *
 * PURPOSE
 * -------
 * Sub-step #1 of MANIFEST "החסר הבא" #1 (חיווט TrackRecordCache ל-reputationScore
 * ב-policy chain). This policy is placed immediately after `injectRiskClass` and
 * before `approvalPolicyRouter`. It is an *injection* policy — it never denies
 * on its own; it only enriches the context with the actor's verified trust score
 * so the router can fuse it into the decision trace.
 *
 * DESIGN
 * ------
 * • async evaluate: reads from TrackRecordCache (tenantId, actorId).
 * • actorId defaults to `ctx.action.source` (the identity that initiated the action).
 * • cache miss → ctx.reputationScore stays undefined (backward-compat with v297).
 * • cache hit → ctx.reputationScore = record.score (0–100, deterministic).
 * • Tenant isolation: delegated to TrackRecordCache (cross-tenant get returns null).
 * • Fail-closed: if the cache throws, GuardEvaluator catches it and treats as deny.
 *
 * Zero external dependencies.
 */

import type { ActionContext, GuardPolicy } from "../orchestrator/types";
import type { TrackRecordCache } from "../track-record/track-record-cache";

export interface InjectReputationScoreOptions {
  /** Policy name for traceability. */
  name?: string;
  /**
   * Override how the actor identity is resolved from the action context.
   * Default: `ctx.action.source`.
   */
  actorIdResolver?: (ctx: ActionContext) => string;
}

/**
 * injectReputationScore — GuardPolicy that fetches the actor's trust score from
 * TrackRecordCache and injects it into `ctx.reputationScore`.
 *
 * Placement: immediately after `injectRiskClass`, before `approvalPolicyRouter`.
 */
export function injectReputationScore(
  cache: TrackRecordCache,
  opts: InjectReputationScoreOptions = {},
): GuardPolicy {
  const name = opts.name ?? "inject-reputation-score";
  const resolveActor = opts.actorIdResolver ?? ((ctx: ActionContext) => ctx.action.source);

  return {
    name,
    evaluate: async (ctx: ActionContext) => {
      const actorId = resolveActor(ctx);
      const record = await cache.get(ctx.tenantId, actorId);
      if (record) {
        ctx.reputationScore = record.score;
      }
      return { allow: true };
    },
  };
}
