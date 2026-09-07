/**
 * lib/risk/action-simulator.ts — pre-action simulation / dry-run.
 *
 * THE MOVE (Tier-1 advantage, MetaMask-parity generalized)
 * --------------------------------------------------------
 * MetaMask Agent Wallet runs a mandatory transaction *simulation* before every
 * on-chain action so a human (or policy) sees the predicted effect before it
 * happens. That only works for EVM transactions. TFA generalizes it: given any
 * ActionIntent, `simulateAction` produces a DETERMINISTIC predicted-effect preview
 * — reversibility, blast radius, value at risk, and warnings — WITHOUT executing
 * anything. The preview attaches to the decision trace / receipt so an approver
 * sees "this will irreversibly drop a database table" before clicking approve, and
 * the prediction itself becomes part of the portable, signed proof.
 *
 * This is pure and side-effect-free: it reasons from the server-side action
 * taxonomy (classifyActionServerSide), never touching a real resource.
 *
 * fail-closed:
 *   • an unknown action type yields the WORST-CASE preview (irreversible, unknown
 *     blast radius, explicit warning) — never an optimistic "safe" default;
 *   • malformed input throws.
 *
 * Zero external dependencies.
 */

import { classifyActionServerSide } from "./coding-actions";
import type { ActionRiskClass } from "../orchestrator/types";

export type BlastRadius =
  | "none"
  | "single_resource"
  | "datastore"
  | "infrastructure"
  | "funds"
  | "unbounded"
  | "unknown";

export interface SimulationInput {
  /** The action type / tool id, e.g. "file.delete", "db.migration", "token.swap". */
  actionType: string;
  /** Value at stake in μ¢ (BigInt) — used for value-moving actions. Optional. */
  valueMicrounits?: bigint;
  /** Opaque resource reference for a human-readable predicted effect. Optional. */
  resourceRef?: string;
}

export interface SimulationResult {
  actionType: string;
  riskClass: ActionRiskClass;
  riskSource: "coding_taxonomy" | "general_taxonomy" | "fail_closed_default";
  /** Can the effect be undone without external recovery? */
  reversible: boolean;
  blastRadius: BlastRadius;
  /** Human-readable description of what WOULD happen (no execution). */
  predictedEffect: string;
  /** Value at risk in μ¢ (only for value-moving / funds actions). */
  valueAtRiskMicrounits?: bigint;
  /** Does safe execution require a backup/snapshot first? */
  requiresBackup: boolean;
  warnings: string[];
  simulatedAt: string;
}

/** Risk classes whose effects are NOT cleanly reversible. */
const IRREVERSIBLE_CLASSES = new Set<ActionRiskClass>([
  "write_destructive",
  "value_moving",
  "irreversible",
  "regulated",
]);

/** Map an action-type prefix to a blast radius. Order matters (most specific first). */
function blastRadiusFor(actionType: string, riskClass: ActionRiskClass): BlastRadius {
  if (actionType === "shell.exec") return "unbounded"; // can do literally anything
  if (actionType.startsWith("db.")) return "datastore";
  if (actionType.startsWith("infra.")) return "infrastructure";
  if (
    actionType.startsWith("token.") ||
    actionType.startsWith("liquidity.") ||
    actionType.startsWith("bridge.") ||
    riskClass === "value_moving"
  ) {
    return "funds";
  }
  if (actionType.startsWith("file.") || actionType.startsWith("git.") || actionType.startsWith("package.")) {
    return riskClass === "read_only" ? "none" : "single_resource";
  }
  if (riskClass === "read_only") return "none";
  return "single_resource";
}

/**
 * simulateAction — produce a deterministic predicted-effect preview without
 * executing. fail-closed on unknown actions (worst case) and invalid input.
 */
export function simulateAction(input: SimulationInput, now: string = new Date().toISOString()): SimulationResult {
  if (!input || typeof input !== "object") {
    throw new Error("simulateAction: input must be an object");
  }
  const { actionType } = input;
  if (typeof actionType !== "string" || actionType.length === 0) {
    throw new Error("simulateAction: actionType must be a non-empty string");
  }
  if (input.valueMicrounits !== undefined && typeof input.valueMicrounits !== "bigint") {
    throw new Error("simulateAction: valueMicrounits must be a BigInt (μ¢)");
  }

  const { riskClass, source } = classifyActionServerSide(actionType);
  const reversible = !IRREVERSIBLE_CLASSES.has(riskClass);
  const blastRadius = source === "fail_closed_default" ? "unknown" : blastRadiusFor(actionType, riskClass);

  const warnings: string[] = [];
  if (source === "fail_closed_default") {
    warnings.push(`unknown action type "${actionType}" — treated as worst-case (irreversible, unknown blast radius)`);
  }
  if (!reversible) warnings.push("irreversible: this effect cannot be automatically undone");
  if (actionType === "shell.exec") warnings.push("arbitrary shell command — blast radius is unbounded");
  if (blastRadius === "datastore") warnings.push("touches a datastore — take a backup/snapshot before proceeding");
  if (blastRadius === "infrastructure") warnings.push("mutates infrastructure — verify a recovery path exists");

  const isFunds = blastRadius === "funds";
  let valueAtRiskMicrounits: bigint | undefined;
  if (isFunds) {
    valueAtRiskMicrounits = input.valueMicrounits ?? 0n;
    warnings.push(`moves value: ${valueAtRiskMicrounits.toString()} μ¢ at risk`);
  }

  const target = input.resourceRef ? ` on ${input.resourceRef}` : "";
  const predictedEffect = source === "fail_closed_default"
    ? `Unknown action "${actionType}"${target}: effect cannot be predicted — assume irreversible.`
    : `${actionType}${target}: ${reversible ? "reversible" : "IRREVERSIBLE"} change with ${blastRadius} blast radius (${riskClass}).`;

  const requiresBackup = blastRadius === "datastore" || blastRadius === "infrastructure" || riskClass === "irreversible";

  return {
    actionType,
    riskClass,
    riskSource: source,
    reversible,
    blastRadius,
    predictedEffect,
    ...(valueAtRiskMicrounits !== undefined ? { valueAtRiskMicrounits } : {}),
    requiresBackup,
    warnings,
    simulatedAt: now,
  };
}
