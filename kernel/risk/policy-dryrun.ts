/**
 * lib/risk/policy-dryrun.ts — Historical Policy Dry-Run.
 *
 * Answers the compliance question the blueprint calls out (item 8):
 *   "If THIS candidate policy had been live last week, how many actions would
 *    have changed outcome — escalated to human review, or been denied?"
 *
 * It replays a batch of HISTORICAL action records through the existing
 * policy simulator with a CANDIDATE policy set, then compares each replayed
 * outcome against the decision the live system actually recorded at the time,
 * and aggregates the delta.
 *
 * DESIGN
 * ------
 * • PURE / read-only: composes runPolicySimulation (no audit writes, no state
 *   mutation). The simulator already guarantees zero side-effects.
 * • TENANT-ISOLATED (fail-closed): every record is checked against the caller's
 *   tenantId. A record whose intent.tenantId differs is REJECTED, never silently
 *   replayed under the wrong tenant. A cross-tenant batch throws.
 * • DELTA-CLASSIFIED: each record is labelled unchanged | escalated | relaxed |
 *   newly_denied | newly_allowed by comparing recorded vs replayed adapter
 *   decision on an ordered severity scale (allowed < approval_required < denied).
 * • DETERMINISTIC: same inputs → same report. Counts derived in a single pass.
 *
 * Zero external dependencies.
 */

import type { ActionIntent, GuardPolicy, Signer } from "../orchestrator/types";
import { runPolicySimulation } from "./policy-simulator";
import type { RiskContext } from "../risk/contextual-risk";

/** The three adapter-facing outcomes, lowest to highest severity. */
export type AdapterDecision = "allowed" | "approval_required" | "denied";

/** Ordered severity scale: a higher index is a stricter outcome. */
const SEVERITY: Record<AdapterDecision, number> = {
  allowed: 0,
  approval_required: 1,
  denied: 2,
};

/** How a record's outcome changed under the candidate policy. */
export type DeltaKind =
  | "unchanged"
  | "escalated" // stricter, but not all the way to denied (e.g. allowed → approval_required)
  | "relaxed" // less strict (e.g. denied → approval_required, or → allowed)
  | "newly_denied" // any → denied (was not denied before)
  | "newly_allowed"; // approval_required/denied → allowed

/** One historical action to replay. */
export interface HistoricalActionRecord {
  /** The intent the agent submitted at the time. */
  intent: ActionIntent;
  /** The adapter decision the LIVE system recorded for this action. */
  recordedDecision: AdapterDecision;
  /** Optional reputation score that applied at the time (0–100). */
  reputationScore?: number;
  /** Optional behavioural context that applied at the time. */
  riskContext?: RiskContext;
  /** Optional opaque id for traceability in the per-record diff. */
  recordId?: string;
}

/** Input to a historical dry-run. */
export interface PolicyDryRunInput {
  /** Tenant whose history is being replayed. Required for isolation. */
  tenantId: string;
  /** Candidate policy set to evaluate (AND semantics — same as live guard). */
  candidatePolicies: GuardPolicy[];
  /** Historical records to replay. */
  history: HistoricalActionRecord[];
  /** Optional signer (forwarded to the simulator for trace previews). */
  signer?: Signer;
  /** Optional value-escalation threshold (μ¢ BigInt) forwarded to the simulator. */
  valueEscalationThreshold?: bigint;
}

/** Per-record replay outcome. */
export interface DryRunRecordResult {
  recordId?: string;
  recordedDecision: AdapterDecision;
  replayedDecision: AdapterDecision;
  delta: DeltaKind;
  /** Human-readable one-liner. */
  summary: string;
}

/** Aggregate report over the whole batch. */
export interface PolicyDryRunReport {
  tenantId: string;
  /** Number of records replayed. */
  total: number;
  /** Counts keyed by delta kind. */
  counts: Record<DeltaKind, number>;
  /** Records whose outcome changed (delta !== "unchanged"), in input order. */
  changed: DryRunRecordResult[];
  /** All per-record results, in input order. */
  records: DryRunRecordResult[];
  /** Compliance-ready headline, e.g. "3 of 40 actions would have escalated; 1 newly denied." */
  headline: string;
}

/** Classify the change from a recorded decision to a replayed decision. */
export function classifyDelta(
  recorded: AdapterDecision,
  replayed: AdapterDecision
): DeltaKind {
  if (recorded === replayed) return "unchanged";
  if (replayed === "denied") return "newly_denied";
  if (replayed === "allowed") return "newly_allowed";
  // replayed is approval_required and differs from recorded.
  return SEVERITY[replayed] > SEVERITY[recorded] ? "escalated" : "relaxed";
}

function isValidDecision(d: unknown): d is AdapterDecision {
  return d === "allowed" || d === "approval_required" || d === "denied";
}

/**
 * runPolicyDryRun — replay history under a candidate policy and aggregate the delta.
 *
 * Fail-closed: invalid input throws; a cross-tenant record throws; an invalid
 * recordedDecision throws. The simulator itself fail-closes on invalid intents.
 */
export async function runPolicyDryRun(
  input: PolicyDryRunInput
): Promise<PolicyDryRunReport> {
  if (!input || typeof input !== "object") {
    throw new Error("runPolicyDryRun: input must be an object");
  }
  if (typeof input.tenantId !== "string" || input.tenantId.length === 0) {
    throw new Error("runPolicyDryRun: tenantId is required");
  }
  if (!Array.isArray(input.candidatePolicies)) {
    throw new Error("runPolicyDryRun: candidatePolicies must be an array");
  }
  if (!Array.isArray(input.history)) {
    throw new Error("runPolicyDryRun: history must be an array");
  }

  const counts: Record<DeltaKind, number> = {
    unchanged: 0,
    escalated: 0,
    relaxed: 0,
    newly_denied: 0,
    newly_allowed: 0,
  };
  const records: DryRunRecordResult[] = [];
  const changed: DryRunRecordResult[] = [];

  for (const rec of input.history) {
    if (!rec || typeof rec !== "object") {
      throw new Error("runPolicyDryRun: each history record must be an object");
    }
    if (!isValidDecision(rec.recordedDecision)) {
      throw new Error(
        `runPolicyDryRun: invalid recordedDecision "${String(rec.recordedDecision)}"`
      );
    }
    // Tenant isolation (fail-closed): never replay another tenant's action.
    if (!rec.intent || rec.intent.tenantId !== input.tenantId) {
      throw new Error(
        "runPolicyDryRun: cross-tenant record rejected (intent.tenantId must equal input.tenantId)"
      );
    }

    const sim = await runPolicySimulation({
      intent: rec.intent,
      policies: input.candidatePolicies,
      reputationScore: rec.reputationScore,
      riskContext: rec.riskContext,
      signer: input.signer,
      valueEscalationThreshold: input.valueEscalationThreshold,
    });

    const replayed = sim.adapterDecision;
    const delta = classifyDelta(rec.recordedDecision, replayed);
    counts[delta]++;

    const result: DryRunRecordResult = {
      recordId: rec.recordId,
      recordedDecision: rec.recordedDecision,
      replayedDecision: replayed,
      delta,
      summary:
        delta === "unchanged"
          ? `unchanged (${replayed})`
          : `${rec.recordedDecision} → ${replayed} (${delta})`,
    };
    records.push(result);
    if (delta !== "unchanged") changed.push(result);
  }

  const escalatedTotal = counts.escalated + counts.newly_denied;
  const headline =
    records.length === 0
      ? "no history to replay"
      : `${escalatedTotal} of ${records.length} actions would have escalated` +
        (counts.newly_denied ? ` (${counts.newly_denied} newly denied)` : "") +
        (counts.relaxed + counts.newly_allowed
          ? `; ${counts.relaxed + counts.newly_allowed} would have relaxed`
          : "") +
        ".";

  return {
    tenantId: input.tenantId,
    total: records.length,
    counts,
    changed,
    records,
    headline,
  };
}
