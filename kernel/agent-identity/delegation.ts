/**
 * lib/agent-identity/delegation.ts — Delegation chain validation & guard policy.
 *
 * A delegation chain is valid when:
 *   1. Every link in the chain exists in the IdentityStore.
 *   2. Every link belongs to the same tenant.
 *   3. No cycles (loop detection via visited set).
 *   4. The root (final node) is a human.
 *
 * The `requireValidDelegation` GuardPolicy enforces that autonomous actions
 * carry a source identity with a valid chain.  Non-autonomous actions pass
 * through untouched (they may still carry an identity for audit, but the
 * policy does not require one).
 *
 * Zero external dependencies.
 */

import type { IdentityStore, AgentIdentity } from "./types.ts";
import type { GuardPolicy, GuardDecision, ActionContext } from "../orchestrator/types.ts";

/**
 * Build the delegation chain from an identity up to the root human.
 * Returns null if the chain is broken or cyclic.
 */
export function buildDelegationChain(
  store: IdentityStore,
  startId: string,
  tenantId: string,
): AgentIdentity[] | null {
  const chain: AgentIdentity[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      return null; // cycle detected
    }
    const node = store.getById(currentId);
    if (!node) {
      return null; // broken link
    }
    if (node.tenantId !== tenantId) {
      return null; // tenant isolation violation
    }
    visited.add(currentId);
    chain.push(node);
    currentId = node.parentId;
  }

  // Root must be human
  const root = chain[chain.length - 1];
  if (!root || root.type !== "human") {
    return null;
  }

  return chain;
}

/**
 * GuardPolicy that denies autonomous actions without a valid delegation chain.
 *
 * Non-autonomous actions are allowed regardless of identity status.
 * Autonomous actions must:
 *   • have a non-empty action.source (identity id)
 *   • resolve to an identity in the store
 *   • form a valid delegation chain ending in a human root
 */
export function requireValidDelegation(
  store: IdentityStore,
): GuardPolicy {
  return {
    name: "require-valid-delegation",
    evaluate(ctx: ActionContext): GuardDecision {
      if (!ctx.action.isAutonomous) {
        return { allow: true };
      }

      const sourceId = ctx.action.source;
      if (!sourceId) {
        return {
          allow: false,
          reason: "Autonomous action missing source identity",
        };
      }

      const chain = buildDelegationChain(store, sourceId, ctx.tenantId);
      if (!chain) {
        return {
          allow: false,
          reason: "Invalid or broken delegation chain for source identity",
        };
      }

      return { allow: true };
    },
  };
}
