/**
 * lib/agent-identity/types.ts — Agent Identity primitives for accountable autonomy.
 *
 * Invariants:
 *   • Every actor (human, agent, sub-agent) has a canonical AgentIdentity.
 *   • Delegation is hierarchical: human → agent → sub-agent.
 *   • The root of every delegation chain must be a human.
 *   • Tenant isolation: identities are scoped to a tenant.
 *   • An autonomous action without a valid delegation chain is denied (fail-closed).
 *
 * Zero external dependencies.
 */

/** The kind of actor in the delegation hierarchy. */
export type AgentType = "human" | "agent" | "sub-agent";

/** Canonical identity of an autonomous or human actor. */
export interface AgentIdentity {
  /** Globally unique identity id (uuid-style). */
  readonly id: string;
  /** Tenant that owns this identity. */
  readonly tenantId: string;
  /** The actor kind. */
  readonly type: AgentType;
  /** Optional Ed25519 public key for non-repudiation. */
  readonly publicKey?: string;
  /** The identity id this actor delegates from. null for human roots. */
  readonly parentId: string | null;
  /** ISO-8601 timestamp of creation. */
  readonly createdAt: string;
  /** Free-form metadata (never trusted by the kernel). */
  readonly metadata?: Record<string, unknown>;
}

/** Read/write interface for identity storage. */
export interface IdentityStore {
  /** Register a new identity. Throws IdentityError on duplicate id or invalid rules. */
  create(identity: AgentIdentity): AgentIdentity;
  /** Fetch a single identity by id. null if not found. */
  getById(id: string): AgentIdentity | null;
  /** All identities for a tenant (no specific order). */
  getByTenant(tenantId: string): AgentIdentity[];
}

/** Error thrown by the identity subsystem. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(message: string, code: IdentityErrorCode) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

export type IdentityErrorCode =
  | "duplicate_id"
  | "human_with_parent"
  | "agent_without_human_parent"
  | "subagent_without_parent"
  | "parent_not_found"
  | "parent_wrong_tenant";
