/**
 * lib/escrow/escrow.ts — Sovereign Escrow service (completion-contingent payment).
 *
 * The coordination-economy primitive on top of the kernel:
 *   create()    → agreement + dedicated escrow ledger account (asset, owned by the agreement).
 *   fund()      → payer→escrow transfer through the LedgerOrchestrator chokepoint (guard+audit+passport).
 *   release()   → escrow→worker transfer (completion payout), only from "funded".
 *   refund()    → escrow→payer transfer (cancellation), only from "funded".
 *   dispute()   → funded→disputed. Either party (funder or worker) may freeze. No money moves.
 *   undispute() → disputed→funded. Only the funder may unfreeze. No money moves.
 *
 * Invariants (fail-closed):
 *   • Money moves ONLY via orchestrated transfers — never by mutating balances.
 *   • State machine is strict: created→funded→(released|refunded|disputed).
 *     disputed→funded (undispute, funder only). Anything else = EscrowError.
 *   • Tenant isolation on every lookup; cross-tenant access behaves as not_found.
 *   • A guard denial (policy) aborts the state change — state stays as it was.
 *   • Each successful step records the kernel auditId on the agreement (provable trail; the
 *     corresponding Action Passports are issued by the kernel automatically).
 *   • Dispute never moves money — it only stops it. Undispute restores movement capability
 *     to the funder only (they must still call release/refund explicitly).
 */
import { randomUUID } from "node:crypto";
import type { LedgerOrchestrator } from "../ledger-orchestrator/ledger-orchestrator";
import type { TrackRecordCache } from "../track-record/track-record-cache";
import { EscrowError, type EscrowAgreement, type EscrowState, type WorkerAttestation } from "./types";

export interface CreateEscrowInput {
  tenantId: string;
  opportunityId: string;
  payerAccountId: string;
  workerAccountId: string;
  amount: bigint; // μ¢, must be > 0n
}

/** Fee Engine (v97): coordination fee configuration. basisPoints = 0–10000 (500 = 5%). */
export interface FeeConfig {
  basisPoints: number;
}

export interface EscrowStore {
  put(a: EscrowAgreement): Promise<void>;
  get(tenantId: string, id: string): Promise<EscrowAgreement | null>;
  list(tenantId: string): Promise<EscrowAgreement[]>;
}

/** In-memory store (tests/dev). Production: a pg-backed store behind the same interface. */
export class InMemoryEscrowStore implements EscrowStore {
  private byTenant = new Map<string, Map<string, EscrowAgreement>>();
  async put(a: EscrowAgreement): Promise<void> {
    let m = this.byTenant.get(a.tenantId);
    if (!m) { m = new Map(); this.byTenant.set(a.tenantId, m); }
    m.set(a.id, a);
  }
  async get(tenantId: string, id: string): Promise<EscrowAgreement | null> {
    return this.byTenant.get(tenantId)?.get(id) ?? null; // cross-tenant = null (fail-closed)
  }
  async list(tenantId: string): Promise<EscrowAgreement[]> {
    return [...(this.byTenant.get(tenantId)?.values() ?? [])];
  }
}

export class EscrowService {
  private readonly ledger: LedgerOrchestrator;
  private readonly store: EscrowStore;
  private readonly trackRecordCache?: TrackRecordCache;
  private readonly feeConfig?: FeeConfig;
  /** Lazy map tenantId → platform fee revenue account id. */
  private readonly platformAccounts = new Map<string, string>();
  /**
   * v98 — single-process operation mutex, keyed per agreement. Serialises every
   * state-changing op (fund/release/refund/dispute/undispute) so the
   * read(requireState)→transfer→write window can no longer interleave two ops
   * (closes the concurrent double-fund TOCTOU: two fund() calls both passing
   * requireState("created") and both debiting the payer). Multi-instance
   * deployments additionally need a store-level CAS behind this same interface —
   * noted for the pg-backed store.
   */
  private readonly opLocks = new Map<string, Promise<unknown>>();

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.opLocks.get(key) ?? Promise.resolve()).catch(() => {});
    const done = prev.then(fn, fn);
    this.opLocks.set(key, done.catch(() => {}));
    return done;
  }

  constructor(
    ledger: LedgerOrchestrator,
    store: EscrowStore = new InMemoryEscrowStore(),
    trackRecordCache?: TrackRecordCache,
    feeConfig?: FeeConfig,
  ) {
    this.ledger = ledger;
    this.store = store;
    this.trackRecordCache = trackRecordCache;
    this.feeConfig = feeConfig;
  }

  /** Invalidate cached track records for identities involved in an agreement. */
  private async invalidateTrackRecords(a: EscrowAgreement): Promise<void> {
    if (!this.trackRecordCache) return;
    const ids = new Set<string>();
    if (a.fundedBy) ids.add(a.fundedBy);
    if (a.workerAccountId) ids.add(a.workerAccountId);
    if (a.payerAccountId) ids.add(a.payerAccountId);
    if (a.disputedBy) ids.add(a.disputedBy);
    for (const id of ids) {
      await this.trackRecordCache.invalidate(a.tenantId, id);
    }
  }

  /**
   * Ensure a platform fee revenue account exists for the tenant.
   * Type=asset so that proofOfSolvency stays green (totalAssets unchanged when fee
   * moves escrow→platform; revenue/expense accounts are ignored in solvency check).
   */
  private async ensurePlatformAccount(tenantId: string): Promise<string> {
    const existing = this.platformAccounts.get(tenantId);
    if (existing) return existing;
    const acc = await this.ledger.createAccount(tenantId, "platform", "asset", "Platform Fee Revenue");
    this.platformAccounts.set(tenantId, acc.id);
    return acc.id;
  }

  /** Compute fee amount from basis points. BigInt division truncates (floor). */
  private computeFee(amount: bigint, basisPoints: number): bigint {
    if (basisPoints <= 0) return 0n;
    if (basisPoints >= 10000) return amount;
    return (amount * BigInt(basisPoints)) / 10000n;
  }

  /** Create the agreement + its dedicated escrow ledger account. No money moves yet. */
  async create(input: CreateEscrowInput): Promise<EscrowAgreement> {
    if (!input?.tenantId || !input.opportunityId) throw new EscrowError("invalid_input", "tenantId and opportunityId required");
    if (!input.payerAccountId || !input.workerAccountId) throw new EscrowError("invalid_input", "payerAccountId and workerAccountId required");
    if (input.payerAccountId === input.workerAccountId) throw new EscrowError("invalid_input", "payer and worker must differ");
    if (typeof input.amount !== "bigint" || input.amount <= 0n) throw new EscrowError("invalid_input", "amount must be a positive bigint (μ¢)");

    const id = randomUUID();
    const escrowAccount = await this.ledger.createAccount(
      input.tenantId, `escrow:${id}`, "asset", `escrow for ${input.opportunityId}`,
    );
    const agreement: EscrowAgreement = {
      id, tenantId: input.tenantId, opportunityId: input.opportunityId,
      payerAccountId: input.payerAccountId, workerAccountId: input.workerAccountId,
      escrowAccountId: escrowAccount.id, amount: input.amount,
      state: "created", createdAt: new Date().toISOString(),
    };
    await this.store.put(agreement);
    // No track-record invalidation on create — no financial or settlement state has changed yet.
    return agreement;
  }

  async get(tenantId: string, id: string): Promise<EscrowAgreement | null> {
    return this.store.get(tenantId, id);
  }

  /** payer→escrow through the chokepoint. created→funded. (v98: mutex — exactly one concurrent fund wins.) */
  async fund(tenantId: string, id: string, initiatedBy: string): Promise<EscrowAgreement> {
    return this.withLock(`escrow:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "created");
      const res = await this.ledger.transfer(
        tenantId, a.payerAccountId, a.escrowAccountId, a.amount,
        `escrow.fund:${a.id}`, initiatedBy, false,
      );
      if (!res.ok) throw new EscrowError("ledger_denied", res.reason || "funding denied by guard (fail-closed)");
      const updated: EscrowAgreement = { ...a, state: "funded", fundAuditId: res.auditId, fundedBy: initiatedBy };
      await this.store.put(updated);
      await this.invalidateTrackRecords(updated);
      return updated;
    });
  }

  /**
   * escrow→worker on completion. funded→released.
   * SETTLEMENT AUTHORITY (the keystone): completion is an AGREEMENT, not an API call.
   * Only the identity that funded the escrow may declare completion and release the funds.
   * Any other caller → "unauthorized" (recorded; state unchanged). This closes the hole where
   * anyone could release money — the payer's release IS the signed completion agreement.
   *
   * Fee Engine (v97): if a feeConfig is configured, a coordination fee (basis points)
   * is automatically deducted on release and transferred to the platform revenue account.
   * The worker receives the remainder. Fee = 0 or no config = normal release (backward compat).
   * Only-on-success: fee is never collected on refund, dispute, or failed release.
   *
   * @param attestation — optional signed declaration by the worker that work was submitted.
   *   Stored on the agreement and available for passport issuance, making the completion
   *   agreement portable and independently verifiable.
   */
  async release(
    tenantId: string,
    id: string,
    initiatedBy: string,
    attestation?: WorkerAttestation,
  ): Promise<EscrowAgreement> {
    return this.withLock(`escrow:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "funded");
      if (!initiatedBy || initiatedBy !== a.fundedBy) {
        throw new EscrowError("unauthorized", `release requires the funding authority ('${a.fundedBy ?? "unknown"}'); caller '${initiatedBy}' denied (fail-closed)`);
      }

      let feeAmount = 0n;
      let platformAccountId: string | undefined;
      if (this.feeConfig && this.feeConfig.basisPoints > 0) {
        feeAmount = this.computeFee(a.amount, this.feeConfig.basisPoints);
        if (feeAmount > 0n) {
          platformAccountId = await this.ensurePlatformAccount(tenantId);
        }
      }
      const workerAmount = a.amount - feeAmount;

      // v98 RESUME LOG — the two-leg payout is now crash-safe and convergent:
      // the worker leg is persisted to the store THE MOMENT it lands (state stays
      // "funded"), BEFORE the fee leg is attempted. A denial/crash after the
      // worker leg can no longer wedge the agreement (the old code threw with
      // the worker paid and nothing recorded — retries always failed
      // INSUFFICIENT_FUNDS and the fee was stranded). Every release() retries
      // exactly the legs whose auditId is not yet on the agreement, so repeated
      // calls converge to "released" with the worker paid exactly once and the
      // fee collected exactly once. Total outflow from escrow = a.amount always.
      let settleAuditId = a.settleAuditId;
      if (workerAmount > 0n && !settleAuditId) {
        const workerRes = await this.ledger.transfer(
          tenantId, a.escrowAccountId, a.workerAccountId, workerAmount,
          `escrow.release:${a.id}`, initiatedBy, false,
        );
        if (!workerRes.ok) throw new EscrowError("ledger_denied", workerRes.reason || "release denied by guard (fail-closed)");
        settleAuditId = workerRes.auditId;
        await this.store.put({ ...a, settleAuditId }); // persist progress BEFORE fee leg (no invalidate — same identities)
      }

      let feeAuditId = a.feeAuditId;
      if (feeAmount > 0n && platformAccountId && !feeAuditId) {
        const feeRes = await this.ledger.transfer(
          tenantId, a.escrowAccountId, platformAccountId, feeAmount,
          `escrow.fee:${a.id}`, initiatedBy, false,
        );
        if (!feeRes.ok) {
          throw new EscrowError("ledger_denied", `${feeRes.reason || "fee transfer denied by guard (fail-closed)"} — worker leg already settled (audit ${settleAuditId ?? "n/a"}); retry release() to collect the fee; no funds are stranded`);
        }
        feeAuditId = feeRes.auditId;
      }

      const updated: EscrowAgreement = {
        ...a,
        state: "released",
        settleAuditId,
        ...(attestation !== undefined ? { attestation } : {}),
        ...(feeAmount > 0n
          ? {
              feeBasisPoints: this.feeConfig!.basisPoints,
              feeAmount,
              feeAccountId: platformAccountId,
              feeAuditId,
            }
          : {}),
      };
      await this.store.put(updated);
      await this.invalidateTrackRecords(updated);
      return updated;
    });
  }

  /**
   * escrow→payer on cancellation. funded→refunded.
   * Authority: the funder (cancelling their own escrow) — and no one else. A worker who wants to
   * walk away asks the funder to refund; money never moves on an unauthorized voice.
   */
  async refund(tenantId: string, id: string, initiatedBy: string): Promise<EscrowAgreement> {
    return this.withLock(`escrow:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "funded");
      if (!initiatedBy || initiatedBy !== a.fundedBy) {
        throw new EscrowError("unauthorized", `refund requires the funding authority ('${a.fundedBy ?? "unknown"}'); caller '${initiatedBy}' denied (fail-closed)`);
      }
      // v98: a recorded settleAuditId on a "funded" agreement means the release()
      // worker leg already moved (resume log). The escrow now holds only the fee
      // remainder — a full refund would just fail INSUFFICIENT_FUNDS. Refuse it
      // honestly instead.
      if (a.settleAuditId) {
        throw new EscrowError("wrong_state", "release worker leg already settled — refund unavailable (escrow holds only the fee remainder); complete release() instead");
      }
      const res = await this.ledger.transfer(
        tenantId, a.escrowAccountId, a.payerAccountId, a.amount,
        `escrow.refund:${a.id}`, initiatedBy, false,
      );
      if (!res.ok) throw new EscrowError("ledger_denied", res.reason || "refund denied by guard (fail-closed)");
      const updated: EscrowAgreement = { ...a, state: "refunded", settleAuditId: res.auditId };
      await this.store.put(updated);
      await this.invalidateTrackRecords(updated);
      return updated;
    });
  }

  /**
   * Dispute Freeze (v88): funded→disputed. Either party (funder or any identity raising a
   * concern) may raise a dispute. No money moves — only movement is stopped.
   *
   * Authorization model: any non-empty `initiatedBy` may raise a dispute on a funded escrow.
   * The dispute is a FREEZE, not a transfer. Since no money moves, an unauthorized raise is
   * recoverable: the funder can always call undispute(). The critical invariant — only the
   * funder controls money movement — is maintained because release/refund require "funded" state.
   *
   * @param reason — optional human-readable explanation stored on the agreement.
   */
  async dispute(tenantId: string, id: string, initiatedBy: string, reason?: string): Promise<EscrowAgreement> {
    if (!initiatedBy) throw new EscrowError("invalid_input", "initiatedBy required to raise a dispute");
    return this.withLock(`escrow:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "funded");
      const updated: EscrowAgreement = {
        ...a,
        state: "disputed",
        disputedBy: initiatedBy,
        ...(reason ? { disputeReason: reason } : {}),
      };
      await this.store.put(updated);
      await this.invalidateTrackRecords(updated);
      return updated;
    });
  }

  /**
   * Dispute Unfreeze (v88): disputed→funded. Only the funder may unfreeze.
   * Restores the escrow to "funded" state so the funder can then release or refund.
   * No money moves — only movement capability is restored.
   */
  async undispute(tenantId: string, id: string, initiatedBy: string): Promise<EscrowAgreement> {
    if (!initiatedBy) throw new EscrowError("invalid_input", "initiatedBy required to undispute");
    return this.withLock(`escrow:${tenantId}:${id}`, async () => {
      const a = await this.requireState(tenantId, id, "disputed");
      if (initiatedBy !== a.fundedBy) {
        throw new EscrowError(
          "unauthorized",
          `undispute requires the funding authority ('${a.fundedBy ?? "unknown"}'); caller '${initiatedBy}' denied (fail-closed)`,
        );
      }
      // Clear dispute fields; restore to funded
      const { disputedBy: _d, disputeReason: _r, ...rest } = a as any;
      const updated: EscrowAgreement = { ...rest, state: "funded" };
      await this.store.put(updated);
      await this.invalidateTrackRecords(updated);
      return updated;
    });
  }

  private async requireState(tenantId: string, id: string, want: EscrowState): Promise<EscrowAgreement> {
    if (!tenantId || !id) throw new EscrowError("invalid_input", "tenantId and id required");
    const a = await this.store.get(tenantId, id);
    if (!a) throw new EscrowError("not_found", "escrow agreement not found");
    if (a.state !== want) throw new EscrowError("wrong_state", `escrow is '${a.state}', operation requires '${want}'`);
    return a;
  }
}
