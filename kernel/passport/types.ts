/**
 * lib/passport/types.ts — Action Passport: self-contained proof of an action.
 *
 * An ActionPassport bundles everything an external verifier needs to confirm
 * that a given action ran through the TFA kernel under the documented rules:
 *
 *   • the audit record (with its hash-chain link + kernel signature)
 *   • the resolved delegation chain (human → agent → sub-agent), if any
 *   • the policy decision (allowed / denied / error + reason)
 *   • the ledger effect (optional, attached by the caller)
 *   • a passport-level hash + signature over the above
 *
 * The passport is fully self-contained JSON (BigInts serialised as strings)
 * and verifiable by a zero-dependency tool (scripts/verify-passport.mjs).
 *
 * Zero external dependencies — node:crypto only.
 */

import type { AuditOutcome, AuditRecord, AuditId } from "../orchestrator/types";
import type { AgentIdentity } from "../agent-identity/types";
import type { WorkerAttestation } from "../escrow/types";
import type { AgentProvenance } from "../adapter/agent-provenance";
export type { WorkerAttestation };

/** Schema version. Bump on breaking changes. */
export type PassportVersion = "1";

/**
 * LedgerEffect — money movement attached to the passport.
 *
 * Mirrors `LedgerTransaction` from lib/ledger/types.ts but with BigInt
 * amounts serialised as decimal strings, so the JSON is portable.
 */
export interface PassportLedgerEffect {
  transactionId: string;
  tenantId: string;
  kind: string;
  debitAccountId: string;
  creditAccountId: string;
  /** μ¢ as a decimal string (BigInt-safe). */
  amount: string;
  memo: string;
  initiatedBy: string;
  createdAt: string;
}

/**
 * Snapshot of the audit record carried inside the passport.
 *
 * Identical fields to AuditRecord — kept as a separate type so the passport
 * is decoupled from internal AuditStore evolution.
 */
export interface PassportAudit {
  id: AuditId;
  tenantId: string;
  actionId: string;
  actionType: string;
  source: string;
  outcome: AuditOutcome;
  reason?: string;
  occurredAt: string;
  prevHash: string;
  hash: string;
  signature?: string;
}

/** Policy decision summary derived from the audit record. */
export interface PassportPolicyDecision {
  outcome: AuditOutcome;
  reason?: string;
}

/**
 * RiskEvidence — transparent, structured risk-intelligence embedded in a passport
 * or claim so the client can see how the evaluation was derived (score + factors).
 * Extracted from the signed DecisionTrace carried in the audit record's reason field.
 */
export interface RiskEvidence {
  /** Fused risk score in [0,100]. */
  riskScore: number;
  /** Explainable contribution of every signal that shaped the score. */
  factors: { factor: string; contribution: number; detail: string }[];
}

/**
 * ActionPassport — the signed, self-contained proof.
 *
 * Verification:
 *   1. Recompute the audit record's `hash` from its canonical fields and
 *      check it matches `audit.hash`.
 *   2. If `audit.signature` is present, verify it with the kernel signer.
 *   3. Recompute the passport `hash` from the canonical body (everything
 *      except `hash` and `signature`) and check it matches.
 *   4. Verify `signature` over the recomputed passport hash with the
 *      issuing signer.
 */
export interface ActionPassport {
  version: PassportVersion;
  passportId: string;
  issuedAt: string;
  tenantId: string;
  audit: PassportAudit;
  delegationChain: AgentIdentity[] | null;
  policyDecision: PassportPolicyDecision;
  ledgerEffect: PassportLedgerEffect | null;
  /**
   * Optional worker attestation attached when the action is a completion release.
   * Included in the canonical body so any tampering breaks the passport hash.
   * null when no attestation was provided (explicitly present in body for determinism).
   */
  attestation: WorkerAttestation | null;
  /** Signer algorithm label, e.g. "hmac-sha256" or "ed25519". */
  algorithm: string;
  /**
   * Key identifier — stable reference to the signing key used for this passport.
   * Present when the signer exposes a `kid` (e.g. Ed25519Signer).
   * Absent for HMAC signers (symmetric key has no distributable identity).
   * Included in the canonical body so any tampering breaks the passport hash.
   */
  kid?: string;
  /**
   * Optional structured risk-intelligence evidence extracted from the audit trace.
   * When present it is included in the canonical body so tampering breaks the hash.
   * Absent when the trace does not contain riskIntelligence (legacy path) or
   * when extraction fails (fail-closed: no partial / malformed evidence).
   */
  riskEvidence?: RiskEvidence;
  /**
   * Optional vendor-neutral agent provenance (v315).
   * When present it is included in the canonical body so tampering breaks the hash.
   * Cross-vendor fingerprint enables one audit trail across xAI/OpenAI/Anthropic/Google.
   */
  provenance?: AgentProvenance;
  /** SHA-256 of the canonical body (everything except `hash` + `signature`). */
  hash: string;
  /** base64 signature over `hash`. */
  signature: string;
}

/** Error thrown by the passport subsystem. */
export class PassportError extends Error {
  readonly code: PassportErrorCode;
  constructor(message: string, code: PassportErrorCode) {
    super(message);
    this.name = "PassportError";
    this.code = code;
  }
}

export type PassportErrorCode =
  | "missing_audit_id"
  | "audit_not_found"
  | "missing_signer"
  | "missing_audit_store"
  | "tenant_mismatch";

/** Error thrown by the passport claim subsystem. */
export class ClaimError extends Error {
  readonly code: ClaimErrorCode;
  constructor(message: string, code: ClaimErrorCode) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
  }
}

export type ClaimErrorCode =
  | "missing_options"
  | "missing_issuer"
  | "missing_subject"
  | "missing_scope"
  | "missing_signer";
