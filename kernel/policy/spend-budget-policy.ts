/**
 * lib/policy/spend-budget-policy.ts — SpendBudgetGuard wired as a GuardPolicy.
 *
 * Every value-bearing (isFinancial) action is pre-authorized against the tenant's
 * cumulative spend budget before execution, and committed after successful
 * execution. Non-financial actions are untouched.
 *
 * Two-phase, BigInt μ¢, fail-closed, zero-dep.
 */

import type { Action, GuardPolicy } from "../orchestrator/types";
import type { SpendBudgetGuard } from "./spend-budget-guard";

/** Extract the monetary value from an Action, trying common payload shapes. */
export function extractValueMicrounits(action: Action): bigint {
  const a = action as any;
  if (typeof a.valueMicrounits === "bigint") return a.valueMicrounits;
  const p = a.payload as any;
  if (typeof p?.amount === "bigint") return p.amount;
  if (typeof p?.valueMicrounits === "bigint") return p.valueMicrounits;
  return 0n;
}

export interface SpendBudgetPolicyOptions {
  /**
   * When true (default), a tenant without a configured budget is denied.
   * When false, a tenant without a budget is allowed (spend tracking is
   * opt-in until budgets are configured via the admin routes).
   */
  requireBudget?: boolean;
}

/**
 * Build a GuardPolicy that wraps SpendBudgetGuard.
 *
 * • Non-financial actions → allowed immediately.
 * • Financial actions with a configured budget → authorize() first.
 *   Denied if the cumulative window spend would exceed the limit.
 * • Financial actions without a budget → behaviour controlled by requireBudget.
 */
export function spendBudgetPolicy(
  guard: SpendBudgetGuard,
  opts: SpendBudgetPolicyOptions = {},
): GuardPolicy {
  const requireBudget = opts.requireBudget ?? true;
  return {
    name: "spend-budget",
    evaluate: (ctx) => {
      const { action } = ctx;
      if (!action.isFinancial) {
        return { allow: true };
      }
      const value = extractValueMicrounits(action);
      const hasBudget = guard.hasBudget(action.tenantId);
      if (!hasBudget) {
        if (requireBudget) {
          return {
            allow: false,
            reason:
              "spend budget denied: no budget configured for tenant " +
              action.tenantId,
          };
        }
        return { allow: true };
      }
      const auth = guard.authorize(action.tenantId, value, Date.now());
      if (!auth.allowed) {
        return {
          allow: false,
          reason:
            `spend budget exceeded: overage ${auth.overageMicroCents.toString()}μ¢ ` +
            `(spent ${auth.spentMicroCents.toString()}μ¢ / limit ${auth.limitMicroCents.toString()}μ¢)`,
        };
      }
      return { allow: true };
    },
  };
}
