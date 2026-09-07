/**
 * lib/orchestrator/types.ts — TFA Orchestrator Spine: shared types.
 *
 * Every autonomous or financial action in TFA must flow through:
 *   Action → Guard (all policies, fail-closed) → Executor → Audit
 *
 * Invariants:
 *   • Executor is NEVER called if the guard denies.
 *   • Audit is ALWAYS written (allowed / denied / error).
 *   • No policy registered for financial/autonomous action → DENY (fail-closed).
 *   • Audit chain is hash-linked — every record's prevHash matches the previous
 *     record's hash, making tampering detectable.
 *   • Tenant isolation: every record carries tenantId; chains are per-tenant.
 *
 * This module has zero external dependencies — node:crypto only.
 */

// ─── Primitive types ──────────────────────────────────────────────────────────

/** ISO-8601 timestamp string. */
export type ISOTimestamp = string;

/** Unique action id (uuid-style). */
export type ActionId = string;

/** Unique audit record id (uuid-style). */
export type AuditId = string;

// ─── Action ───────────────────────────────────────────────────────────────────

/**
 * Action<T> — a unit of autonomous or financial work.
 *
 * T is the payload type; the orchestrator is opaque to payload structure.
 * The caller tags financial/autonomous so the guard can apply stricter checks.
 */
export interface Action<T = unknown> {
  /** Globally unique id for idempotency checks. */
  id: ActionId;
  /** Tenant that owns this action. MUST match all business entities involved. */
  tenantId: string;
  /**
   * Hierarchical dot-notation type, e.g.
   * "agent.task.run", "billing.charge", "workflow.execute".
   */
  type: string;
  /** The data associated with the action. Must be serialisable. */
  payload: T;
  /** Which agent / service / user initiated this action. */
  source: string;
  /**
   * If true, the action touches money (μ¢ ledger).
   * Fail-closed: any financial action is DENIED if no policies are registered.
   */
  isFinancial: boolean;
  /**
   * If true, the action was triggered without direct human input (agent-driven).
   * Fail-closed: any autonomous action is DENIED if no policies are registered.
   */
  isAutonomous: boolean;
  /** When the action was requested (set by the caller). */
  requestedAt: ISOTimestamp;
  /**
   * Optional monetary value in micro-cents (μ¢) for financial actions.
   * When present, the spend-budget policy uses this for pre-authorization.
   * Fallback extraction (payload.amount / payload.valueMicrounits) is used
   * when this field is absent.
   */
  valueMicrounits?: bigint;
}

// ─── Guard ────────────────────────────────────────────────────────────────────

/**
 * ApprovalClass — the canonical approval policy taxonomy (data, not code).
 * Maps from ActionRiskClass to the required approval mechanism.
 * fail-closed: an unmapped risk class defaults to "deny".
 */
export type ApprovalClass =
  | "auto"
  | "opa_check"
  | "human"
  | "threshold_escrow"
  | "deny";

/**
 * ActionContext — everything a GuardPolicy can see when evaluating an action.
 * Policies must not call executors or produce side-effects.
 */
export interface ActionContext {
  action: Action;
  tenantId: string;
  /** When the orchestrator started evaluating this action. */
  timestamp: ISOTimestamp;
  /**
   * Risk classification of the action, injected by the `injectRiskClass` guard
   * (see lib/risk/action-risk.ts) before downstream policies evaluate. Optional
   * for backward-compat: a ctx built without the guard simply has no riskClass.
   * This is the first sub-step of "ActionRiskClass + ApprovalPolicy" — the field
   * the approval router will read once it exists.
   */
  riskClass?: ActionRiskClass;
  /**
   * Signed decision trace from the approval policy router, attached to the audit
   * record so the approval decision is tamper-evident. Optional: only present when
   * the approval-policy-router guard (lib/risk/approval-policy.ts) is wired.
   */
  approvalTrace?: string;
  /**
   * Agent-supplied confidence score in [0.0, 1.0].
   * Used by ConfidenceGate (lib/risk/confidence-gate.ts) to override or supplement
   * the risk-class-based approval class.
   * fail-closed: values outside [0, 1] or non-numeric are treated as 0 (lowest confidence).
   */
  confidenceScore?: number;
  /**
   * Signed decision trace from the ConfidenceGate, attached to the audit record.
   * Only present when the confidence-gate GuardPolicy is wired.
   */
  confidenceGateTrace?: string;
  /**
   * Optional behavioural context for contextual risk scoring.
   * See lib/risk/contextual-risk.ts for the canonical shape.
   * When present, the approval policy router feeds this to scoreContextualRisk
   * so the decision trace captures behavioural escalation signals.
   */
  riskContext?: Record<string, unknown>;
  /**
   * Actor reputation trust score (0–100) from track-record cache.
   * Injected by an upstream guard policy (e.g. injectReputationScore)
   * before the approval policy router evaluates. Optional: when absent
   * assessRisk treats the actor as "new" (no history).
   */
  reputationScore?: number;
  /**
   * Vendor-neutral agent provenance (v320). Normalized cross-vendor identity
   * of the agent that performed this action. When present it is threaded into
   * the DecisionTrace so the agent's identity is cryptographically bound to the
   * policy decision (not just the outer receipt). Injected by runActionThroughTfa
   * before policy evaluation when provenance is supplied in RunActionOptions.
   */
  agentProvenance?: {
    vendor: string;
    vendorRaw: string;
    agentId: string;
    product?: string;
    model?: string;
    sessionId?: string;
    provenanceId: string;
  };
}

/**
 * ActionRiskClass — the canonical risk taxonomy (data, not code).
 * Ordered loosely from least to most dangerous. The approval router maps each
 * class to an ApprovalPolicy (auto / OPA-check / human / threshold+escrow / deny).
 * fail-closed default for an UNMAPPED action type is the most-restrictive class.
 */
export type ActionRiskClass =
  | "read_only"
  | "write_safe"
  | "write_destructive"
  | "value_moving"
  | "irreversible"
  | "privacy_sensitive"
  | "regulated";

/**
 * GuardDecision — the binary output of a policy evaluation.
 * A deny carries a human-readable reason for the audit log.
 */
export type GuardDecision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * GuardPolicy — a named rule that approves or denies an action.
 *
 * Policies are evaluated with AND semantics: ALL must allow.
 * If any policy throws, the orchestrator treats it as a deny (fail-closed).
 */
export interface GuardPolicy {
  name: string;
  evaluate(ctx: ActionContext): GuardDecision | Promise<GuardDecision>;
}

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * ActionExecutor<T, R> — runs the actual business logic if the guard allows.
 *
 * Must be idempotent when possible (the orchestrator may retry on error).
 * Throwing causes an "error" audit entry and an { ok: false } result.
 */
export type ActionExecutor<T = unknown, R = unknown> = (
  action: Action<T>,
  ctx: ActionContext,
) => Promise<R>;

// ─── Audit ────────────────────────────────────────────────────────────────────

/** Outcome of an orchestrated action. */
export type AuditOutcome = "allowed" | "denied" | "error";

/**
 * AuditRecord — an immutable, hash-linked entry in a per-tenant audit chain.
 *
 * hash = SHA-256( id | tenantId | actionType | outcome | prevHash )
 * The first record in a tenant's chain has prevHash = "genesis".
 *
 * Verifying the chain: walk from record 0, recompute each hash, and check
 * that prevHash[i] === hash[i-1]. Any tampering breaks the chain.
 */
export interface AuditRecord {
  id: AuditId;
  tenantId: string;
  actionId: ActionId;
  actionType: string;
  /** Which agent / service produced the action. */
  source: string;
  outcome: AuditOutcome;
  /** Human-readable explanation for "denied" or "error" outcomes. */
  reason?: string;
  occurredAt: ISOTimestamp;
  /**
   * Hash of the previous AuditRecord in this tenant's chain.
   * "genesis" for the first record.
   */
  prevHash: string;
  /** SHA-256 of this record's canonical fields. */
  hash: string;
  /**
   * Cryptographic signature over `hash`, proving *who* wrote this record.
   * Optional for backward compatibility; when present verifyChain also
   * checks signature validity.  Signed by the kernel's Signer (HMAC or Ed25519).
   */
  signature?: string;
}

/**
 * AuditStore — read/write interface for the tamper-evident audit chain.
 *
 * Implementations: InMemoryAuditStore (this package), PgAuditStore (src/).
 */
export interface AuditStore {
  /**
   * Append a new record to the tenant's chain.
   * The store computes prevHash and hash automatically.
   */
  append(record: Omit<AuditRecord, "hash" | "prevHash">): AuditRecord;
  /** Return all records for a tenant in insertion order. */
  getChain(tenantId: string): AuditRecord[];
  /**
   * Walk the chain and verify every hash link.
   * Returns true if the chain is intact, false if any record was tampered.
   * An empty chain is considered intact (returns true).
   */
  verifyChain(tenantId: string): boolean;
  /** Look up a single record by its id (across all tenants). */
  getRecord(id: AuditId): AuditRecord | null;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * OrchestrationResult<R> — the outcome of Orchestrator.run().
 *
 * Both branches carry an auditId so callers can cross-reference the audit log.
 */
export type OrchestrationResult<R = unknown> =
  | { ok: true; result: R; auditId: AuditId }
  | { ok: false; reason: string; auditId: AuditId };

/**
 * AsyncAuditStore — DB-backed variant of AuditStore.
 *
 * All methods return Promises so callers must await them.
 * Use PgAuditStore (lib/orchestrator/pg-audit.ts) which implements this.
 *
 * Design note: AuditStore is kept synchronous for backwards compatibility
 * with InMemoryAuditStore + TfaOrchestrator. For production persistence use
 * PgAuditStore directly (standalone, not wired through TfaOrchestrator).
 */
export interface AsyncAuditStore {
  /** Initialise the backing store (create tables if they don't exist). */
  init(): Promise<void>;
  /** Append a record — prevHash and hash are computed automatically. */
  append(record: Omit<AuditRecord, "hash" | "prevHash">): Promise<AuditRecord>;
  /** All records for a tenant in insertion order. */
  getChain(tenantId: string): Promise<AuditRecord[]>;
  /** Walk the chain and verify every hash link. Empty chain → true. */
  verifyChain(tenantId: string): Promise<boolean>;
  /** Fetch a single record by id. null if not found. */
  getRecord(id: AuditId): Promise<AuditRecord | null>;
}

// ─── Signer ───────────────────────────────────────────────────────────────────

/**
 * Signer — produces and verifies cryptographic proofs over audit hashes.
 *
 * Every record's signature covers the *hash* field (not raw data), so
 * tampering with any field breaks both the hash chain *and* the signature.
 *
 * Implementations:
 *   • HmacSigner   — symmetric, default, zero-config (node:crypto HMAC-SHA256)
 *   • Ed25519Signer — asymmetric, non-repudiation, requires key generation
 *
 * Zero external dependencies — node:crypto only.
 */
export interface Signer {
  /** Human-readable algorithm label, e.g. "hmac-sha256" or "ed25519". */
  readonly algorithm: string;
  /**
   * Key identifier — stable, opaque reference to the signing key.
   *
   * HmacSigner: undefined (symmetric keys have no distributable public reference).
   * Ed25519Signer: hex-encoded SHA-256 prefix of the SPKI PEM (first 16 hex chars = 64-bit
   *   fingerprint), stable across process restarts for the same key pair.
   *
   * Embedded in ExecutionReceipt and ActionPassport so verifiers can resolve the
   * signing key from a KeyRing without iterating all keys.
   */
  readonly kid?: string;
  /** Sign canonical data (typically the hex hash). Returns base64 string. */
  sign(data: string): string;
  /** Verify a base64 signature against canonical data. */
  verify(data: string, signature: string): boolean;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Orchestrator — the single chokepoint for autonomous/financial actions.
 *
 * Usage:
 * ```ts
 * const orch = new TfaOrchestrator([allowAgentPolicy, financialLimitPolicy]);
 * const result = await orch.run(action, async (a) => myService.execute(a));
 * if (!result.ok) throw new ForbiddenError(result.reason);
 * ```
 */
export interface Orchestrator {
  run<T, R>(
    action: Action<T>,
    executor: ActionExecutor<T, R>,
  ): Promise<OrchestrationResult<R>>;
  /** Direct access to the audit store for inspection / proofs. */
  readonly audit: AuditStore;
}

// ─── ActionIntent ─────────────────────────────────────────────────────────────

/**
 * PrivacyLevel — canonical sensitivity taxonomy for ActionIntent.
 * Ordered from least to most restrictive.
 */
export type PrivacyLevel =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/**
 * ActionIntent — canonical declaration of what an actor wants to do.
 *
 * This is the DATA layer of intent: before an action is turned into an
 * `Action<T>` and fed to the orchestrator, it is described as an intent
 * so that risk classification, approval policy, and evidence requirements
 * can be evaluated statically.
 *
 * Invariants:
 *   • valueMicrounits is always BigInt μ¢ (never number, never float).
 *   • expiry is ISO-8601 and must be in the future at validation time.
 *   • riskClass is one of the canonical ActionRiskClass values.
 *   • All string fields are non-empty.
 *   • tenantId isolates the intent to a single tenant.
 */
export interface ActionIntent {
  /** Tenant that owns this intent. */
  tenantId: string;
  /** Unique identifier of the actor (user, agent, or service). */
  actorId: string;
  /** Identifier of the tool / capability being invoked. */
  toolId: string;
  /** Reference to the resource being acted upon. */
  resourceRef: string;
  /** Canonical risk classification. */
  riskClass: ActionRiskClass;
  /** Monetary value in micro-cents (μ¢). Always BigInt. */
  valueMicrounits: bigint;
  /** Privacy sensitivity level. */
  privacyLevel: PrivacyLevel;
  /** Reference to the approval policy that governs this intent. */
  approvalPolicyRef: string;
  /** Unique nonce for replay protection. */
  nonce: string;
  /** ISO-8601 timestamp after which the intent is invalid. */
  expiry: ISOTimestamp;
  /** Origin / provenance of the intent (e.g. "api", "webhook", "agent"). */
  provenance: string;
  /** Evidence collection policy reference. */
  evidencePolicy: string;
}

// ─── ExecutionWorkflow ──────────────────────────────────────────────────────────

/**
 * ExecutionStatus — the canonical state machine for durable execution.
 *
 * Valid transitions (directed acyclic graph):
 *   planned → approved → running → evidence_collected → settled → proved
 *   planned → rejected
 *   approved → rejected
 *   running → failed
 *   evidence_collected → failed
 *   settled → failed
 *
 * fail-closed: any transition not in the VALID_TRANSITIONS map is rejected.
 */
export type ExecutionStatus =
  | "planned"
  | "approved"
  | "running"
  | "evidence_collected"
  | "settled"
  | "proved"
  | "failed"
  | "rejected";

/**
 * ExecutionLogEntry — an immutable, hash-linked entry in a workflow's run-log.
 *
 * Every state transition appends one entry. The run-log is append-only
 * and tamper-evident: each entry's hash covers the canonical fields and
 * the previous entry's hash, making insertion, deletion, or mutation
 * detectable via verifyRunLog().
 */
export interface ExecutionLogEntry {
  /** ISO-8601 timestamp of the transition. */
  timestamp: ISOTimestamp;
  /** The status before this transition (null for the genesis entry). */
  fromStatus: ExecutionStatus | null;
  /** The status after this transition. */
  toStatus: ExecutionStatus;
  /** Who or what caused the transition (workerId, userId, or service name). */
  actor: string;
  /** Human-readable reason for the transition. */
  reason?: string;
  /** SHA-256 of the canonical entry fields (covers fromStatus, toStatus, actor, reason, prevHash). */
  hash: string;
  /** Hash of the previous entry in the run-log. "genesis" for the first entry. */
  prevHash: string;
}

/**
 * ExecutionWorkflow — a durable, auditable unit of work.
 *
 * Every autonomous or financial action that needs durable execution
 * (survives restarts, supports replay, has lease-based concurrency control)
 * is wrapped in an ExecutionWorkflow.
 *
 * The run-log is the source of truth for the workflow's history.
 * The current status is derived from the last log entry but is also
 * cached as a field for efficient querying.
 */
export interface ExecutionWorkflow {
  /** Globally unique workflow id. */
  id: string;
  /** Tenant that owns this workflow. */
  tenantId: string;
  /** The Action that this workflow executes. */
  actionId: ActionId;
  /** Optional reference to the ActionIntent that spawned this workflow. */
  intentId?: string;
  /** Current cached status (derived from the run-log tail). */
  status: ExecutionStatus;
  /** When the workflow was created. */
  createdAt: ISOTimestamp;
  /** When the workflow or its log was last updated. */
  updatedAt: ISOTimestamp;
  /** Append-only, hash-linked run-log of all state transitions. */
  runLog: ExecutionLogEntry[];
  /** Unix timestamp (ms) when the current lease expires. Null if unclaimed. */
  leaseExpiresAt: number | null;
  /** Which worker instance currently holds the lease. Null if unclaimed. */
  claimedBy: string | null;
  /** Optional canonical reference for external systems. */
  executionRef?: string;
  /** Approval ID that authorized this workflow (from the approval policy router). */
  approvalId?: string;
  /** References to evidence collected during execution. */
  evidenceRefs?: string[];
  /** If this workflow is a retry of a failed workflow, the id of that workflow. */
  retryOfWorkflowId?: string;
}

/**
 * ExecutionStore — durable storage for execution workflows.
 *
 * Implementations: InMemoryExecutionStore (reference, zero-dep),
 * PgExecutionStore (production, PostgreSQL-backed).
 *
 * Contract:
 *   • create — validates input, sets status="planned", seeds genesis log entry.
 *   • get — returns the workflow ONLY if tenantId matches (tenant isolation).
 *   • list — returns all workflows for a tenant, newest first.
 *   • transition — validates the state transition, appends log entry, updates status.
 *   • verifyChain — recomputes every log entry hash and checks prevHash links.
 *   • replay — re-invokes handlers for each log entry (read-only over the log).
 *   • lease / releaseLease — concurrency control for worker processing.
 */
export interface ExecutionStore {
  create(input: {
    tenantId: string;
    actionId: ActionId;
    intentId?: string;
    executionRef?: string;
    approvalId?: string;
    evidenceRefs?: string[];
    retryOfWorkflowId?: string;
  }): ExecutionWorkflow;

  get(id: string, tenantId: string): ExecutionWorkflow | null;

  list(tenantId: string): ExecutionWorkflow[];

  transition(
    id: string,
    tenantId: string,
    toStatus: ExecutionStatus,
    actor: string,
    reason?: string,
  ): ExecutionWorkflow;

  verifyChain(id: string, tenantId: string): boolean;

  replay(
    tenantId: string,
    id: string,
    handler: (entry: ExecutionLogEntry, index: number) => void,
  ): number;

  lease(id: string, tenantId: string, workerId: string, durationMs: number): boolean;

  releaseLease(id: string, tenantId: string, workerId: string): boolean;
}

/**
 * AsyncExecutionStore — Promise-based variant of ExecutionStore for DB-backed implementations.
 *
 * Used by PgExecutionStore (PostgreSQL). All methods return Promises so
 * pool.query() can be awaited properly. Mirrors the same contract as ExecutionStore
 * but every return value is wrapped in Promise<>.
 *
 * Routes that need to work with either variant should use:
 *   `ExecutionStore | AsyncExecutionStore` and `await Promise.resolve(store.get(...))`.
 */
export interface AsyncExecutionStore {
  init(): Promise<void>;

  create(input: {
    tenantId: string;
    actionId: ActionId;
    intentId?: string;
    executionRef?: string;
    approvalId?: string;
    evidenceRefs?: string[];
    retryOfWorkflowId?: string;
  }): Promise<ExecutionWorkflow>;

  get(id: string, tenantId: string): Promise<ExecutionWorkflow | null>;

  list(tenantId: string): Promise<ExecutionWorkflow[]>;

  transition(
    id: string,
    tenantId: string,
    toStatus: ExecutionStatus,
    actor: string,
    reason?: string,
  ): Promise<ExecutionWorkflow>;

  verifyChain(id: string, tenantId: string): Promise<boolean>;

  replay(
    tenantId: string,
    id: string,
    handler: (entry: ExecutionLogEntry, index: number) => void,
  ): Promise<number>;

  lease(id: string, tenantId: string, workerId: string, durationMs: number): Promise<boolean>;

  releaseLease(id: string, tenantId: string, workerId: string): Promise<boolean>;
}
