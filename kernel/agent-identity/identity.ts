/**
 * lib/agent-identity/identity.ts — In-memory IdentityStore (reference impl).
 *
 * Rules enforced at creation time:
 *   • human  → parentId must be null.
 *   • agent  → parentId must point to a human in the same tenant.
 *   • sub-agent → parentId must point to an agent or sub-agent in the same tenant.
 *
 * Tenant isolation: every lookup is scoped to tenantId implicitly
 * (getByTenant is explicit; getById checks tenant when needed by callers).
 */

import type { IdentityStore, AgentIdentity } from "./types.ts";
import { IdentityError } from "./types.ts";

export class InMemoryIdentityStore implements IdentityStore {
  private readonly store = new Map<string, AgentIdentity>();

  create(identity: AgentIdentity): AgentIdentity {
    if (this.store.has(identity.id)) {
      throw new IdentityError(
        `Identity already exists: ${identity.id}`,
        "duplicate_id",
      );
    }

    // Human must be root (no parent)
    if (identity.type === "human" && identity.parentId !== null) {
      throw new IdentityError(
        `Human identity must not have a parent: ${identity.id}`,
        "human_with_parent",
      );
    }

    // Agent must delegate from a human
    if (identity.type === "agent") {
      if (!identity.parentId) {
        throw new IdentityError(
          `Agent must have a human parent: ${identity.id}`,
          "agent_without_human_parent",
        );
      }
      const parent = this.store.get(identity.parentId);
      if (!parent) {
        throw new IdentityError(
          `Parent not found for agent: ${identity.parentId}`,
          "parent_not_found",
        );
      }
      if (parent.type !== "human") {
        throw new IdentityError(
          `Agent parent must be human: ${identity.parentId}`,
          "parent_not_found",
        );
      }
      if (parent.tenantId !== identity.tenantId) {
        throw new IdentityError(
          `Parent tenant mismatch: ${identity.parentId}`,
          "parent_wrong_tenant",
        );
      }
    }

    // Sub-agent must have a parent (agent or sub-agent)
    if (identity.type === "sub-agent") {
      if (!identity.parentId) {
        throw new IdentityError(
          `Sub-agent must have a parent: ${identity.id}`,
          "subagent_without_parent",
        );
      }
      const parent = this.store.get(identity.parentId);
      if (!parent) {
        throw new IdentityError(
          `Parent not found for sub-agent: ${identity.parentId}`,
          "parent_not_found",
        );
      }
      if (parent.tenantId !== identity.tenantId) {
        throw new IdentityError(
          `Parent tenant mismatch: ${identity.parentId}`,
          "parent_wrong_tenant",
        );
      }
      // parent can be agent or sub-agent — both are valid delegators
    }

    this.store.set(identity.id, identity);
    return identity;
  }

  getById(id: string): AgentIdentity | null {
    return this.store.get(id) ?? null;
  }

  getByTenant(tenantId: string): AgentIdentity[] {
    const out: AgentIdentity[] = [];
    for (const id of this.store.values()) {
      if (id.tenantId === tenantId) out.push(id);
    }
    return out;
  }
}
