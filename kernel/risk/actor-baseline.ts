/**
 * lib/risk/actor-baseline.ts — Actor Baseline Engine: per-actor anomaly detection.
 *
 * PURPOSE
 * -------
 * MANIFEST "החסר הבא" #1 sub-step: a deterministic moving-average baseline per
 * actor that feeds `actorBaselineCount` into `assessRisk` automatically.
 *
 * DESIGN
 * ------
 * • Time is divided into fixed windows (default 1 hour).
 * • Each actor has a count of actions per completed window.
 * • The baseline is the arithmetic mean of the last N completed windows.
 * • The current (incomplete) window is used only for `actorRecentCount`.
 * • Memory is bounded: only (baselineWindows + 1) entries per actor are kept.
 * • Deterministic: same history → same baseline, always.
 * • Tenant isolation enforced in the store key.
 *
 * `injectActorBaseline` is a GuardPolicy placed after `injectRiskClass` and before
 * `approvalPolicyRouter`. It records the current action, reads baseline + recent,
 * and injects both into `ctx.riskContext` so `scoreContextualRisk` can compute the
 * velocity multiple. It never denies on its own.
 *
 * Zero external dependencies.
 */

import type { ActionContext, GuardPolicy } from "../orchestrator/types";

/** Baseline store contract. Implementations: InMemoryActorBaselineStore. */
export interface ActorBaselineStore {
  /** Record an action occurrence for an actor at a given time. */
  recordAction(tenantId: string, actorId: string, nowMs?: number): void;
  /** Average count per completed window over the last N windows. */
  getBaseline(tenantId: string, actorId: string, nowMs?: number): number;
  /** Count in the current (possibly incomplete) window. */
  getRecentCount(tenantId: string, actorId: string, nowMs?: number): number;
}

export interface ActorBaselineOptions {
  /** Window duration in milliseconds. Default: 3600000 (1 hour). */
  windowMs?: number;
  /** Number of completed windows to average for the baseline. Default: 24. */
  baselineWindows?: number;
}

/** In-memory baseline store. Suitable for tests and local dev. */
export class InMemoryActorBaselineStore implements ActorBaselineStore {
  private readonly data = new Map<string, Map<number, number>>();
  private readonly windowMs: number;
  private readonly baselineWindows: number;

  constructor(opts: ActorBaselineOptions = {}) {
    this.windowMs = opts.windowMs ?? 3600000;
    this.baselineWindows = opts.baselineWindows ?? 24;
  }

  private key(tenantId: string, actorId: string): string {
    return `${tenantId}::${actorId}`;
  }

  recordAction(tenantId: string, actorId: string, nowMs: number = Date.now()): void {
    if (!tenantId || !actorId) return;
    const key = this.key(tenantId, actorId);
    const windowIdx = Math.floor(nowMs / this.windowMs);
    const tenantData = this.data.get(key) ?? new Map<number, number>();
    tenantData.set(windowIdx, (tenantData.get(windowIdx) ?? 0) + 1);
    this.prune(tenantData, windowIdx);
    this.data.set(key, tenantData);
  }

  getRecentCount(tenantId: string, actorId: string, nowMs: number = Date.now()): number {
    if (!tenantId || !actorId) return 0;
    const key = this.key(tenantId, actorId);
    const windowIdx = Math.floor(nowMs / this.windowMs);
    const tenantData = this.data.get(key);
    return tenantData?.get(windowIdx) ?? 0;
  }

  getBaseline(tenantId: string, actorId: string, nowMs: number = Date.now()): number {
    if (!tenantId || !actorId) return 0;
    const key = this.key(tenantId, actorId);
    const currentIdx = Math.floor(nowMs / this.windowMs);
    const tenantData = this.data.get(key);
    if (!tenantData) return 0;

    let sum = 0;
    let windows = 0;
    for (let i = 1; i <= this.baselineWindows; i++) {
      const c = tenantData.get(currentIdx - i) ?? 0;
      sum += c;
      windows++;
    }
    if (windows === 0) return 0;
    // Round to 1 decimal for deterministic stability across integer histories.
    return Math.round((sum / windows) * 10) / 10;
  }

  /** Drop windows older than baselineWindows + 1 behind current. */
  private prune(tenantData: Map<number, number>, currentIdx: number): void {
    const cutoff = currentIdx - this.baselineWindows - 1;
    for (const idx of tenantData.keys()) {
      if (idx < cutoff) tenantData.delete(idx);
    }
  }
}

export interface InjectActorBaselineOptions {
  /** Policy name for traceability. */
  name?: string;
  /** Override how the actor identity is resolved. Default: `ctx.action.source`. */
  actorIdResolver?: (ctx: ActionContext) => string;
  /** Optional window duration override (passed to getRecentCount/getBaseline). */
  windowMs?: number;
  /**
   * When wired into TfaOrchestrator, set to `false` so the orchestrator itself
   * records only after successful execution (baseline learns only approved actions).
   * Default `true` (standalone use records during evaluate).
   */
  recordDuringEvaluate?: boolean;
}

/**
 * injectActorBaseline — GuardPolicy that records the current action, computes
 * the actor's historical baseline and recent-window count, and injects both into
 * `ctx.riskContext` so the approval router can detect velocity anomalies.
 *
 * Placement: after `injectRiskClass`, before `approvalPolicyRouter` and
 * `injectReputationScore` (order is flexible; baseline injection is independent).
 */
export function injectActorBaseline(
  store: ActorBaselineStore,
  opts: InjectActorBaselineOptions = {},
): GuardPolicy {
  const name = opts.name ?? "inject-actor-baseline";
  const resolveActor = opts.actorIdResolver ?? ((ctx: ActionContext) => ctx.action.source);
  const shouldRecord = opts.recordDuringEvaluate !== false;

  return {
    name,
    evaluate: async (ctx: ActionContext) => {
      const actorId = resolveActor(ctx);
      const nowMs = Date.now();

      // Record the current action in the current window (unless orchestrator handles it post-success).
      if (shouldRecord) {
        store.recordAction(ctx.tenantId, actorId, nowMs);
      }

      // Read historical baseline (completed windows only) and recent count.
      const baseline = store.getBaseline(ctx.tenantId, actorId, nowMs);
      const recent = store.getRecentCount(ctx.tenantId, actorId, nowMs);

      // Merge into existing riskContext (additive, never overwrite unrelated fields).
      const existing = (ctx.riskContext ?? {}) as Record<string, unknown>;
      ctx.riskContext = {
        ...existing,
        actorBaselineCount: baseline,
        actorRecentCount: recent,
      };

      return { allow: true };
    },
  };
}
