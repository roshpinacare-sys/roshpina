/**
 * lib/risk/action-risk.ts — ActionRiskClass taxonomy (DATA) + classifier + guard.
 *
 * First sub-step of MANIFEST "החסר הבא" #1 (ActionRiskClass + ApprovalPolicy).
 * This file does NOT decide approvals yet — it only classifies. The approval
 * router (next sub-step) will map each class → ApprovalPolicy.
 *
 * DESIGN
 * ------
 * • The taxonomy lives in `ActionRiskClass` (lib/orchestrator/types.ts).
 * • `ACTION_RISK_MAP` is governance-as-DATA: every known action type → a class.
 *   A third party can ship a different map without touching kernel code.
 * • `classifyRisk` is FAIL-CLOSED: an unmapped (unknown) action type is treated
 *   as the most-restrictive class — never silently waved through as low-risk.
 * • `injectRiskClass()` is a GuardPolicy placed FIRST in the chain; it annotates
 *   `ctx.riskClass` so downstream policies and (later) the approval router can read
 *   it. It always allows — classification alone never denies.
 *
 * Zero external dependencies.
 */

import type { ActionContext, ActionRiskClass, GuardPolicy } from "../orchestrator/types";
import { LEDGER_ACTION_TYPES } from "../ledger-orchestrator/types";
import { POTENTIAL_ACTION_TYPES } from "../potential/types";
import { MARKETPLACE_ACTION_TYPES } from "../marketplace/types";

/** All risk classes, ordered least→most dangerous (for iteration / validation). */
export const RISK_CLASSES: readonly ActionRiskClass[] = [
  "read_only",
  "write_safe",
  "write_destructive",
  "value_moving",
  "irreversible",
  "privacy_sensitive",
  "regulated",
] as const;

/**
 * The most-restrictive class. An action that cannot be classified is assumed to
 * be the most dangerous thing it could be (fail-closed) — it will require the
 * strictest approval path once the router exists.
 */
export const MOST_RESTRICTIVE_RISK_CLASS: ActionRiskClass = "irreversible";

/**
 * ACTION_RISK_MAP — canonical mapping of every KNOWN action type → risk class.
 * Governance-as-data: replaceable without code changes. Must stay in sync with
 * the action-type enums; the coverage test asserts every enum value is present.
 */
export const ACTION_RISK_MAP: Readonly<Record<string, ActionRiskClass>> = {
  // ── Ledger (money) ──────────────────────────────────────────────────────
  [LEDGER_ACTION_TYPES.MINT]: "value_moving",
  [LEDGER_ACTION_TYPES.WITHDRAW]: "value_moving",
  [LEDGER_ACTION_TYPES.TRANSFER]: "value_moving",
  [LEDGER_ACTION_TYPES.SOLVENCY_CHECK]: "read_only",
  // ── Potential (intelligence) ────────────────────────────────────────────
  [POTENTIAL_ACTION_TYPES.ANALYZE]: "read_only",
  [POTENTIAL_ACTION_TYPES.ROUTE]: "read_only",
  [POTENTIAL_ACTION_TYPES.PERSONALITY]: "read_only",
  [POTENTIAL_ACTION_TYPES.COLLABORATION_ESCROW]: "value_moving",
  [POTENTIAL_ACTION_TYPES.COLLABORATION_COMPLETE]: "value_moving",
  // ── Marketplace ─────────────────────────────────────────────────────────
  [MARKETPLACE_ACTION_TYPES.CREATE]: "write_safe",
  [MARKETPLACE_ACTION_TYPES.LIST]: "read_only",
  [MARKETPLACE_ACTION_TYPES.DELETE]: "write_destructive",
  [MARKETPLACE_ACTION_TYPES.ROUTE]: "read_only",
  [MARKETPLACE_ACTION_TYPES.CLAIM]: "value_moving",
} as const;

/**
 * classifyRisk — map an action type to its risk class.
 * FAIL-CLOSED: an unknown / unmapped type returns the most-restrictive class.
 */
export function classifyRisk(actionType: string): ActionRiskClass {
  if (typeof actionType !== "string" || actionType.length === 0) {
    return MOST_RESTRICTIVE_RISK_CLASS;
  }
  return ACTION_RISK_MAP[actionType] ?? MOST_RESTRICTIVE_RISK_CLASS;
}

/**
 * Precomputed Set of all classified action types.
 * O(1) `.has()` on every call to `isClassified`, replacing the per-call
 * `hasOwnProperty` probe on the hot classification path.
 */
const CLASSIFIED_ACTION_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(ACTION_RISK_MAP));

/** True iff the action type has an explicit entry in the canonical map. */
export function isClassified(actionType: string): boolean {
  return CLASSIFIED_ACTION_TYPE_SET.has(actionType);
}

/**
 * injectRiskClass — a GuardPolicy that annotates `ctx.riskClass` and always allows.
 * Place it FIRST so every downstream policy (and the future approval router) sees it.
 * Classification never denies on its own; it only labels.
 */
export function injectRiskClass(name = "inject-risk-class"): GuardPolicy {
  return {
    name,
    evaluate: (ctx: ActionContext) => {
      ctx.riskClass = classifyRisk(ctx.action.type);
      return { allow: true };
    },
  };
}
