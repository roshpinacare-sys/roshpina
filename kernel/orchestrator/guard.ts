/**
 * lib/orchestrator/guard.ts — GuardEvaluator: fail-closed policy engine.
 *
 * Rules:
 *   • AND semantics: ALL policies must allow. Any deny → overall deny.
 *   • Fail-closed: if a policy throws, treat it as a deny.
 *   • Fail-closed: no policies + financial/autonomous action → deny.
 *   • Non-financial, non-autonomous action with no policies → allow.
 *     (The orchestrator is the chokepoint; plain reads don't need guards.)
 *
 * Zero external dependencies.
 */

import type { ActionContext, GuardDecision, GuardPolicy } from "./types.ts";

export class GuardEvaluator {
  private readonly policies: GuardPolicy[];
  constructor(policies: GuardPolicy[]) { this.policies = policies; }

  /**
   * Evaluate all policies against the action context.
   *
   * Short-circuits on the first deny — subsequent policies are not called.
   * If a policy throws, the exception is caught and treated as a deny
   * (fail-closed: a broken guard never grants access).
   */
  async evaluate(ctx: ActionContext): Promise<GuardDecision> {
    const { action } = ctx;

    // Fail-closed: financial or autonomous with zero policies = deny
    if (this.policies.length === 0) {
      if (action.isFinancial || action.isAutonomous) {
        return {
          allow: false,
          reason:
            "fail-closed: no guard policies registered for " +
            (action.isFinancial ? "financial" : "autonomous") +
            " action",
        };
      }
      // Non-financial, non-autonomous: allow (plain reads / queries)
      return { allow: true };
    }

    for (const policy of this.policies) {
      let decision: GuardDecision;
      try {
        decision = await policy.evaluate(ctx);
      } catch (err) {
        // Guard crash → fail-closed
        const msg =
          err instanceof Error ? err.message : String(err);
        return {
          allow: false,
          reason: `fail-closed: policy "${policy.name}" threw: ${msg}`,
        };
      }
      if (!decision.allow) {
        return {
          allow: false,
          reason: `policy "${policy.name}" denied: ${decision.reason}`,
        };
      }
    }

    return { allow: true };
  }
}

// ─── Built-in policy helpers ─────────────────────────────────────────────────

/**
 * allowAll() — a passthrough policy that allows everything.
 * Useful as a no-op placeholder in tests or non-critical paths.
 */
export function allowAll(name = "allow-all"): GuardPolicy {
  return {
    name,
    evaluate: () => ({ allow: true }),
  };
}

/**
 * denyAll(reason) — a policy that always denies.
 * Useful for testing fail-closed behaviour and for blocking entire action types.
 */
export function denyAll(reason: string, name = "deny-all"): GuardPolicy {
  return {
    name,
    evaluate: () => ({ allow: false, reason }),
  };
}

/**
 * denyFinancial() — deny any action tagged as financial.
 * Attach this policy to enforce "no autonomous payments" rules.
 */
export function denyFinancial(name = "deny-financial"): GuardPolicy {
  return {
    name,
    evaluate: (ctx) => {
      if (ctx.action.isFinancial) {
        return {
          allow: false,
          reason: "financial actions are not permitted by policy",
        };
      }
      return { allow: true };
    },
  };
}

/**
 * denyAutonomous() — deny any action tagged as autonomous.
 * Attach this policy to require human-in-the-loop for every decision.
 */
export function denyAutonomous(name = "deny-autonomous"): GuardPolicy {
  return {
    name,
    evaluate: (ctx) => {
      if (ctx.action.isAutonomous) {
        return {
          allow: false,
          reason: "autonomous actions are not permitted by policy",
        };
      }
      return { allow: true };
    },
  };
}

/**
 * allowTypes(types) — allow only specific action types, deny everything else.
 * Example: allowTypes(["agent.task.run", "workflow.execute"])
 */
export function allowTypes(
  types: string[],
  name = "allow-types",
): GuardPolicy {
  const allowed = new Set(types);
  return {
    name,
    evaluate: (ctx) => {
      if (allowed.has(ctx.action.type)) return { allow: true };
      return {
        allow: false,
        reason: `action type "${ctx.action.type}" is not in the allowlist`,
      };
    },
  };
}
