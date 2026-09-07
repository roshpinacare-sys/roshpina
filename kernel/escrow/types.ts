/**
 * lib/escrow/types.ts — Sovereign Escrow: completion-contingent payment for the coordination economy.
 * The marketplace's missing core: claim charges a fee, but VALUE COORDINATION needs "pay on completion".
 * Escrow = a dedicated ledger account per agreement. Funding moves payer→escrow; completion moves
 * escrow→worker; cancellation refunds escrow→payer. Every movement flows through the LedgerOrchestrator
 * chokepoint (guard→audit→passport) — the escrow NEVER touches balances directly. States are
 * fail-closed: only funded escrows can release/refund; double-release is impossible.
 *
 * v88 addition: "disputed" state — either party can freeze a funded escrow; only the funder can
 * unfreeze (undispute) back to "funded". Dispute never moves money — it only stops movement.
 */
export type EscrowState = "created" | "funded" | "released" | "refunded" | "disputed";

/**
 * WorkerAttestation — a signed declaration by the worker that the contracted
 * work has been submitted. Attached to a release so the completion agreement
 * is portable: any party can verify independently that the worker acknowledged
 * submission before the funder released payment.
 *
 * The signature covers `${workerId}|${statement}|${attestedAt}` encoded UTF-8.
 */
export interface WorkerAttestation {
  /** Identity of the worker making the declaration (e.g. agentId or userId). */
  workerId: string;
  /** Human-readable statement of what was submitted / completed. */
  statement: string;
  /** ISO 8601 timestamp when the worker made the attestation. */
  attestedAt: string;
  /** base64-encoded signature over `${workerId}|${statement}|${attestedAt}`. */
  signature: string;
  /** Signing algorithm label, e.g. "hmac-sha256" or "ed25519". */
  algorithm: string;
}

export interface EscrowAgreement {
  id: string;
  tenantId: string;
  opportunityId: string;
  /** who pays (opportunity owner / requester) */
  payerAccountId: string;
  /** who gets paid on completion (the claimer / worker) */
  workerAccountId: string;
  /** dedicated ledger account holding the funds while in-flight */
  escrowAccountId: string;
  amount: bigint; // μ¢
  state: EscrowState;
  createdAt: string;
  /** identity that funded the escrow — the settlement authority (only they may release/refund/undispute). */
  fundedBy?: string;
  /** audit ids of the kernel operations (provable trail) */
  fundAuditId?: string;
  settleAuditId?: string;
  /**
   * Optional worker attestation attached at release time.
   * Present when the worker provided a signed work-submission declaration
   * before the funder released payment — makes the completion agreement portable.
   */
  attestation?: WorkerAttestation;
  /**
   * Dispute Freeze (v88): identity that raised the dispute (funder or worker party).
   * Present only when state === "disputed".
   */
  disputedBy?: string;
  /**
   * Dispute Freeze (v88): optional human-readable reason for the dispute.
   */
  disputeReason?: string;
  /**
   * Fee Engine (v97): basis points (1/100 of a percent) collected as coordination fee
   * on release. e.g. 500 = 5%. Stored only when a fee was actually collected.
   */
  feeBasisPoints?: number;
  /**
   * Fee Engine (v97): actual fee amount collected in μ¢. Stored only when collected.
   */
  feeAmount?: bigint;
  /**
   * Fee Engine (v97): platform revenue account that received the fee.
   */
  feeAccountId?: string;
  /**
   * Fee Engine (v97): audit id of the fee transfer recorded in the kernel.
   */
  feeAuditId?: string;
}

export type EscrowErrorCode =
  | "invalid_input" | "not_found" | "wrong_state" | "tenant_mismatch" | "ledger_denied" | "unauthorized" | "dispute_frozen";

export class EscrowError extends Error {
  code: EscrowErrorCode;
  constructor(code: EscrowErrorCode, message: string) {
    super(message);
    this.name = "EscrowError";
    this.code = code;
  }
}
