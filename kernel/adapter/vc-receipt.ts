/**
 * lib/adapter/vc-receipt.ts — W3C Verifiable Credentials 2.0 adapter for ExecutionReceipt.
 *
 * PURPOSE
 * -------
 * `toVerifiableCredential(receipt)` converts a TFA `ExecutionReceipt` into a
 * W3C VC 2.0–conformant document so that any W3C VC 2.0–capable verifier (wallets,
 * supply-chain tools, audit relays) can consume TFA action-decisions without knowing
 * TFA's proprietary receipt format. This is the "interop moat" referenced in the
 * roadmap (Tier-1 #9): a receipt that speaks the same language as the rest of the
 * decentralised-trust ecosystem.
 *
 * DESIGN CHOICES
 * --------------
 * • **Zero external deps** — pure TypeScript, no JSON-LD processor, no DID library.
 *   Compliance is syntactic/structural (correct shape), not semantic (no DID resolution,
 *   no JSON-LD expansion). This is deliberate: the first sub-step is "schema", not
 *   "full cryptographic suite conformance" (that's the `proof` type upgrade to
 *   Data Integrity Ed25519Signature2020, tracked as #4 in "החסר הבא").
 * • **Additive/non-destructive** — nothing in the existing receipt is removed or
 *   reinterpreted. The VC wraps the receipt; calling `toVerifiableCredential` and
 *   back (via `verifiableCredentialToReceipt`) is lossless for all canonical fields.
 * • **Proof embedding** — the existing TFA HMAC/Ed25519 signature is preserved as
 *   a `DataIntegrityProof`-compatible object inside `proof`. The `proofValue` is the
 *   raw TFA signature (base64url if not already). The `verificationMethod` is the
 *   `kid` when present, else `urn:tfa:key:hmac` (HMAC — symmetric, not distributable).
 * • **`credentialSubject.id`** — `urn:tfa:actor:{tenantId}:{actorId}` (a stable,
 *   human-readable URN; not a DID — DID adoption is tracked separately).
 *
 * SCHEMA (W3C VC 2.0 Data Model, §4)
 * ------------------------------------
 *   @context: ["https://www.w3.org/ns/credentials/v2",
 *              "https://tfa.dev/ns/action-decision/v1"]
 *   id:       urn:tfa:receipt:{intentId}
 *   type:     ["VerifiableCredential", "TfaActionDecision"]
 *   issuer:   { id: urn:tfa:tenant:{tenantId} }
 *   validFrom: {issuedAt}
 *   credentialSubject: { id, decision, riskClass, approvalClass, toolId,
 *                        resourceRef, valueMicrounits, executionId?, approvalToken?,
 *                        decisionTrace, serverRiskClass, clientClaimedRiskClass,
 *                        riskSource, killSwitchVerdict? }
 *   proof:    { type, cryptosuite, created, proofPurpose, verificationMethod,
 *               proofValue, kid? }
 *   linkage?: MandateLinkage  — optional AP2 mandate-chain evidence (v251 sub-step 1).
 *
 * USAGE
 * -----
 *   import { toVerifiableCredential, verifiableCredentialToReceipt } from "./vc-receipt.ts";
 *   const vc  = toVerifiableCredential(receipt, linkage);   // linkage optional
 *   const r2  = verifiableCredentialToReceipt(vc);   // lossless round-trip
 *   assert(r2.signature === receipt.signature);
 */

import type { ExecutionReceipt } from "./agent-adapter.ts";
import type { MandateLinkage } from "./ap2-mandate-link.ts";

// ─── TFA VC namespace ────────────────────────────────────────────────────────

export const TFA_VC_CONTEXT = "https://tfa.dev/ns/action-decision/v1" as const;
export const VC_BASE_CONTEXT = "https://www.w3.org/ns/credentials/v2" as const;
export const TFA_CREDENTIAL_TYPE = "TfaActionDecision" as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The W3C VC 2.0 proof object embedding the TFA receipt signature. */
export interface TfaDataIntegrityProof {
  type: "DataIntegrityProof";
  /**
   * Cryptosuite identifier:
   *  - `"eddsa-rdfc-2022"` — for Ed25519 receipts (W3C Data Integrity Ed25519 cryptosuite 2022).
   *    `proofValue` is base64url-encoded (no padding, URL-safe). The `kid` field
   *    identifies the verification key in the issuer's KeyRing.
   *  - `"tfa-hmac-sha256"` — for HMAC-SHA256 receipts (TFA-internal; not a W3C standard
   *    suite because HMAC is symmetric and not distributable to third-party verifiers).
   *    `proofValue` is base64url-encoded for consistency.
   */
  cryptosuite: "eddsa-rdfc-2022" | "tfa-hmac-sha256";
  created: string;        // ISO-8601 (= receipt.issuedAt)
  proofPurpose: "assertionMethod";
  verificationMethod: string; // kid or "urn:tfa:key:hmac"
  /**
   * The TFA signature encoded as **base64url** (RFC 4648 §5, no padding).
   * W3C Data Integrity proofs require base64url for portability; use the
   * helpers `toBase64Url` / `fromBase64Url` to convert to/from the raw
   * base64 signature stored in `ExecutionReceipt.signature`.
   */
  proofValue: string;
  kid?: string;           // present when signer is Ed25519
}

/** W3C VC 2.0 credentialSubject carrying TFA action-decision claims. */
export interface TfaCredentialSubject {
  /** urn:tfa:actor:{tenantId}:{actorId} */
  id: string;
  decision: ExecutionReceipt["decision"];
  approvalClass: ExecutionReceipt["approvalClass"];
  riskClass: string;
  serverRiskClass: string;
  clientClaimedRiskClass: string;
  riskSource: ExecutionReceipt["riskSource"];
  toolId: string;
  resourceRef: string;
  /**
   * BigInt μ¢ as a decimal string (same as ExecutionReceipt.valueMicrounits —
   * already JSON-safe; propagated verbatim so consumers can parse as bigint).
   */
  valueMicrounits: string;
  decisionTrace: ExecutionReceipt["decisionTrace"];
  executionId?: string;
  approvalToken?: string;
  approvalCapabilityToken?: string;
  killSwitchVerdict?: ExecutionReceipt["killSwitchVerdict"];
}

/** A W3C VC 2.0 document wrapping a TFA ExecutionReceipt. */
export interface TfaActionDecisionVC {
  "@context": [typeof VC_BASE_CONTEXT, typeof TFA_VC_CONTEXT];
  /** urn:tfa:receipt:{intentId} */
  id: string;
  type: ["VerifiableCredential", typeof TFA_CREDENTIAL_TYPE];
  /** { id: urn:tfa:tenant:{tenantId} } */
  issuer: { id: string };
  /** ISO-8601 (= receipt.issuedAt, mapped from VC 2.0 `validFrom`). */
  validFrom: string;
  credentialSubject: TfaCredentialSubject;
  proof: TfaDataIntegrityProof;
  /**
   * The original receipt version string, preserved verbatim so downstream
   * tools can distinguish receipt generations.
   */
  tfaReceiptVersion: ExecutionReceipt["version"];
  /** The original intentId, redundantly surfaced at VC level for easy lookup. */
  tfaIntentId: string;
  /**
   * AP2 mandate-chain evidence (sub-step 1, v251): when this receipt has been
   * bound to a Google AP2 mandate chain (intent→cart→payment) via
   * `linkReceiptToMandates`, the resulting signed `MandateLinkage` is carried
   * here as W3C VC "evidence" — the credential now proves not just *that TFA
   * executed within policy* but *which AP2-authorized chain it fulfilled*.
   *
   * This is purely additive: the linkage carries its own signature (verified
   * via `verifyMandateLinkage`, independent of the VC's own `proof`), so its
   * presence or absence never affects `verifiableCredentialToReceipt` or
   * `verifyExecutionReceipt` round-tripping.
   */
  linkage?: MandateLinkage;
}

// ─── Base64url helpers (RFC 4648 §5, no padding) ──────────────────────────────
// W3C Data Integrity proofs require base64url-encoded proofValues.
// TFA's HmacSigner and Ed25519Signer produce standard base64 (with padding,
// using +/). These two helpers convert between the two formats.

/**
 * Convert a standard base64 string (with +, /, = padding) to base64url
 * (URL-safe: +→-, /→_, no padding). Safe to call on a string that is
 * already base64url — the replacements are idempotent for the char set.
 */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Convert a base64url string (URL-safe, no padding) back to standard base64
 * (with +, /, = padding) as required by `Buffer.from(s, "base64")`.
 */
export function fromBase64Url(base64url: string): string {
  const s = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (s.length % 4)) % 4;
  return s + "=".repeat(pad);
}

// ─── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert a TFA `ExecutionReceipt` to a W3C VC 2.0–conformant document.
 *
 * This is a **pure transformation** — it does not re-sign anything. The existing
 * `receipt.signature` is embedded in `proof.proofValue` verbatim. Verifying the
 * VC's proof still requires calling `verifyExecutionReceipt(receipt, signer)` or
 * the equivalent over the re-extracted receipt (use `verifiableCredentialToReceipt`
 * to losslessly recover the original receipt).
 *
 * @param linkage Optional AP2 `MandateLinkage` (see `ap2-mandate-link.ts`) to embed
 *   as VC evidence. Verify it independently via `verifyMandateLinkage` — it is not
 *   covered by the VC's own `proof` and carries its own signature.
 */
export function toVerifiableCredential(
  receipt: ExecutionReceipt,
  linkage?: MandateLinkage,
): TfaActionDecisionVC {
  const cryptosuite: TfaDataIntegrityProof["cryptosuite"] =
    receipt.kid ? "eddsa-rdfc-2022" : "tfa-hmac-sha256";

  const proof: TfaDataIntegrityProof = {
    type: "DataIntegrityProof",
    cryptosuite,
    created: receipt.issuedAt,
    proofPurpose: "assertionMethod",
    verificationMethod: receipt.kid ?? "urn:tfa:key:hmac",
    // W3C Data Integrity requires base64url (RFC 4648 §5, no padding).
    proofValue: toBase64Url(receipt.signature),
    ...(receipt.kid ? { kid: receipt.kid } : {}),
  };

  const subject: TfaCredentialSubject = {
    id: `urn:tfa:actor:${receipt.tenantId}:${receipt.actorId}`,
    decision: receipt.decision,
    approvalClass: receipt.approvalClass,
    riskClass: receipt.riskClass,
    serverRiskClass: receipt.serverRiskClass,
    clientClaimedRiskClass: receipt.clientClaimedRiskClass,
    riskSource: receipt.riskSource,
    toolId: receipt.toolId,
    resourceRef: receipt.resourceRef,
    valueMicrounits: receipt.valueMicrounits,
    decisionTrace: receipt.decisionTrace,
    ...(receipt.executionId !== undefined ? { executionId: receipt.executionId } : {}),
    ...(receipt.approvalToken !== undefined ? { approvalToken: receipt.approvalToken } : {}),
    ...(receipt.approvalCapabilityToken !== undefined ? { approvalCapabilityToken: receipt.approvalCapabilityToken } : {}),
    ...(receipt.killSwitchVerdict !== undefined ? { killSwitchVerdict: receipt.killSwitchVerdict } : {}),
  };

  return {
    "@context": [VC_BASE_CONTEXT, TFA_VC_CONTEXT],
    id: `urn:tfa:receipt:${receipt.intentId}`,
    type: ["VerifiableCredential", TFA_CREDENTIAL_TYPE],
    issuer: { id: `urn:tfa:tenant:${receipt.tenantId}` },
    validFrom: receipt.issuedAt,
    credentialSubject: subject,
    proof,
    tfaReceiptVersion: receipt.version,
    tfaIntentId: receipt.intentId,
    ...(linkage ? { linkage } : {}),
  };
}

/**
 * Reconstruct an `ExecutionReceipt` from a `TfaActionDecisionVC`, enabling
 * verification via the existing `verifyExecutionReceipt(receipt, signer)`.
 *
 * This is a **lossless round-trip** for all canonically-signed fields. If the VC
 * was produced by `toVerifiableCredential`, `verifyExecutionReceipt(result, signer)`
 * must return `true`.
 */
export function verifiableCredentialToReceipt(vc: TfaActionDecisionVC): ExecutionReceipt {
  const s = vc.credentialSubject;
  return {
    version: vc.tfaReceiptVersion,
    intentId: vc.tfaIntentId,
    tenantId: vc.issuer.id.replace(/^urn:tfa:tenant:/, ""),
    actorId: s.id.replace(/^urn:tfa:actor:[^:]+:/, ""),
    toolId: s.toolId,
    resourceRef: s.resourceRef,
    riskClass: s.riskClass,
    approvalClass: s.approvalClass,
    decision: s.decision,
    valueMicrounits: s.valueMicrounits,
    decisionTrace: s.decisionTrace,
    issuedAt: vc.validFrom,
    serverRiskClass: s.serverRiskClass,
    clientClaimedRiskClass: s.clientClaimedRiskClass,
    riskSource: s.riskSource,
    signature: fromBase64Url(vc.proof.proofValue),
    ...(vc.proof.kid ? { kid: vc.proof.kid } : {}),
    ...(s.executionId !== undefined ? { executionId: s.executionId } : {}),
    ...(s.approvalToken !== undefined ? { approvalToken: s.approvalToken } : {}),
    ...(s.approvalCapabilityToken !== undefined ? { approvalCapabilityToken: s.approvalCapabilityToken } : {}),
    ...(s.killSwitchVerdict !== undefined ? { killSwitchVerdict: s.killSwitchVerdict } : {}),
  };
}

// ─── Schema validation (no external deps) ────────────────────────────────────

export interface VCSchemaValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the structure of a `TfaActionDecisionVC` against the W3C VC 2.0
 * required fields and TFA-specific constraints.
 *
 * This is a **syntactic/structural** check only (no JSON-LD expansion, no DID
 * resolution, no signature verification). Signature validity is out of scope:
 * call `verifyExecutionReceipt(verifiableCredentialToReceipt(vc), signer)`.
 *
 * Checks:
 *   - `@context` first element is VC 2.0 base URL.
 *   - `@context` second element is TFA extension URL.
 *   - `type` includes "VerifiableCredential" and "TfaActionDecision".
 *   - `id` starts with "urn:tfa:receipt:".
 *   - `issuer.id` starts with "urn:tfa:tenant:".
 *   - `validFrom` is an ISO-8601 string.
 *   - `credentialSubject.id` starts with "urn:tfa:actor:".
 *   - `credentialSubject.decision` is one of "allowed"|"approval_required"|"denied".
 *   - `credentialSubject.valueMicrounits` is a non-negative decimal integer string.
 *   - `proof.type` === "DataIntegrityProof".
 *   - `proof.proofPurpose` === "assertionMethod".
 *   - `proof.proofValue` is a non-empty string.
 *   - `tfaReceiptVersion` === "tfa-receipt-v1".
 *   - `tfaIntentId` is a non-empty string.
 */
export function validateVCSchema(vc: unknown): VCSchemaValidation {
  const errors: string[] = [];

  if (typeof vc !== "object" || vc === null) {
    return { ok: false, errors: ["not an object"] };
  }
  const v = vc as Record<string, unknown>;

  // @context
  const ctx = v["@context"];
  if (!Array.isArray(ctx) || ctx.length < 2) {
    errors.push("@context must be an array with at least 2 elements");
  } else {
    if (ctx[0] !== VC_BASE_CONTEXT) errors.push(`@context[0] must be "${VC_BASE_CONTEXT}"`);
    if (ctx[1] !== TFA_VC_CONTEXT) errors.push(`@context[1] must be "${TFA_VC_CONTEXT}"`);
  }

  // id
  if (typeof v.id !== "string" || !v.id.startsWith("urn:tfa:receipt:")) {
    errors.push('id must start with "urn:tfa:receipt:"');
  }

  // type
  const type = v.type;
  if (!Array.isArray(type)) {
    errors.push("type must be an array");
  } else {
    if (!type.includes("VerifiableCredential")) errors.push('type must include "VerifiableCredential"');
    if (!type.includes(TFA_CREDENTIAL_TYPE)) errors.push(`type must include "${TFA_CREDENTIAL_TYPE}"`);
  }

  // issuer
  const issuer = v.issuer;
  if (typeof issuer !== "object" || issuer === null) {
    errors.push("issuer must be an object");
  } else {
    const iss = issuer as Record<string, unknown>;
    if (typeof iss.id !== "string" || !iss.id.startsWith("urn:tfa:tenant:")) {
      errors.push('issuer.id must start with "urn:tfa:tenant:"');
    }
  }

  // validFrom
  if (typeof v.validFrom !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v.validFrom)) {
    errors.push("validFrom must be an ISO-8601 datetime string");
  }

  // credentialSubject
  const cs = v.credentialSubject;
  if (typeof cs !== "object" || cs === null) {
    errors.push("credentialSubject must be an object");
  } else {
    const s = cs as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id.startsWith("urn:tfa:actor:")) {
      errors.push('credentialSubject.id must start with "urn:tfa:actor:"');
    }
    if (!["allowed", "approval_required", "denied"].includes(s.decision as string)) {
      errors.push('credentialSubject.decision must be "allowed", "approval_required", or "denied"');
    }
    if (typeof s.valueMicrounits !== "string" || !/^\d+$/.test(s.valueMicrounits)) {
      errors.push("credentialSubject.valueMicrounits must be a non-negative decimal integer string");
    }
    if (typeof s.decisionTrace !== "object" || s.decisionTrace === null) {
      errors.push("credentialSubject.decisionTrace must be an object");
    }
  }

  // proof
  const proof = v.proof;
  if (typeof proof !== "object" || proof === null) {
    errors.push("proof must be an object");
  } else {
    const p = proof as Record<string, unknown>;
    if (p.type !== "DataIntegrityProof") errors.push('proof.type must be "DataIntegrityProof"');
    if (p.proofPurpose !== "assertionMethod") errors.push('proof.proofPurpose must be "assertionMethod"');
    if (typeof p.proofValue !== "string" || p.proofValue.length === 0) errors.push("proof.proofValue must be a non-empty string");
  }

  // TFA extension fields
  if (v.tfaReceiptVersion !== "tfa-receipt-v1") {
    errors.push('tfaReceiptVersion must be "tfa-receipt-v1"');
  }
  if (typeof v.tfaIntentId !== "string" || v.tfaIntentId.length === 0) {
    errors.push("tfaIntentId must be a non-empty string");
  }

  // linkage (optional AP2 evidence, sub-step 1, v251) — structural check only;
  // signature validity is verified separately via verifyMandateLinkage.
  if (v.linkage !== undefined) {
    const l = v.linkage as Record<string, unknown>;
    if (typeof l !== "object" || l === null) {
      errors.push("linkage must be an object when present");
    } else {
      if (l.version !== "tfa-ap2-link-v1") errors.push('linkage.version must be "tfa-ap2-link-v1"');
      if (typeof l.receiptSignature !== "string" || l.receiptSignature.length === 0) {
        errors.push("linkage.receiptSignature must be a non-empty string");
      }
      if (!Array.isArray(l.mandates) || l.mandates.length === 0) {
        errors.push("linkage.mandates must be a non-empty array");
      }
      if (typeof l.signature !== "string" || l.signature.length === 0) {
        errors.push("linkage.signature must be a non-empty string");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
