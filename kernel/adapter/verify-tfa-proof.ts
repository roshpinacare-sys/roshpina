/**
 * lib/adapter/verify-tfa-proof.ts — the ONE authoritative proof verifier.
 *
 * WHY THIS IS THE CAPSTONE (no-fail-for-the-user)
 * -----------------------------------------------
 * TFA accumulated several independent, correct verification primitives:
 *   • verifyExecutionReceipt    — signature authenticity (Ed25519/HMAC, KeyRing-aware)
 *   • verifyDecisionIntegrity   — the decision/classification was actually CORRECT
 *   • verifyMandateLinkage      — the AP2 mandate chain is bound to this receipt
 * Each is sound in isolation. The danger is in COMPOSITION: a relying party that
 * calls only `verifyExecutionReceipt` gets a *signed* proof that may still carry a
 * *wrong* decision, and never knows. That is a silent footgun — exactly the class
 * of "the system failed the user" we must engineer out.
 *
 * `verifyTfaProof` is the single entry point a customer/auditor/counterparty calls.
 * It runs EVERY applicable check, fail-closed, and returns one consolidated verdict
 * plus a per-check breakdown. You cannot accidentally skip a check. If any REQUIRED
 * check fails (or errors), the whole proof is invalid.
 *
 * Pure, zero-dep. Composes existing primitives; adds no new trust assumptions.
 */

import { verifyExecutionReceipt } from "./agent-adapter.ts";
import type { ExecutionReceipt, ExecutionReceiptVerifyKeys } from "./agent-adapter.ts";
import { verifyDecisionIntegrity } from "./decision-integrity.ts";
import { verifyMandateLinkage } from "./ap2-mandate-link.ts";
import type { MandateLinkage } from "./ap2-mandate-link.ts";
import type { Signer } from "../orchestrator/signer.ts";
import type { KeyRing } from "../passport/key-ring.ts";

export interface VerifyTfaProofOptions {
  /** How to verify the signature: a Signer, or KeyRing-backed keys (preferred). */
  keys: Signer | ExecutionReceiptVerifyKeys;
  /** Optional AP2 mandate linkage to verify and bind to this receipt. */
  mandateLinkage?: MandateLinkage;
  /**
   * Require decision-integrity to pass (default true). Set false ONLY for receipts
   * issued by a custom policy engine whose decisions are not re-derivable here.
   */
  requireDecisionIntegrity?: boolean;
}

export interface TfaProofVerdict {
  /** True iff every REQUIRED check passed. */
  valid: boolean;
  checks: {
    authenticity: boolean;
    decisionIntegrity: boolean;
    /** undefined when no linkage was supplied. */
    mandateLinkage?: boolean;
  };
  reasons: string[];
}

/** Extract a Signer|KeyRing for the mandate-linkage verifier from the receipt keys. */
function linkageVerifier(keys: Signer | ExecutionReceiptVerifyKeys): Signer | KeyRing | undefined {
  if (!keys || typeof keys !== "object") return undefined;
  if (typeof (keys as Signer).verify === "function") return keys as Signer;
  const k = keys as ExecutionReceiptVerifyKeys;
  return k.keyRing ?? k.signer;
}

/**
 * verifyTfaProof — run all applicable checks on a TFA proof, fail-closed.
 * Never throws: any internal error becomes a failed check with a reason.
 */
export function verifyTfaProof(receipt: ExecutionReceipt, opts: VerifyTfaProofOptions): TfaProofVerdict {
  const reasons: string[] = [];
  const checks: TfaProofVerdict["checks"] = { authenticity: false, decisionIntegrity: false };

  if (!receipt || typeof receipt !== "object") {
    return { valid: false, checks, reasons: ["receipt must be an object"] };
  }
  if (!opts || !opts.keys) {
    return { valid: false, checks, reasons: ["verification keys are required"] };
  }
  const requireDecision = opts.requireDecisionIntegrity !== false;

  // 1. Authenticity — signature over the canonical payload.
  try {
    checks.authenticity = verifyExecutionReceipt(receipt, opts.keys);
    if (!checks.authenticity) reasons.push("signature does not verify (authenticity failed)");
  } catch (e) {
    reasons.push(`authenticity check errored: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 2. Decision integrity — the classification + decision were correct (re-derived).
  try {
    const di = verifyDecisionIntegrity(receipt);
    checks.decisionIntegrity = di.valid;
    if (!di.valid) reasons.push(...di.reasons.map((r) => `decisionIntegrity: ${r}`));
  } catch (e) {
    reasons.push(`decisionIntegrity check errored: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 3. AP2 mandate linkage — optional; when present it MUST bind this receipt.
  if (opts.mandateLinkage !== undefined) {
    try {
      const verifier = linkageVerifier(opts.keys);
      if (!verifier) {
        checks.mandateLinkage = false;
        reasons.push("mandateLinkage: no usable verifier (need a Signer or KeyRing)");
      } else {
        const v = verifyMandateLinkage(opts.mandateLinkage, verifier, { receipt });
        checks.mandateLinkage = v.valid;
        if (!v.valid) reasons.push(`mandateLinkage: ${v.reason ?? "invalid"}`);
      }
    } catch (e) {
      checks.mandateLinkage = false;
      reasons.push(`mandateLinkage check errored: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  // Consolidate: every REQUIRED check must pass.
  const required: boolean[] = [checks.authenticity];
  if (requireDecision) required.push(checks.decisionIntegrity);
  if (opts.mandateLinkage !== undefined) required.push(checks.mandateLinkage === true);

  return { valid: required.every(Boolean), checks, reasons };
}
