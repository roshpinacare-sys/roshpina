/**
 * lib/adapter/ap2-mandate-link.ts — bind a TFA ExecutionReceipt to an AP2 mandate chain.
 *
 * THE INTEROP BREAKTHROUGH
 * ------------------------
 * Google's Agent Payments Protocol (AP2) proves *authorization* with a chain of
 * W3C Verifiable Credentials called Mandates: an **Intent Mandate** (the user
 * authorized a kind of action), a **Cart Mandate** (the specific thing), and a
 * **Payment Mandate** (the payment authorization). AP2 — by its own admission —
 * proves intent/authorization, NOT that the downstream action actually executed
 * within policy. That second half is exactly what a TFA ExecutionReceipt proves.
 *
 * This module makes TFA the **execution proof that completes an AP2 chain**: it
 * produces a signed, tamper-evident `MandateLinkage` binding an existing receipt
 * (by its signature — the receipt's stable fingerprint) to the AP2 mandate IDs it
 * fulfilled. A verifier (the merchant, the card network, an auditor) can then prove
 * end-to-end: *user-authorized (AP2) → policy-gated-and-executed (TFA)* — across
 * vendors, offline.
 *
 * Design notes:
 *  • SIDECAR, not a core change. The receipt's own signing path is untouched; the
 *    linkage is an additive artifact that references the receipt by its signature.
 *  • The linkage carries its OWN signature over a canonical payload that includes
 *    the receipt's signature + the ordered mandate references, so neither the bound
 *    receipt nor the mandate set can be swapped without breaking the linkage.
 *  • fail-closed: malformed mandates / empty receipt signature throw; verification
 *    returns false on any mismatch or unknown key (never throws).
 *  • Ed25519-first and KeyRing-aware: verify resolves the key by `kid` through a
 *    KeyRing so a linkage stays verifiable across key rotation, like every other
 *    TFA proof.
 *
 * Zero external dependencies.
 */

import type { Signer } from "../orchestrator/signer.ts";
import type { ExecutionReceipt } from "./agent-adapter.ts";
import type { KeyRing } from "../passport/key-ring.ts";

export type Ap2MandateType = "intent" | "cart" | "payment";

export interface Ap2MandateRef {
  type: Ap2MandateType;
  /** The mandate's stable identifier (e.g. a VC `id` URI). */
  id: string;
  /** Optional content hash of the mandate VC, for stronger binding. */
  hash?: string;
}

export interface MandateLinkage {
  version: "tfa-ap2-link-v1";
  /** The bound receipt's intentId (human-traceable). */
  receiptIntentId: string;
  /** The bound receipt's signature — its stable fingerprint. */
  receiptSignature: string;
  /** The AP2 mandates this execution fulfilled, in canonical (intent→cart→payment) order. */
  mandates: Ap2MandateRef[];
  boundAt: string;
  /** Signature over the canonical linkage payload. */
  signature: string;
  /** Key id of the signing key (for rotation-safe verification via KeyRing). */
  kid?: string;
}

const MANDATE_ORDER: Record<Ap2MandateType, number> = { intent: 0, cart: 1, payment: 2 };

export class MandateLinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MandateLinkError";
  }
}

function assertMandates(mandates: Ap2MandateRef[]): Ap2MandateRef[] {
  if (!Array.isArray(mandates) || mandates.length === 0) {
    throw new MandateLinkError("invalid_mandates", "at least one AP2 mandate is required");
  }
  for (const m of mandates) {
    if (!m || typeof m !== "object") throw new MandateLinkError("invalid_mandates", "mandate must be an object");
    if (m.type !== "intent" && m.type !== "cart" && m.type !== "payment") {
      throw new MandateLinkError("invalid_mandate_type", `unknown mandate type: ${String(m.type)}`);
    }
    if (typeof m.id !== "string" || m.id.length === 0) {
      throw new MandateLinkError("invalid_mandate_id", "mandate id must be a non-empty string");
    }
  }
  // canonical order: intent → cart → payment, then by id (stable, deterministic).
  return [...mandates].sort((a, b) => MANDATE_ORDER[a.type] - MANDATE_ORDER[b.type] || a.id.localeCompare(b.id));
}

/**
 * Canonical payload the linkage signature covers. Binds the receipt (by signature)
 * to the ordered mandate set so neither can be substituted independently.
 */
export function canonicalLinkagePayload(
  receiptSignature: string,
  receiptIntentId: string,
  mandates: Ap2MandateRef[],
  boundAt: string,
): string {
  const mandatePart = mandates.map((m) => `${m.type}:${m.id}:${m.hash ?? ""}`).join(",");
  return ["tfa-ap2-link-v1", receiptIntentId, receiptSignature, mandatePart, boundAt].join("|");
}

/**
 * linkReceiptToMandates — bind an existing receipt to an AP2 mandate chain.
 * fail-closed: an unsigned receipt or malformed mandates throw.
 */
export function linkReceiptToMandates(
  receipt: ExecutionReceipt,
  mandates: Ap2MandateRef[],
  signer: Signer,
  now: string = new Date().toISOString(),
): MandateLinkage {
  if (!receipt || typeof receipt.signature !== "string" || receipt.signature.length === 0) {
    throw new MandateLinkError("unsigned_receipt", "receipt must carry a signature to be linked");
  }
  const ordered = assertMandates(mandates);
  const payload = canonicalLinkagePayload(receipt.signature, receipt.intentId, ordered, now);
  const signature = signer.sign(payload);
  const kid = (signer as { kid?: string }).kid;
  return {
    version: "tfa-ap2-link-v1",
    receiptIntentId: receipt.intentId,
    receiptSignature: receipt.signature,
    mandates: ordered,
    boundAt: now,
    signature,
    ...(kid ? { kid } : {}),
  };
}

export interface LinkageVerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * verifyMandateLinkage — verify a linkage's signature and (optionally) that it
 * binds the receipt you hold. fail-closed: any mismatch or error → { valid:false }.
 *
 * Pass a `KeyRing` to resolve the signing key by `kid` (rotation-safe). Passing a
 * `Signer` verifies against that single key.
 */
export function verifyMandateLinkage(
  linkage: MandateLinkage,
  verifier: Signer | KeyRing,
  opts: { receipt?: ExecutionReceipt } = {},
): LinkageVerifyResult {
  try {
    if (!linkage || linkage.version !== "tfa-ap2-link-v1") {
      return { valid: false, reason: "unknown linkage version" };
    }
    if (typeof linkage.signature !== "string" || linkage.signature.length === 0) {
      return { valid: false, reason: "missing signature" };
    }
    const ordered = assertMandates(linkage.mandates); // also re-validates structure
    // the linkage must already be in canonical order (no silent re-ordering on verify).
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].id !== linkage.mandates[i].id || ordered[i].type !== linkage.mandates[i].type) {
        return { valid: false, reason: "mandates not in canonical order" };
      }
    }
    const payload = canonicalLinkagePayload(
      linkage.receiptSignature,
      linkage.receiptIntentId,
      linkage.mandates,
      linkage.boundAt,
    );

    let ok: boolean;
    if (isKeyRing(verifier)) {
      if (!linkage.kid) return { valid: false, reason: "linkage has no kid for KeyRing resolution" };
      ok = verifier.verify(payload, linkage.signature, linkage.kid);
    } else {
      ok = verifier.verify(payload, linkage.signature);
    }
    if (!ok) return { valid: false, reason: "signature does not verify" };

    // optional: confirm the linkage binds the receipt the caller holds.
    if (opts.receipt) {
      if (opts.receipt.signature !== linkage.receiptSignature) {
        return { valid: false, reason: "linkage does not bind this receipt" };
      }
      if (opts.receipt.intentId !== linkage.receiptIntentId) {
        return { valid: false, reason: "receipt intentId mismatch" };
      }
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : "verification error" };
  }
}

function isKeyRing(v: Signer | KeyRing): v is KeyRing {
  return typeof (v as KeyRing).resolve === "function";
}
