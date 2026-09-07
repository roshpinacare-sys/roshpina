/**
 * lib/policy/policy-compiler.ts — compile a DeclarativePolicy (JSON) into a GuardPolicy.
 * Fail-closed everywhere: an invalid policy compiles to DENY-ALL (never silently allow); an
 * unparseable amount denies; an unknown effect denies. First matching rule wins; no match → default
 * (default = deny unless explicitly "allow"). Pure, deterministic, zero external deps.
 *
 * Trust-Tier extension (v87):
 *   PolicyCondition.minTrustScore requires a TrustScoreProvider injected via CompileOptions.
 *   Fail-closed: if minTrustScore is present in any rule but no provider is configured,
 *   that condition never matches (the rule is skipped → default deny applies).
 *   The identity being scored is ctx.action.source (the actor requesting the action).
 */
import type { GuardPolicy, GuardDecision, ActionContext } from "../orchestrator/types";
import type { DeclarativePolicy, PolicyRule, PolicyCondition } from "./policy-schema";

export interface PolicyValidation { ok: boolean; errors: string[]; }

/**
 * Async function that returns the trust score (0–100) for a given identity within a tenant.
 * Typically wraps computeTrackRecord from lib/track-record.
 * Returns 0 for unknown identities (fail-closed — unknown ≠ trusted).
 */
export type TrustScoreProvider = (tenantId: string, identityId: string) => Promise<number>;

/**
 * Async function that returns the count of allowed financial actions a tenant has
 * performed in the current calendar month (UTC). Used by PolicyCondition.maxMonthlyActions
 * to implement plan limits (free/pro) as policy-as-data.
 * Typically wraps orchestrator.audit.getChain(tenantId).
 */
export type UsageCountProvider = (tenantId: string) => Promise<number>;

export interface CompileOptions {
  /**
   * Provider consulted when a policy condition includes minTrustScore.
   * If omitted and a condition requires minTrustScore, that condition never matches (fail-closed).
   */
  trustScoreProvider?: TrustScoreProvider;
  /**
   * Provider consulted when a policy condition includes maxMonthlyActions.
   * If omitted and a condition requires maxMonthlyActions, that condition never matches
   * (the limit is not enforced).
   */
  usageCountProvider?: UsageCountProvider;
}

export function validatePolicy(p: unknown): PolicyValidation {
  const errors: string[] = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["policy must be an object"] };
  const pol = p as DeclarativePolicy;
  if (typeof pol.name !== "string" || !pol.name) errors.push("name required");
  if (!Array.isArray(pol.rules)) errors.push("rules must be an array");
  else pol.rules.forEach((r, i) => {
    if (!r || typeof r !== "object") errors.push(`rule[${i}] must be an object`);
    else {
      if (r.then !== "allow" && r.then !== "deny") errors.push(`rule[${i}].then must be allow|deny`);
      if (r.then === "deny" && !r.reason) errors.push(`rule[${i}] deny requires a reason`);
      if (!r.if || typeof r.if !== "object") errors.push(`rule[${i}].if must be an object`);
      for (const k of ["amountAbove", "amountAtMost"] as const) {
        if (r.if && r.if[k] !== undefined && !/^-?\d+$/.test(String(r.if[k]))) errors.push(`rule[${i}].if.${k} must be an integer μ¢ string`);
      }
      if (r.if && r.if.minTrustScore !== undefined) {
        const mts = r.if.minTrustScore;
        if (typeof mts !== "number" || !Number.isFinite(mts) || mts < 0 || mts > 100) {
          errors.push(`rule[${i}].if.minTrustScore must be a number 0–100`);
        }
      }
      if (r.if && r.if.maxMonthlyActions !== undefined) {
        const mma = r.if.maxMonthlyActions;
        if (typeof mma !== "number" || !Number.isFinite(mma) || mma < 0 || !Number.isInteger(mma)) {
          errors.push(`rule[${i}].if.maxMonthlyActions must be a non-negative integer`);
        }
      }
    }
  });
  if (pol.default !== undefined && pol.default !== "allow" && pol.default !== "deny") errors.push("default must be allow|deny");
  return { ok: errors.length === 0, errors };
}

function amountOf(ctx: ActionContext): bigint | null {
  const a = (ctx.action as any)?.payload?.amount;
  if (typeof a === "bigint") return a;
  if (typeof a === "string" && /^-?\d+$/.test(a)) return BigInt(a);
  if (typeof a === "number" && Number.isInteger(a)) return BigInt(a);
  return null;
}

// ─── Pre-compiled condition ───────────────────────────────────────────────────
//
// Array fields (actionType, actionTypeNotIn, source, tenantId) are converted to
// Set<string> once at compilePolicy() time. Every subsequent evaluate() call uses
// Set.has() — O(1) — instead of Array.includes() — O(n). Semantics are identical:
// same membership test, same fail-closed ordering.

type CompiledCondition = {
  readonly actionTypeSet: Set<string> | undefined;
  readonly actionTypeNotInSet: Set<string> | undefined;
  readonly sourceSet: Set<string> | undefined;
  readonly tenantIdSet: Set<string> | undefined;
  readonly isAutonomous: boolean | undefined;
  readonly isFinancial: boolean | undefined;
  readonly amountAbove: string | undefined;
  readonly amountAtMost: string | undefined;
  readonly minTrustScore: number | undefined;
  readonly maxMonthlyActions: number | undefined;
};

function compileCondition(cond: PolicyCondition): CompiledCondition {
  return {
    actionTypeSet:    cond.actionType    ? new Set(cond.actionType)    : undefined,
    actionTypeNotInSet: cond.actionTypeNotIn ? new Set(cond.actionTypeNotIn) : undefined,
    sourceSet:        cond.source        ? new Set(cond.source)        : undefined,
    tenantIdSet:      cond.tenantId      ? new Set(cond.tenantId)      : undefined,
    isAutonomous:     cond.isAutonomous,
    isFinancial:      cond.isFinancial,
    amountAbove:      cond.amountAbove,
    amountAtMost:     cond.amountAtMost,
    minTrustScore:    cond.minTrustScore,
    maxMonthlyActions: cond.maxMonthlyActions,
  };
}

/**
 * Evaluate all synchronous fields of a pre-compiled condition.
 * Returns false if any field fails to match.
 * minTrustScore / maxMonthlyActions are handled separately (async).
 */
function matchesSync(cond: CompiledCondition, ctx: ActionContext): boolean {
  const act = ctx.action as any;
  if (cond.actionTypeSet    && !cond.actionTypeSet.has(act.type))           return false;
  if (cond.actionTypeNotInSet &&  cond.actionTypeNotInSet.has(act.type))    return false;
  if (cond.isAutonomous !== undefined && Boolean(act.isAutonomous) !== cond.isAutonomous) return false;
  if (cond.isFinancial  !== undefined && Boolean(act.isFinancial)  !== cond.isFinancial)  return false;
  if (cond.sourceSet    && !cond.sourceSet.has(String(act.source)))         return false;
  if (cond.tenantIdSet  && !cond.tenantIdSet.has(ctx.tenantId))             return false;
  if (cond.amountAbove  !== undefined) { const amt = amountOf(ctx); if (amt === null || !(amt >  BigInt(cond.amountAbove)))  return false; }
  if (cond.amountAtMost !== undefined) { const amt = amountOf(ctx); if (amt === null || !(amt <= BigInt(cond.amountAtMost))) return false; }
  return true;
}

/**
 * Full condition evaluation (may be async when minTrustScore is present).
 * Fail-closed: if minTrustScore is required but provider is absent → false (no match).
 */
async function matchesAsync(cond: CompiledCondition, ctx: ActionContext, provider: TrustScoreProvider | undefined, usageProvider: UsageCountProvider | undefined): Promise<boolean> {
  if (!matchesSync(cond, ctx)) return false;
  if (cond.minTrustScore !== undefined) {
    if (!provider) return false; // fail-closed: no provider = never match
    const identityId = String((ctx.action as any).source ?? "");
    if (!identityId) return false; // no identity = fail-closed
    const score = await provider(ctx.tenantId, identityId);
    if (score < cond.minTrustScore) return false;
  }
  if (cond.maxMonthlyActions !== undefined) {
    if (!usageProvider) return false; // no provider = condition never matches (limit not enforced)
    const count = await usageProvider(ctx.tenantId);
    if (!(count >= cond.maxMonthlyActions)) return false;
  }
  return true;
}

/** Returns true if any rule in the policy uses minTrustScore or maxMonthlyActions (needs async evaluation). */
function hasAsyncConditions(pol: DeclarativePolicy): boolean {
  return pol.rules.some(r => r.if.minTrustScore !== undefined || r.if.maxMonthlyActions !== undefined);
}

/** Compile JSON → GuardPolicy. Invalid policy → DENY-ALL (fail-closed). */
export function compilePolicy(json: unknown, opts?: CompileOptions): GuardPolicy {
  const v = validatePolicy(json);
  if (!v.ok) {
    return { name: "invalid-policy(deny-all)", evaluate: (): GuardDecision => ({ allow: false, reason: "invalid policy (fail-closed): " + v.errors.join("; ") }) };
  }
  const pol = json as DeclarativePolicy;
  const fallback: GuardDecision = pol.default === "allow" ? { allow: true } : { allow: false, reason: "no rule matched (default deny)" };
  const provider = opts?.trustScoreProvider;
  const usageProvider = opts?.usageCountProvider;

  // Pre-compile all rule conditions into Sets once — O(1) lookups on every evaluate().
  const compiledRules = pol.rules.map(r => ({ compiled: compileCondition(r.if), rule: r }));

  if (!hasAsyncConditions(pol)) {
    // Pure sync path — unchanged behaviour for policies that don't use minTrustScore.
    return {
      name: pol.name,
      evaluate: (ctx: ActionContext): GuardDecision => {
        for (const { compiled, rule } of compiledRules) {
          if (matchesSync(compiled, ctx)) {
            return rule.then === "allow" ? { allow: true } : { allow: false, reason: rule.reason || "denied by policy " + pol.name };
          }
        }
        return fallback;
      },
    };
  }

  // Async path — used when any rule includes minTrustScore or maxMonthlyActions.
  return {
    name: pol.name,
    evaluate: async (ctx: ActionContext): Promise<GuardDecision> => {
      for (const { compiled, rule } of compiledRules) {
        if (await matchesAsync(compiled, ctx, provider, usageProvider)) {
          return rule.then === "allow" ? { allow: true } : { allow: false, reason: rule.reason || "denied by policy " + pol.name };
        }
      }
      return fallback;
    },
  };
}

/** Compile many; each becomes its own GuardPolicy (Orchestrator AND-composes them). */
export function compilePolicies(jsons: unknown[], opts?: CompileOptions): GuardPolicy[] { return jsons.map(j => compilePolicy(j, opts)); }
