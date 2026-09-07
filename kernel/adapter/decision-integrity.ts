/**
 * lib/adapter/decision-integrity.ts — verify the DECISION was correct, not just signed.
 *
 * THE DEEPENING (verifiable decisions, not just verifiable signatures)
 * -------------------------------------------------------------------
 * `verifyExecutionReceipt` proves a receipt was signed by the expected key and not
 * tampered. But a *correctly signed* receipt can still carry a *wrong* decision: a
 * buggy or malicious gate could sign "allowed" for an action that policy says must
 * be denied. Signature-authenticity ≠ decision-correctness.
 *
 * `verifyDecisionIntegrity` closes that gap. Given only the receipt, it INDEPENDENTLY
 * RE-DERIVES what the decision should have been — from the server-side taxonomy and
 * the deterministic approval policy — and confirms the receipt's claimed
 * classification and decision match. A third party (auditor, counterparty, customer)
 * can now prove: "the gate classified this action correctly AND decided correctly,"
 * without trusting the gate.
 *
 * This is only sound because TFA's classification + approval routing are
 * DETERMINISTIC and server-side: same toolId → same riskClass → same approvalClass →
 * same decision, everywhere. (A kill-switch verdict is the one allowed override: it
 * may force `denied` regardless — so a denied-by-kill-switch receipt is accepted as
 * consistent.)
 *
 * fail-closed: any mismatch → { valid:false, reasons:[...] }. Pure, zero-dep.
 * Pairs with verifyExecutionReceipt (signature) for two independent guarantees.
 */

import { classifyActionServerSide } from "../risk/coding-actions.ts";
import { resolveApprovalClass } from "../risk/approval-policy.ts";
import { decisionForApprovalClass } from "./agent-adapter.ts";
import type { ExecutionReceipt } from "./agent-adapter.ts";

export interface DecisionIntegrityResult {
  valid: boolean;
  /** What the gate SHOULD have classified the action as (re-derived). */
  expectedRiskClass?: string;
  expectedApprovalClass?: string;
  expectedDecision?: string;
  reasons: string[];
}

/**
 * verifyDecisionIntegrity — re-derive and confirm the receipt's classification +
 * decision are exactly what TFA's deterministic policy mandates for this action.
 * Does NOT check the signature — pair with verifyExecutionReceipt for that.
 */
export function verifyDecisionIntegrity(receipt: ExecutionReceipt): DecisionIntegrityResult {
  const reasons: string[] = [];
  if (!receipt || typeof receipt !== "object") {
    return { valid: false, reasons: ["receipt must be an object"] };
  }
  if (typeof receipt.toolId !== "string" || receipt.toolId.length === 0) {
    return { valid: false, reasons: ["receipt.toolId missing — cannot re-derive classification"] };
  }

  // 1. Re-derive the server-side risk classification from the action type alone.
  const { riskClass: expectedRiskClass, source: expectedSource } = classifyActionServerSide(receipt.toolId);

  // 2. Re-derive the approval class and the agent-facing decision.
  const expectedApprovalClass = resolveApprovalClass(expectedRiskClass);
  const expectedDecision = decisionForApprovalClass(expectedApprovalClass);

  // 3. Confirm the receipt's CLAIMED server risk class matches the re-derived one.
  if (receipt.serverRiskClass !== expectedRiskClass) {
    reasons.push(
      `serverRiskClass mismatch: receipt says "${receipt.serverRiskClass}", policy re-derives "${expectedRiskClass}"`,
    );
  }

  // 4. Confirm the risk source is honestly reported.
  if (receipt.riskSource !== expectedSource) {
    reasons.push(`riskSource mismatch: receipt says "${receipt.riskSource}", re-derived "${expectedSource}"`);
  }

  // 5. Confirm the approval class matches what the (re-derived) risk class mandates.
  if (receipt.approvalClass !== expectedApprovalClass) {
    reasons.push(
      `approvalClass mismatch: receipt says "${receipt.approvalClass}", policy mandates "${expectedApprovalClass}"`,
    );
  }

  // 6. Confirm the decision is consistent — allowing the kill-switch override.
  const killSwitchForcedDeny = receipt.killSwitchVerdict?.tripped === true;
  if (killSwitchForcedDeny) {
    if (receipt.decision !== "denied") {
      reasons.push(`kill-switch was tripped but decision is "${receipt.decision}" (must be "denied")`);
    }
  } else if (receipt.decision !== expectedDecision) {
    reasons.push(`decision mismatch: receipt says "${receipt.decision}", policy mandates "${expectedDecision}"`);
  }

  return {
    valid: reasons.length === 0,
    expectedRiskClass,
    expectedApprovalClass,
    expectedDecision: killSwitchForcedDeny ? "denied" : expectedDecision,
    reasons,
  };
}
