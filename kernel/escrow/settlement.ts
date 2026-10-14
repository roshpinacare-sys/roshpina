/**
 * lib/escrow/settlement.ts — Settlement State-Machine: post-fund disbursement with partial release.
 *
 * States (fail-closed):
 *   created → held → partially_released → released
 *                      ↓                   ↑
 *                    disputed  → reversed   (authority resolves)
 *
 * Invariants:
 *   • Money moves ONLY via orchestrated transfers — never by mutating balances.
 *   • Tenant isolation on every lookup; cross-tenant access behaves as not_found.
 *   • A guard denial aborts the state change — state stays as it was.
 *   • Each successful release records a kernel auditId on the agreement (provable trail).
 *   • Dispute freezes releases; reverse (from disputed) returns unreleased funds to payer.
 *   • Only the settlement authority (settledBy) may release, partial-release, or reverse.
 *   • K4 (v146): the RAIL artery trips after repeated consecutive failures —
 *     an OPEN breaker refuses the external disbursement call BEFORE it happens
 *     (loud rail_open receipt). The breaker guards the rail, NEVER the ledger:
 *     the internal transfer still lands (ledger-first doctrine intact).
 */
import { randomUUID } from "node:crypto";
import type { LedgerOrchestrator } from "../ledger-orchestrator/ledger-orchestrator";
import type { DisbursementResult, RailRegistry, SettlementRail } from "../settlement-rails/types";
import { ConsecutiveFailuresBreaker, type BreakerOptions } from "./webhook-breaker";
import { validateQuorumApproval, type QuorumConfig, type ThresholdApprovalStore } from "./threshold-approval";

export type SettlementState =
  | "created"
  | "held"
  | "partially_released"
  | "released"
  | "disputed"
  | "reversed";

export interface SettlementAgreement {
  id: string;
  tenantId: string;
  opportunityId: string;
  payerAccountId: string;
  workerAccountId: string;
  escrowAccountId: string;
  totalAmount: bigint;
  releasedAmount: bigint;
  state: SettlementState;
  createdAt: string;
  /** Identity that authorized the settlement — the release authority. */
  settledBy: string;
  /** Audit ids of every release / partial-release transfer recorded in the kernel. */
  releaseAuditIds?: string[];
  /** Audit id of the reversal transfer (disputed → reversed). */
  reversalAuditId?: string;
  /** Audit id of the initial funding transfer. */
  fundAuditId?: string;
  /** Identity that raised the dispute (present only when state === "disputed"). */
  disputedBy?: string;
  /** Optional human-readable reason for the dispute. */
  disputeReason?: string;
  /**
   * Optional threshold amount (μ¢). Releases above this REQUIRE a valid quorum of
   * per-key approval tokens (K1 — enforced HERE in the kernel, fail-closed; before
   * v143 this line was a doc claim with zero enforcement: the H-3 disease).
   */
  thresholdAmount?: bigint;
  /**
   * DisbursementResult records for every external rail disbursal (release / partialRelease).
   * Ordered: oldest first. Absent when no rail is configured or no release has occurred.
   */
  disbursementResults?: DisbursementResult[];
  /**
   * v98 — a rail disbursement that FAILED after its ledger transfer was already
   * recorded. The store always matches the ledger first (zero desync by design);
   * the rail attempt is retried via retryDisburse() with the SAME idempotency
   * key (rail-side dedupe keeps double-disbursement impossible).
   */
  pendingDisburse?: { seq: number; amount: bigint; error: string; at: string };
}

export type SettlementErrorCode =
  | "invalid_input"
  | "not_found"
  | "wrong_state"
  | "tenant_mismatch"
  | "unauthorized"
  | "ledger_denied"
  | "insufficient_funds"
  | "approval_required" // K1: above-threshold release without quorum tokens
  | "approval_denied" // K1: quorum rejected the release (deny / insufficient / forged)
  | "rail_open"; // K4: rail breaker OPEN — external disbursement refused before the call

export class SettlementError extends Error {
  code: SettlementErrorCode;
  constructor(code: SettlementErrorCode, message: string) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
  }
}

export interface CreateSettlementInput {
  tenantId: string;
  opportunityId: string;
  payerAccountId: string;
  workerAccountId: string;
  totalAmount: bigint; // μ¢, must be > 0n
  settledBy: string;
  /**
   * Optional threshold amount (μ¢). When present and a release amount exceeds this,
   * the KERNEL requires a valid Byzantine-floor quorum of per-key approval tokens
   * before any money moves (K1 — enforced in release/partialRelease, fail-closed).
   */
  thresholdAmount?: bigint;
}

/**
 * K1 — quorum verifier configuration for the settlement chokepoint.
 * The keyring arrives from trusted deployment config; it is NEVER taken from a
 * request body (I21: identity from the channel, not the request).
 */
export type SettlementApprovalConfig = QuorumConfig & {
  /** Replay store for consumed approval tokens. */
  store: ThresholdApprovalStore;
};

export interface SettlementStore {
  put(a: SettlementAgreement): Promise<void>;
  get(tenantId: string, id: string): Promise<SettlementAgreement | null>;
  list(tenantId: string): Promise<SettlementAgreement[]>;
}

/** In-memory store (tests/dev). Production: a pg-backed store behind the same interface. */
export class InMemorySettlementStore implements SettlementStore {
  private byTenant = new Map<string, Map<string, SettlementAgreement>>();
  async put(a: SettlementAgreement): Promise<void> {
    let m = this.byTenant.get(a.tenantId);
    if (!m) {
      m = new Map();
      this.byTenant.set(a.tenantId, m);
    }
    m.set(a.id, a);
  }
  async get(tenantId: string, id: string): Promise<SettlementAgreement | null> {
    return this.byTenant.get(tenantId)?.get(id) ?? null; // cross-tenant = null (fail-closed)
  }
  async list(tenantId: string): Promise<SettlementAgreement[]> {
    return [...(this.byTenant.get(tenantId)?.values() ?? [])];
  }
}

export class SettlementService {
  private readonly ledger: LedgerOrchestrator;
  private readonly store: SettlementStore;
  private readonly railRegistry: RailRegistry | null;
  private readonly approvalConfig: SettlementApprovalConfig | null;
  /** K4 — the always-armed breaker on the external rail artery (keyed `tenantId|railId`). */
  private readonly railBreaker: ConsecutiveFailuresBreaker;

  constructor(
    ledger: LedgerOrchestrator,
    store: SettlementStore = new InMemorySettlementStore(),
    railRegistry: RailRegistry | null = null,
    approvalConfig?: SettlementApprovalConfig | null,
    railBreakerOptions?: BreakerOptions | null,
  ) {
    this.ledger = ledger;
    this.store = store;
    this.railRegistry = railRegistry;
    this.approvalConfig = approvalConfig ?? null;
    // K4 — the breaker is ALWAYS armed (no off switch): money-lane defaults are
    // stricter than webhooks (3 consecutive failures, 60s cooldown) because rail
    // disbursements are rare, deliberate events. Config tunes; it never disables.
    this.railBreaker = new ConsecutiveFailuresBreaker({
      threshold: 3,
      cooldownMs: 60_000,
      ...(railBreakerOptions ?? {}),
    });
  }

  /**
   * v98 — single-process operation mutex, keyed per agreement. Serialises every
   * state-changing op (fund/partialRelease/release/retryDisburse/dispute/reverse)
   * so the read→transfer→write window can no longer interleave two ops.
   */
  private readonly opLocks = new Map<string, Promise<unknown>>();

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.opLocks.get(key) ?? Promise.resolve()).catch(() => {});
    const done = prev.then(fn, fn);
    this.opLocks.set(key, done.catch(() => {}));
    return done;
  }

  /**
   * Look up the configured rail for a tenant, falling back to the "*" default.
   * Returns null if no rail is registered (fail-open for disbursement — log only).
   */
  private getRail(tenantId: string): SettlementRail | null {
    return this.railRegistry?.getRail(tenantId) ?? null;
  }

  /**
   * Disburse via the rail after a successful ledger transfer.
   * fail-open: if no rail is configured, log and continue (ledger is the source of truth).
   * fail-closed on bad input (SettlementRailError propagates as SettlementError).
   */
  private async disburse(
    a: SettlementAgreement,
    amount: bigint,
    releaseSeq: number,
  ): Promise<DisbursementResult | null> {
    const rail = this.getRail(a.tenantId);
    if (!rail) return null;

    // K4 — the artery gate: consult the breaker BEFORE touching the external rail.
    const bkKey = `${a.tenantId}|${rail.railId}`;
    const decision = this.railBreaker.canAttempt(bkKey);
    if (!decision.allowed) {
      throw new SettlementError(
        "rail_open",
        `rail '${rail.railId}' is OPEN for tenant '${a.tenantId}' (${decision.consecutiveFailures} consecutive failures since ${decision.since}) — the external call was NOT attempted (K4, fail-closed)`,
      );
    }

    const idempotencyKey = `${a.tenantId}:${a.id}:release:${releaseSeq}`;
    try {
      const result = await rail.disburse({
        idempotencyKey,
        tenantId: a.tenantId,
        settlementId: a.id,
        payeeId: a.workerAccountId,
        amountMicrounits: amount,
        currency: "USD",
        description: `Settlement release ${releaseSeq} for agreement ${a.id}`,
      });
      // K4 — the outcome feeds the breaker: succeeded/pending prove the rail
      // lives; failed counts. A skipped result is an ABSTENTION — never health,
      // never failure — unless it was the half-open probe, which must resolve
      // (re-arm) so the state machine can never wedge on a skipped answer.
      if (result.status === "failed") {
        this.railBreaker.recordFailure(bkKey);
      } else if (result.status === "succeeded" || result.status === "pending") {
        this.railBreaker.recordSuccess(bkKey);
      } else if (decision.state === "half-open") {
        this.railBreaker.recordFailure(bkKey); // abstaining probe re-arms, fresh cooldown
      }
      return result;
    } catch (e: unknown) {
      this.railBreaker.recordFailure(bkKey);
      // Rail errors surface as settlement errors — callers decide retry
      const msg = e instanceof Error ? e.message : String(e);
      throw new SettlementError("ledger_denied", `rail disbursement failed: ${msg}`);
    }
  }

  /**
   * v98 — attempt the rail for a transfer that is ALREADY recorded in the ledger
   * and store, and record the outcome on the agreement without ever throwing:
   * success → appended to disbursementResults; failure → recorded in
   * pendingDisburse (honest, retriable). This is the fail-open-for-rail doctrine
   * implemented for real: the ledger stays the source of truth, the store always
   * matches it, and a dead rail can no longer wedge the agreement or desync
   * releasedAmount from the escrow balance.
   */
  private async attemptDisburse(a: SettlementAgreement, amount: bigint, seq: number): Promise<SettlementAgreement> {
    try {
      const result = await this.disburse(a, amount, seq);
      const next: SettlementAgreement = { ...a };
      if (result && (result.status === "succeeded" || result.status === "pending")) {
        next.disbursementResults = [...(a.disbursementResults ?? []), result];
        delete next.pendingDisburse; // cleared for real — no undefined-valued key left behind
      } else if (result) {
        // v146 (K4 smoke found this): a rail that answers WITHOUT throwing —
        // "failed" or "skipped" — delivered NOTHING. The old code cleared the
        // pending on any result, marking an undelivered disbursement as done.
        // Honest state: still pending, retriable, the abstention recorded loud.
        next.pendingDisburse = {
          seq,
          amount,
          error: `rail did not deliver (status ${result.status}): ${result.message}`.slice(0, 300),
          at: new Date().toISOString(),
        };
      }
      return next;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ...a,
        pendingDisburse: { seq, amount, error: msg.slice(0, 300), at: new Date().toISOString() },
      };
    }
  }

  /**
   * Retry a rail disbursement that failed after its ledger transfer was recorded
   * (pendingDisburse present). Same authority rules; same idempotency key, so a
   * rail that actually processed the earlier attempt dedupes safely.
   */
  async retryDisburse(tenantId: string, id: string, initiatedBy: string): Promise<SettlementAgreement> {
    if (!tenantId || !id) throw new SettlementError("invalid_input", "tenantId and id required");
    if (!initiatedBy) throw new SettlementError("invalid_input", "initiatedBy required");
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.store.get(tenantId, id);
      if (!a) throw new SettlementError("not_found", "settlement agreement not found");
      if (initiatedBy !== a.settledBy) {
        throw new SettlementError(
          "unauthorized",
          `retryDisburse requires the settlement authority ('${a.settledBy}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      if (!a.pendingDisburse) {
        throw new SettlementError("wrong_state", "no pending rail disbursement to retry");
      }
      // K4 — loud refusal OUTSIDE the attempt: when the breaker is OPEN the
      // retry is refused before touching the rail, the original pendingDisburse
      // forensics stay untouched, and the consult is non-consuming (peekDecision
      // never mutates — the gate in disburse() remains the single probe-granter).
      const retryRail = this.getRail(a.tenantId);
      if (retryRail) {
        const retryDecision = this.railBreaker.peekDecision(`${a.tenantId}|${retryRail.railId}`);
        if (!retryDecision.allowed) {
          throw new SettlementError(
            "rail_open",
            `retryDisburse refused: rail '${retryRail.railId}' is OPEN for tenant '${a.tenantId}' (${retryDecision.consecutiveFailures} consecutive failures since ${retryDecision.since}) — pending disbursement preserved, no external call (K4, fail-closed)`,
          );
        }
      }
      const updated = await this.attemptDisburse({ ...a }, a.pendingDisburse.amount, a.pendingDisburse.seq);
      await this.store.put(updated);
      return updated;
    });
  }

  /** Create the agreement + its dedicated settlement ledger account. No money moves yet. */
  async create(input: CreateSettlementInput): Promise<SettlementAgreement> {
    if (!input?.tenantId || !input.opportunityId) {
      throw new SettlementError("invalid_input", "tenantId and opportunityId required");
    }
    if (!input.payerAccountId || !input.workerAccountId) {
      throw new SettlementError("invalid_input", "payerAccountId and workerAccountId required");
    }
    if (input.payerAccountId === input.workerAccountId) {
      throw new SettlementError("invalid_input", "payer and worker must differ");
    }
    if (typeof input.totalAmount !== "bigint" || input.totalAmount <= 0n) {
      throw new SettlementError("invalid_input", "totalAmount must be a positive bigint (μ¢)");
    }
    if (!input.settledBy) {
      throw new SettlementError("invalid_input", "settledBy required");
    }

    const id = randomUUID();
    const escrowAccount = await this.ledger.createAccount(
      input.tenantId,
      `settlement:${id}`,
      "asset",
      `settlement for ${input.opportunityId}`,
    );

    const agreement: SettlementAgreement = {
      id,
      tenantId: input.tenantId,
      opportunityId: input.opportunityId,
      payerAccountId: input.payerAccountId,
      workerAccountId: input.workerAccountId,
      escrowAccountId: escrowAccount.id,
      totalAmount: input.totalAmount,
      releasedAmount: 0n,
      ...(input.thresholdAmount !== undefined ? { thresholdAmount: input.thresholdAmount } : {}),
      state: "created",
      createdAt: new Date().toISOString(),
      settledBy: input.settledBy,
    };
    await this.store.put(agreement);
    return agreement;
  }

  async get(tenantId: string, id: string): Promise<SettlementAgreement | null> {
    return this.store.get(tenantId, id);
  }

  async list(tenantId: string): Promise<SettlementAgreement[]> {
    return this.store.list(tenantId);
  }

  /** payer→settlement escrow through the chokepoint. created→held. */
  async fund(tenantId: string, id: string, initiatedBy: string): Promise<SettlementAgreement> {
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "created");
      if (!initiatedBy || initiatedBy !== a.settledBy) {
        throw new SettlementError(
          "unauthorized",
          `fund requires the settlement authority ('${a.settledBy}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      const res = await this.ledger.transfer(
        tenantId,
        a.payerAccountId,
        a.escrowAccountId,
        a.totalAmount,
        `settlement.fund:${a.id}`,
        initiatedBy,
        false,
      );
      if (!res.ok) {
        throw new SettlementError("ledger_denied", res.reason || "funding denied by guard (fail-closed)");
      }
      const updated: SettlementAgreement = {
        ...a,
        state: "held",
        fundAuditId: res.auditId,
      };
      await this.store.put(updated);
      return updated;
    });
  }

  /**
   * K1 — the threshold quorum law at the money chokepoint.
   * A release above the agreement's thresholdAmount moves ONLY with a valid
   * Byzantine-floor quorum of per-key approval tokens. Fail-closed:
   *   • no verifier configured → approval_required (a declared threshold with
   *     no way to verify it stops money — the end of doc-claims-without-wiring)
   *   • 0/forged/insufficient/denied tokens → approval_denied, nothing consumed
   */
  private enforceQuorum(a: SettlementAgreement, releaseAmount: bigint, tokens: string[]): void {
    if (!this.approvalConfig) {
      throw new SettlementError(
        "approval_required",
        `release ${releaseAmount} µ¢ exceeds threshold ${a.thresholdAmount} µ¢ but no quorum verifier is configured — money does not move on an unverified threshold (K1, fail-closed)`,
      );
    }
    if (!tokens || tokens.length === 0) {
      throw new SettlementError(
        "approval_required",
        `release ${releaseAmount} µ¢ exceeds threshold ${a.thresholdAmount} µ¢; quorum approval tokens are required and none were presented (K1, fail-closed)`,
      );
    }
    try {
      validateQuorumApproval(tokens, a.id, a.tenantId, releaseAmount, this.approvalConfig.store, this.approvalConfig);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SettlementError("approval_denied", `threshold quorum rejected the release: ${msg}`);
    }
  }

  /** K1 gate: does this release amount cross the declared threshold? */
  private crossesThreshold(a: SettlementAgreement, releaseAmount: bigint): boolean {
    return a.thresholdAmount !== undefined && releaseAmount > a.thresholdAmount;
  }

  /**
   * Release a portion of the held funds to the worker.
   * held/partially_released → partially_released (or released if fully drained).
   * Only the settlement authority may call.
   * K1: releases above thresholdAmount require quorum approval tokens.
   */
  async partialRelease(
    tenantId: string,
    id: string,
    amount: bigint,
    initiatedBy: string,
    approvalTokens: string[] = [],
  ): Promise<SettlementAgreement> {
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.requireActive(tenantId, id);
      if (!initiatedBy || initiatedBy !== a.settledBy) {
        throw new SettlementError(
          "unauthorized",
          `partialRelease requires the settlement authority ('${a.settledBy}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      if (typeof amount !== "bigint" || amount <= 0n) {
        throw new SettlementError("invalid_input", "amount must be a positive bigint (μ¢)");
      }
      const remaining = a.totalAmount - a.releasedAmount;
      if (amount > remaining) {
        throw new SettlementError(
          "insufficient_funds",
          `partialRelease amount ${amount} exceeds remaining ${remaining}`,
        );
      }

      // K1 — above-threshold partial release moves only with a valid quorum
      if (this.crossesThreshold(a, amount)) {
        this.enforceQuorum(a, amount, approvalTokens);
      }

      const res = await this.ledger.transfer(
        tenantId,
        a.escrowAccountId,
        a.workerAccountId,
        amount,
        `settlement.partialRelease:${a.id}`,
        initiatedBy,
        false,
      );
      if (!res.ok) {
        throw new SettlementError("ledger_denied", res.reason || "partial release denied by guard (fail-closed)");
      }

      const newReleased = a.releasedAmount + amount;
      const newState: SettlementState = newReleased === a.totalAmount ? "released" : "partially_released";
      const releaseAuditIds = [...(a.releaseAuditIds ?? []), res.auditId!];

      // v98 — persist the LEDGER truth FIRST (store ⇔ ledger always agree), THEN
      // attempt the rail. The old order (transfer → rail → store) wedged the
      // agreement on rail failure: money had moved but releasedAmount never
      // advanced, so the retry double-paid the worker. Now a rail failure only
      // records pendingDisburse — retries converge, nothing desyncs.
      const updated: SettlementAgreement = {
        ...a,
        releasedAmount: newReleased,
        state: newState,
        releaseAuditIds,
      };
      await this.store.put(updated);

      const releaseSeq = (a.disbursementResults ?? []).length + 1;
      const withRail = await this.attemptDisburse(updated, amount, releaseSeq);
      await this.store.put(withRail);
      return withRail;
    });
  }

  /**
   * Release all remaining funds to the worker.
   * held/partially_released → released.
   * Only the settlement authority may call.
   * K1: releases above thresholdAmount require quorum approval tokens.
   */
  async release(tenantId: string, id: string, initiatedBy: string, approvalTokens: string[] = []): Promise<SettlementAgreement> {
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.requireActive(tenantId, id);
      if (!initiatedBy || initiatedBy !== a.settledBy) {
        throw new SettlementError(
          "unauthorized",
          `release requires the settlement authority ('${a.settledBy}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      const remaining = a.totalAmount - a.releasedAmount;
      if (remaining <= 0n) {
        throw new SettlementError("wrong_state", "nothing left to release");
      }

      // K1 — above-threshold full release moves only with a valid quorum
      if (this.crossesThreshold(a, remaining)) {
        this.enforceQuorum(a, remaining, approvalTokens);
      }

      const res = await this.ledger.transfer(
        tenantId,
        a.escrowAccountId,
        a.workerAccountId,
        remaining,
        `settlement.release:${a.id}`,
        initiatedBy,
        false,
      );
      if (!res.ok) {
        throw new SettlementError("ledger_denied", res.reason || "release denied by guard (fail-closed)");
      }

      const releaseAuditIds = [...(a.releaseAuditIds ?? []), res.auditId!];

      // v98 — same ledger-first ordering as partialRelease (zero desync).
      const updated: SettlementAgreement = {
        ...a,
        releasedAmount: a.totalAmount,
        state: "released",
        releaseAuditIds,
      };
      await this.store.put(updated);

      const releaseSeq = (a.disbursementResults ?? []).length + 1;
      const withRail = await this.attemptDisburse(updated, remaining, releaseSeq);
      await this.store.put(withRail);
      return withRail;
    });
  }

  /**
   * Dispute: active → disputed. Either party may raise a dispute.
   * No money moves — only releases are stopped.
   */
  async dispute(
    tenantId: string,
    id: string,
    initiatedBy: string,
    reason?: string,
  ): Promise<SettlementAgreement> {
    if (!initiatedBy) {
      throw new SettlementError("invalid_input", "initiatedBy required to raise a dispute");
    }
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.requireActive(tenantId, id);
      const updated: SettlementAgreement = {
        ...a,
        state: "disputed",
        disputedBy: initiatedBy,
        ...(reason ? { disputeReason: reason } : {}),
      };
      await this.store.put(updated);
      return updated;
    });
  }

  /**
   * Reverse (dispute resolution in payer's favor): disputed → reversed.
   * Returns all unreleased funds to the payer. Only the settlement authority may call.
   */
  async reverse(tenantId: string, id: string, initiatedBy: string): Promise<SettlementAgreement> {
    return this.withLock(`settlement:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "disputed");
      if (!initiatedBy || initiatedBy !== a.settledBy) {
        throw new SettlementError(
          "unauthorized",
          `reverse requires the settlement authority ('${a.settledBy}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      const remaining = a.totalAmount - a.releasedAmount;
      if (remaining > 0n) {
        const res = await this.ledger.transfer(
          tenantId,
          a.escrowAccountId,
          a.payerAccountId,
          remaining,
          `settlement.reverse:${a.id}`,
          initiatedBy,
          false,
        );
        if (!res.ok) {
          throw new SettlementError("ledger_denied", res.reason || "reverse denied by guard (fail-closed)");
        }
        const updated: SettlementAgreement = {
          ...a,
          state: "reversed",
          reversalAuditId: res.auditId,
        };
        await this.store.put(updated);
        return updated;
      }
      // Nothing left to reverse; mark as reversed anyway.
      const updated: SettlementAgreement = { ...a, state: "reversed" };
      await this.store.put(updated);
      return updated;
    });
  }

  private async requireState(
    tenantId: string,
    id: string,
    want: SettlementState,
  ): Promise<SettlementAgreement> {
    if (!tenantId || !id) {
      throw new SettlementError("invalid_input", "tenantId and id required");
    }
    const a = await this.store.get(tenantId, id);
    if (!a) {
      throw new SettlementError("not_found", "settlement agreement not found");
    }
    if (a.state !== want) {
      throw new SettlementError(
        "wrong_state",
        `settlement is '${a.state}', operation requires '${want}'`,
      );
    }
    return a;
  }

  private async requireActive(tenantId: string, id: string): Promise<SettlementAgreement> {
    if (!tenantId || !id) {
      throw new SettlementError("invalid_input", "tenantId and id required");
    }
    const a = await this.store.get(tenantId, id);
    if (!a) {
      throw new SettlementError("not_found", "settlement agreement not found");
    }
    if (a.state !== "held" && a.state !== "partially_released") {
      throw new SettlementError(
        "wrong_state",
        `settlement is '${a.state}', operation requires 'held' or 'partially_released'`,
      );
    }
    return a;
  }
}
