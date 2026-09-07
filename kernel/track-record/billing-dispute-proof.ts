/**
 * lib/track-record/billing-dispute-proof.ts — Billing-dispute proof.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a vendor charges for an action, the billed amount should match the
 * value that TFA authorized in the signed ExecutionReceipt.  If a discrepancy
 * occurs — overcharge, double-bill, or billing for a denied action — the
 * tenant needs a portable, verifiable artifact to present to the vendor or a
 * mediator that proves:
 *
 *   "TFA authorized X μ¢ for intentId I (or denied the action entirely), but
 *    you billed Y μ¢."
 *
 * This module produces and verifies that artifact.
 *
 * WHAT IS SIGNED
 * --------------
 * The proof commits to: version · tenantId · intentId · authorizedMicrounits ·
 * billedMicrounits · decision · discrepancyType · issuedAt · signerId.
 * Tampering with any field breaks the signature (fail-closed).
 * Money values are decimal strings on the wire (BigInt internally); no float
 * is ever used (same convention as the rest of the codebase).
 *
 * DESIGN PROPERTIES
 * -----------------
 * • Zero external dependencies — node:crypto only (via Signer).
 * • Fail-closed: invalid input → throw BillingDisputeProofError; verify
 *   failure → returns false, never throws.
 * • The proof embeds the receipt's intentId + tenantId so the verifier can
 *   match it back to the original receipt without needing the receipt itself.
 * • A proof can only be produced for intentIds within the caller's tenantId
 *   (cross-tenant check is the caller's responsibility; tenantId is part of
 *   the signed payload so cross-tenant substitution breaks the signature).
 * • Supports three discrepancy types so the mediator knows what kind of
 *   dispute this is: OVERCHARGE | DENIED_BUT_BILLED | AMOUNT_MISMATCH.
 */

import { canonicalJson } from "../common/canonical-json";
import type { Signer } from "../orchestrator/types";

// ─── Schema ────────────────────────────────────────────────────────────────────

export const BILLING_DISPUTE_PROOF_VERSION = "tfa-billing-dispute-proof-v1" as const;

/**
 * The class of discrepancy being asserted.
 *
 *   OVERCHARGE        — billed > authorized (both are non-zero).
 *   DENIED_BUT_BILLED — TFA decision was "denied" but the vendor billed anyway.
 *   AMOUNT_MISMATCH   — billed != authorized, and billed < authorized (undercharge
 *                       or wrong amount); used when the caller cannot classify more
 *                       precisely.
 */
export type BillingDiscrepancyType =
  | "OVERCHARGE"
  | "DENIED_BUT_BILLED"
  | "AMOUNT_MISMATCH";

/** A portable, signed billing-dispute proof. */
export interface BillingDisputeProof {
  /** Schema version — fail-closed on unknown versions. */
  version: typeof BILLING_DISPUTE_PROOF_VERSION;
  tenantId: string;
  /**
   * The TFA intent nonce from the original ExecutionReceipt.
   * Links this proof back to the specific action that was disputed.
   */
  intentId: string;
  /**
   * The value TFA authorized for this intent, in BigInt micro-cents,
   * stored as a decimal string for JSON compatibility.
   * "0" when the action was denied.
   */
  authorizedMicrounits: string;
  /**
   * The amount the vendor actually billed for this intent, in BigInt
   * micro-cents, stored as a decimal string.
   * Must be > 0 (the vendor did charge something).
   */
  billedMicrounits: string;
  /**
   * The TFA decision recorded in the original receipt.
   * "denied" + billedMicrounits > 0  ⟹  DENIED_BUT_BILLED.
   */
  decision: string;
  /** The classification of the discrepancy (computed and signed by the issuer). */
  discrepancyType: BillingDiscrepancyType;
  /** ISO-8601 timestamp at which this proof was built. */
  issuedAt: string;
  /** Stable identifier for the signing key. */
  signerId: string;
  /** Algorithm label copied from the Signer. */
  algorithm: string;
  /** base64 signature over the canonical signing payload. */
  signature: string;
}

// ─── Canonical signing payload ─────────────────────────────────────────────────

export interface BillingDisputeProofPayloadFields {
  version: typeof BILLING_DISPUTE_PROOF_VERSION;
  tenantId: string;
  intentId: string;
  authorizedMicrounits: string;
  billedMicrounits: string;
  decision: string;
  discrepancyType: BillingDiscrepancyType;
  issuedAt: string;
  signerId: string;
}

/** Deterministic canonical payload for signing/verification (sorted keys). */
export function billingDisputeProofSigningPayload(
  fields: BillingDisputeProofPayloadFields,
): string {
  return canonicalJson({
    version: fields.version,
    tenantId: fields.tenantId,
    intentId: fields.intentId,
    authorizedMicrounits: fields.authorizedMicrounits,
    billedMicrounits: fields.billedMicrounits,
    decision: fields.decision,
    discrepancyType: fields.discrepancyType,
    issuedAt: fields.issuedAt,
    signerId: fields.signerId,
  });
}

// ─── Builder input ─────────────────────────────────────────────────────────────

export interface BuildBillingDisputeProofInput {
  tenantId: string;
  intentId: string;
  /**
   * The value TFA authorized, from ExecutionReceipt.valueMicrounits.
   * Pass as BigInt; stored as decimal string in the proof.
   * Pass 0n when the decision was "denied".
   */
  authorizedMicrounits: bigint;
  /**
   * The amount the vendor actually billed for this intent.
   * Must be > 0n (the vendor charged something, which is what creates the dispute).
   */
  billedMicrounits: bigint;
  /**
   * The TFA decision from ExecutionReceipt.decision (e.g. "allowed", "denied").
   * Used to auto-classify DENIED_BUT_BILLED.
   */
  decision: string;
  /** The signing key (same signer that issues track-record proofs). */
  signer: Signer;
  /** Stable identifier for the signing key. */
  signerId: string;
  /** Optional override for issuedAt (ISO-8601). Defaults to now. */
  issuedAt?: string;
}

// ─── Error ─────────────────────────────────────────────────────────────────────

export class BillingDisputeProofError extends Error {
  readonly code: "BAD_INPUT" | "UNKNOWN_VERSION" | "SIGNATURE_MISMATCH" | "NO_DISCREPANCY";
  constructor(
    code: "BAD_INPUT" | "UNKNOWN_VERSION" | "SIGNATURE_MISMATCH" | "NO_DISCREPANCY",
    message: string,
  ) {
    super(message);
    this.name = "BillingDisputeProofError";
    this.code = code;
  }
}

// ─── Discrepancy classifier ────────────────────────────────────────────────────

/**
 * Classify the discrepancy type from the authorized amount, billed amount,
 * and decision.  Exported so callers can show the classification before
 * building the full proof.
 *
 * Fail-closed: throws BillingDisputeProofError if there is no discrepancy
 * (billed === authorized and decision is not "denied").
 */
export function classifyDiscrepancy(
  authorizedMicrounits: bigint,
  billedMicrounits: bigint,
  decision: string,
): BillingDiscrepancyType {
  if (decision === "denied" && billedMicrounits > 0n) {
    return "DENIED_BUT_BILLED";
  }
  if (billedMicrounits === authorizedMicrounits && decision !== "denied") {
    throw new BillingDisputeProofError(
      "NO_DISCREPANCY",
      `classifyDiscrepancy: billed (${billedMicrounits} μ¢) equals authorized (${authorizedMicrounits} μ¢) and decision is "${decision}" — no dispute exists`,
    );
  }
  if (billedMicrounits > authorizedMicrounits) {
    return "OVERCHARGE";
  }
  return "AMOUNT_MISMATCH";
}

// ─── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a signed billing-dispute proof.
 *
 * Fail-closed: throws BillingDisputeProofError on any invalid input.
 * Does NOT require access to the original ExecutionReceipt at call time —
 * the caller extracts `intentId`, `authorizedMicrounits`, and `decision` from
 * the receipt and passes them in, keeping this module receipt-agnostic and
 * independently testable.
 */
export function buildBillingDisputeProof(
  input: BuildBillingDisputeProofInput,
): BillingDisputeProof {
  const {
    tenantId,
    intentId,
    authorizedMicrounits,
    billedMicrounits,
    decision,
    signer,
    signerId,
  } = input;

  if (!tenantId || typeof tenantId !== "string") {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: tenantId must be a non-empty string",
    );
  }
  if (!intentId || typeof intentId !== "string") {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: intentId must be a non-empty string",
    );
  }
  if (typeof authorizedMicrounits !== "bigint" || authorizedMicrounits < 0n) {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: authorizedMicrounits must be a non-negative BigInt",
    );
  }
  if (typeof billedMicrounits !== "bigint" || billedMicrounits <= 0n) {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: billedMicrounits must be a positive BigInt (vendor did charge something)",
    );
  }
  if (!decision || typeof decision !== "string") {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: decision must be a non-empty string",
    );
  }
  if (!signerId || typeof signerId !== "string") {
    throw new BillingDisputeProofError(
      "BAD_INPUT",
      "buildBillingDisputeProof: signerId must be a non-empty string",
    );
  }

  // classify — throws NO_DISCREPANCY if billed === authorized and not denied
  const discrepancyType = classifyDiscrepancy(authorizedMicrounits, billedMicrounits, decision);

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const authorizedStr = authorizedMicrounits.toString();
  const billedStr = billedMicrounits.toString();

  const payloadFields: BillingDisputeProofPayloadFields = {
    version: BILLING_DISPUTE_PROOF_VERSION,
    tenantId,
    intentId,
    authorizedMicrounits: authorizedStr,
    billedMicrounits: billedStr,
    decision,
    discrepancyType,
    issuedAt,
    signerId,
  };

  const payload = billingDisputeProofSigningPayload(payloadFields);
  const signature = signer.sign(payload);

  return {
    version: BILLING_DISPUTE_PROOF_VERSION,
    tenantId,
    intentId,
    authorizedMicrounits: authorizedStr,
    billedMicrounits: billedStr,
    decision,
    discrepancyType,
    issuedAt,
    signerId,
    algorithm: signer.algorithm,
    signature,
  };
}

// ─── Verifier ──────────────────────────────────────────────────────────────────

/**
 * Verify a BillingDisputeProof.
 *
 * Returns true iff:
 *   1. The version is recognised.
 *   2. The signature over the canonical payload is valid.
 *   3. The discrepancyType is consistent with the signed amounts and decision
 *      (prevents a tampered proof that re-labels the discrepancy type without
 *      changing the signed money amounts).
 *
 * Fail-closed: any malformed/missing field → false.  Never throws.
 */
export function verifyBillingDisputeProof(
  proof: unknown,
  signer: Signer,
): boolean {
  try {
    if (!proof || typeof proof !== "object") return false;
    const p = proof as Record<string, unknown>;

    if (p["version"] !== BILLING_DISPUTE_PROOF_VERSION) return false;

    const tenantId = p["tenantId"];
    const intentId = p["intentId"];
    const authorizedMicrounitsStr = p["authorizedMicrounits"];
    const billedMicrounitsStr = p["billedMicrounits"];
    const decision = p["decision"];
    const discrepancyType = p["discrepancyType"];
    const issuedAt = p["issuedAt"];
    const signerId = p["signerId"];
    const signature = p["signature"];

    if (
      typeof tenantId !== "string" || !tenantId ||
      typeof intentId !== "string" || !intentId ||
      typeof authorizedMicrounitsStr !== "string" ||
      typeof billedMicrounitsStr !== "string" ||
      typeof decision !== "string" || !decision ||
      typeof discrepancyType !== "string" ||
      typeof issuedAt !== "string" ||
      typeof signerId !== "string" || !signerId ||
      typeof signature !== "string"
    ) return false;

    // Re-parse money as BigInt — reject non-integer strings
    let authorizedMicrounits: bigint;
    let billedMicrounits: bigint;
    try {
      authorizedMicrounits = BigInt(authorizedMicrounitsStr);
      billedMicrounits = BigInt(billedMicrounitsStr);
    } catch {
      return false;
    }
    if (authorizedMicrounits < 0n || billedMicrounits <= 0n) return false;

    // Re-derive the expected discrepancy type and check it matches what's signed
    let expectedType: BillingDiscrepancyType;
    try {
      expectedType = classifyDiscrepancy(authorizedMicrounits, billedMicrounits, decision);
    } catch {
      // classifyDiscrepancy threw NO_DISCREPANCY — the proof is internally inconsistent
      return false;
    }
    if (discrepancyType !== expectedType) return false;

    // Verify signature
    const payloadFields: BillingDisputeProofPayloadFields = {
      version: BILLING_DISPUTE_PROOF_VERSION,
      tenantId,
      intentId,
      authorizedMicrounits: authorizedMicrounitsStr,
      billedMicrounits: billedMicrounitsStr,
      decision,
      discrepancyType: discrepancyType as BillingDiscrepancyType,
      issuedAt,
      signerId,
    };
    const payload = billingDisputeProofSigningPayload(payloadFields);
    return signer.verify(payload, signature);
  } catch {
    return false;
  }
}
