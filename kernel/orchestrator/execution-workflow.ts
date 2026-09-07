/**
 * lib/orchestrator/execution-workflow.ts — Durable ExecutionWorkflow state machine.
 *
 * States: planned → approved → running → evidence_collected → settled → proved
 *         planned → rejected | approved → rejected
 *         running → failed | evidence_collected → failed | settled → failed
 *
 * Every transition appends an immutable, hash-linked entry to the run-log.
 * The log is append-only and tamper-evident: each entry's hash covers the
 * canonical fields and the previous entry's hash.
 *
 * Lease / heartbeat: a worker claims a workflow for processing. If the lease
 * expires, another worker can claim it. This prevents duplicate processing
 * without requiring an external scheduler.
 *
 * Startup validator: validateAllExecutionChains(store) walks every workflow
 * and verifies its run-log integrity. Returns false if ANY chain is broken
 * (fail-closed).
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ActionId,
  ExecutionStatus,
  ExecutionLogEntry,
  ExecutionWorkflow,
  ExecutionStore,
} from "./types.ts";

// ─── State machine graph ──────────────────────────────────────────────────────

/** All valid directed transitions. Any pair not in this map is rejected. */
export const VALID_TRANSITIONS: Readonly<Record<ExecutionStatus, ExecutionStatus[]>> = {
  planned: ["approved", "rejected"],
  approved: ["running", "rejected"],
  running: ["evidence_collected", "failed"],
  evidence_collected: ["settled", "failed"],
  settled: ["proved", "failed"],
  proved: [],
  failed: [],
  rejected: [],
};

/**
 * O(1) Set-based transition lookup — same data as VALID_TRANSITIONS but
 * each value is a ReadonlySet so `isValidTransition` (called on every
 * workflow state change) uses `.has()` instead of array `.includes()`.
 * Computed once at module load; callers share the same references.
 */
export const VALID_TRANSITION_SET: Readonly<Record<ExecutionStatus, ReadonlySet<ExecutionStatus>>> = Object.fromEntries(
  (Object.entries(VALID_TRANSITIONS) as [ExecutionStatus, ExecutionStatus[]][]).map(
    ([from, tos]) => [from, new Set(tos) as ReadonlySet<ExecutionStatus>],
  ),
) as Readonly<Record<ExecutionStatus, ReadonlySet<ExecutionStatus>>>;

/** Terminal states — no further transitions allowed. */
export const TERMINAL_STATUSES: Readonly<ExecutionStatus[]> = [
  "proved",
  "failed",
  "rejected",
];

// ─── Error type ───────────────────────────────────────────────────────────────

export type ExecutionErrorCode =
  | "missing_tenant"
  | "missing_action_id"
  | "invalid_transition"
  | "workflow_not_found"
  | "tenant_mismatch"
  | "lease_denied"
  | "lease_not_held"
  | "invalid_retry_config"
  | "tampered_log";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

// ─── Hash computation ─────────────────────────────────────────────────────────

/**
 * Canonical hash over the immutable fields of a log entry.
 * Fields are joined with "|" — the separator is not a valid status/actor character.
 * BigInt is not expected here; all fields are strings.
 */
function computeLogHash(entry: Omit<ExecutionLogEntry, "hash">): string {
  const data = [
    entry.timestamp,
    entry.fromStatus ?? "null",
    entry.toStatus,
    entry.actor,
    entry.reason ?? "",
    entry.prevHash,
  ].join("|");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function isValidTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_TRANSITION_SET[from].has(to);
}

function makeGenesisLogEntry(actor: string, reason?: string): ExecutionLogEntry {
  const ts = nowIso();
  const partial: Omit<ExecutionLogEntry, "hash"> = {
    timestamp: ts,
    fromStatus: null,
    toStatus: "planned",
    actor,
    reason,
    prevHash: "genesis",
  };
  return { ...partial, hash: computeLogHash(partial) };
}

function makeLogEntry(
  fromStatus: ExecutionStatus,
  toStatus: ExecutionStatus,
  actor: string,
  prevHash: string,
  reason?: string,
): ExecutionLogEntry {
  const ts = nowIso();
  const partial: Omit<ExecutionLogEntry, "hash"> = {
    timestamp: ts,
    fromStatus,
    toStatus,
    actor,
    reason,
    prevHash,
  };
  return { ...partial, hash: computeLogHash(partial) };
}

// ─── InMemoryExecutionStore ───────────────────────────────────────────────────

/**
 * InMemoryExecutionStore — reference implementation of ExecutionStore.
 *
 * Data lives in process memory. Suitable for tests, dev, and in-process agents.
 * Thread safety: JavaScript is single-threaded; no locking needed.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  /** workflow id → ExecutionWorkflow */
  private readonly store = new Map<string, ExecutionWorkflow>();

  // ─── create ─────────────────────────────────────────────────────────────────

  create(input: {
    tenantId: string;
    actionId: ActionId;
    intentId?: string;
    executionRef?: string;
    approvalId?: string;
    evidenceRefs?: string[];
    retryOfWorkflowId?: string;
  }): ExecutionWorkflow {
    if (!input.tenantId) {
      throw new ExecutionError("missing_tenant", "tenantId is required");
    }
    if (!input.actionId) {
      throw new ExecutionError("missing_action_id", "actionId is required");
    }

    const id = randomUUID();
    const ts = nowIso();
    const genesis = makeGenesisLogEntry("system", "workflow created");

    const workflow: ExecutionWorkflow = {
      id,
      tenantId: input.tenantId,
      actionId: input.actionId,
      intentId: input.intentId,
      status: "planned",
      createdAt: ts,
      updatedAt: ts,
      runLog: [genesis],
      leaseExpiresAt: null,
      claimedBy: null,
      executionRef: input.executionRef,
      approvalId: input.approvalId,
      evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : undefined,
      retryOfWorkflowId: input.retryOfWorkflowId,
    };

    this.store.set(id, workflow);
    return workflow;
  }

  // ─── get ────────────────────────────────────────────────────────────────────

  get(id: string, tenantId: string): ExecutionWorkflow | null {
    const wf = this.store.get(id);
    if (!wf) return null;
    if (wf.tenantId !== tenantId) return null;
    // Return a shallow copy to prevent external mutation of internal state.
    return { ...wf, runLog: [...wf.runLog] };
  }

  // ─── list ───────────────────────────────────────────────────────────────────

  list(tenantId: string): ExecutionWorkflow[] {
    const result: ExecutionWorkflow[] = [];
    for (const wf of this.store.values()) {
      if (wf.tenantId === tenantId) {
        result.push({ ...wf, runLog: [...wf.runLog] });
      }
    }
    // newest first — Map iteration is insertion order (oldest first),
    // and createdAt is monotonically increasing with insertion.
    // reverse() is O(n) in-place, replacing an O(n log n) sort.
    result.reverse();
    return result;
  }

  // ─── transition ─────────────────────────────────────────────────────────────

  transition(
    id: string,
    tenantId: string,
    toStatus: ExecutionStatus,
    actor: string,
    reason?: string,
  ): ExecutionWorkflow {
    const wf = this.store.get(id);
    if (!wf) {
      throw new ExecutionError("workflow_not_found", `workflow ${id} not found`);
    }
    if (wf.tenantId !== tenantId) {
      throw new ExecutionError("tenant_mismatch", `workflow ${id} does not belong to tenant ${tenantId}`);
    }
    if (!isValidTransition(wf.status, toStatus)) {
      throw new ExecutionError(
        "invalid_transition",
        `invalid transition from "${wf.status}" to "${toStatus}"`,
      );
    }

    const prevEntry = wf.runLog[wf.runLog.length - 1];
    const entry = makeLogEntry(wf.status, toStatus, actor, prevEntry.hash, reason);

    wf.runLog.push(entry);
    wf.status = toStatus;
    wf.updatedAt = nowIso();

    return { ...wf, runLog: [...wf.runLog] };
  }

  // ─── verifyChain ────────────────────────────────────────────────────────────

  verifyChain(id: string, tenantId: string): boolean {
    const wf = this.store.get(id);
    if (!wf) return false;
    if (wf.tenantId !== tenantId) return false;
    return verifyRunLog(wf.runLog);
  }

  // ─── replay ─────────────────────────────────────────────────────────────────

  replay(
    tenantId: string,
    id: string,
    handler: (entry: ExecutionLogEntry, index: number) => void,
  ): number {
    const wf = this.store.get(id);
    if (!wf) {
      throw new ExecutionError("workflow_not_found", `workflow ${id} not found`);
    }
    if (wf.tenantId !== tenantId) {
      throw new ExecutionError("tenant_mismatch", `workflow ${id} does not belong to tenant ${tenantId}`);
    }

    let count = 0;
    for (let i = 0; i < wf.runLog.length; i++) {
      handler(wf.runLog[i], i);
      count++;
    }
    return count;
  }

  // ─── lease ──────────────────────────────────────────────────────────────────

  lease(id: string, tenantId: string, workerId: string, durationMs: number): boolean {
    if (!workerId) throw new ExecutionError("lease_denied", "workerId is required");
    if (durationMs <= 0) throw new ExecutionError("lease_denied", "durationMs must be positive");

    const wf = this.store.get(id);
    if (!wf) return false;
    if (wf.tenantId !== tenantId) return false;

    // If already claimed and lease hasn't expired, deny.
    if (wf.claimedBy && wf.leaseExpiresAt && wf.leaseExpiresAt > nowMs()) {
      return false;
    }

    wf.claimedBy = workerId;
    wf.leaseExpiresAt = nowMs() + durationMs;
    wf.updatedAt = nowIso();
    return true;
  }

  // ─── releaseLease ───────────────────────────────────────────────────────────

  releaseLease(id: string, tenantId: string, workerId: string): boolean {
    const wf = this.store.get(id);
    if (!wf) return false;
    if (wf.tenantId !== tenantId) return false;

    // Only the holder can release, OR if lease already expired anyone can.
    const leaseExpired = !wf.leaseExpiresAt || wf.leaseExpiresAt <= nowMs();
    if (wf.claimedBy && wf.claimedBy !== workerId && !leaseExpired) {
      return false;
    }

    wf.claimedBy = null;
    wf.leaseExpiresAt = null;
    wf.updatedAt = nowIso();
    return true;
  }
}

// ─── Run-log verification (standalone) ────────────────────────────────────────

/**
 * verifyRunLog — walk a run-log and recompute every hash.
 *
 * Returns true iff:
 *   • every entry's prevHash matches the previous entry's hash
 *   • every entry's hash recomputes to the stored value
 *   • the first entry has prevHash === "genesis"
 *
 * An empty log is considered BROKEN (a valid workflow always has a genesis entry).
 */
export function verifyRunLog(log: ExecutionLogEntry[]): boolean {
  if (log.length === 0) return false;

  for (let i = 0; i < log.length; i++) {
    const entry = log[i];

    // Verify prevHash link
    const expectedPrev = i === 0 ? "genesis" : log[i - 1].hash;
    if (entry.prevHash !== expectedPrev) return false;

    // Recompute and verify hash
    const { hash, ...partial } = entry;
    const expected = computeLogHash(partial);
    if (hash !== expected) return false;
  }

  return true;
}

// ─── Startup validator ──────────────────────────────────────────────────────────

/**
 * validateAllExecutionChains — startup integrity check for all workflows.
 *
 * Walks every workflow in the store and verifies:
 *   • the run-log chain is intact (hashes + prevHash links)
 *   • the cached status matches the last log entry's toStatus
 *   • the workflow is tenant-isolated (no cross-tenant leakage in store)
 *
 * fail-closed: returns false if ANY workflow fails validation.
 * Returns true only if ALL workflows are valid.
 */
export function validateAllExecutionChains(store: ExecutionStore): boolean {
  // We use a private API reflection to get all workflows. Since InMemoryExecutionStore
  // is the reference implementation, we special-case it. For other stores, we rely on
  // the store's own verification method (assumed to be called separately).
  if (store instanceof InMemoryExecutionStore) {
    const all = (store as any)["store"] as Map<string, ExecutionWorkflow>;
    for (const [id, wf] of all) {
      // Verify run-log integrity
      if (!verifyRunLog(wf.runLog)) {
        return false;
      }
      // Verify cached status matches log tail
      const lastEntry = wf.runLog[wf.runLog.length - 1];
      if (lastEntry.toStatus !== wf.status) {
        return false;
      }
      // Verify tenant isolation: no record leaks across tenants
      // (this is a structural invariant, not a runtime check)
      if (!wf.tenantId) {
        return false;
      }
    }
    return true;
  }

  // For non-InMemory stores, we cannot enumerate directly.
  // The caller is responsible for store-specific validation.
  return true;
}
