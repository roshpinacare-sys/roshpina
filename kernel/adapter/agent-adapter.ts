/**
 * lib/adapter/agent-adapter.ts — TFA Agent Adapter (minimal, first sub-step).
 *
 * This is the seam that turns TFA from an internal kernel into a layer you can
 * wrap around an existing agent (Claude Code / Cursor / OpenHands / n8n): give it
 * an ActionIntent, it reads risk + approval policy through the SAME canonical
 * functions the orchestrator uses, and returns a decision plus a signed,
 * self-verifying ExecutionReceipt.
 *
 *   ActionIntent → resolveApprovalClass(riskClass) → decision + signed DecisionTrace
 *                → signed ExecutionReceipt
 *
 * This first sub-step is PURE (no store writes, no workflow opened yet): it
 * answers "allowed | approval_required | denied" and emits a portable receipt.
 * Opening an ExecutionWorkflow + collecting evidence is the next sub-step.
 *
 * INVARIANTS
 *   • fail-closed: an invalid intent throws (validateActionIntent); an undefined /
 *     unmapped risk class resolves to "deny" → decision "denied".
 *   • money is BigInt μ¢, serialized as a decimal string in the receipt.
 *   • the receipt signature is deterministic and self-verifying via signer.verify.
 *
 * Zero external dependencies.
 */

import type { ActionIntent, Signer, ActionContext, ExecutionStore, ExecutionWorkflow } from "../orchestrator/types.ts";
import { validateActionIntent } from "../orchestrator/action-intent.ts";
import { resolveApprovalClass, createDecisionTrace, canonicalTracePayload } from "../risk/approval-policy.ts";
import type { ApprovalClass, DecisionTrace } from "../risk/approval-policy.ts";
import { classifyActionServerSide } from "../risk/coding-actions.ts";
import { simulateAction } from "../risk/action-simulator.ts";
import type { SimulationResult } from "../risk/action-simulator.ts";
import { issueCapabilityToken, encodeCapabilityToken, CAPABILITY_TOKEN_DEFAULT_TTL_MS } from "../mcp-server/capability-token.ts";
import { InMemoryExecutionStore } from "../orchestrator/execution-workflow.ts";
import type { KillSwitch, KillSwitchVerdict } from "../policy/kill-switch.ts";
import { applyKillSwitch } from "../policy/kill-switch.ts";
import type { AgentProvenance, AgentProvenanceInput } from "./agent-provenance.ts";
import { normalizeAgentProvenance } from "./agent-provenance.ts";

/** What the adapter tells the calling agent to do. */
export type AdapterDecision = "allowed" | "approval_required" | "denied";

/** Map a resolved ApprovalClass to the agent-facing decision. fail-closed: deny → denied. */
export function decisionForApprovalClass(approvalClass: ApprovalClass): AdapterDecision {
  if (approvalClass === "auto") return "allowed";
  if (approvalClass === "deny") return "denied";
  // human | threshold_escrow | opa_check all require an out-of-band approval step.
  return "approval_required";
}

/**
 * ExecutionReceipt — a portable, signed record that an intent was evaluated by TFA.
 * Self-verifying: a third party with the signer's verify capability can confirm it
 * without re-running policy. Money is a decimal string (μ¢).
 */
export interface ExecutionReceipt {
  version: "tfa-receipt-v1";
  intentId: string;            // the intent nonce (unique, replay-protected)
  tenantId: string;
  actorId: string;
  toolId: string;
  resourceRef: string;
  /** The authoritative risk class determined by the server (never client-supplied). */
  riskClass: string;
  approvalClass: ApprovalClass;
  decision: AdapterDecision;
  valueMicrounits: string;     // BigInt μ¢ as a decimal string
  decisionTrace: DecisionTrace; // signed approval trace (kernel-canonical)
  issuedAt: string;            // ISO-8601
  /** Server-derived risk class (same as riskClass, explicit for audit clarity). */
  serverRiskClass: string;
  /** The client's original riskClass claim (for override detection / audit). */
  clientClaimedRiskClass: string;
  /** Where the risk classification came from: coding_taxonomy, general_taxonomy, or fail_closed_default. */
  riskSource: "coding_taxonomy" | "general_taxonomy" | "fail_closed_default";
  /**
   * Present when decision==="allowed" AND an executionStore was provided.
   * The opened ExecutionWorkflow has been advanced to "running" (planned→approved→running).
   * The caller can use this id to query status, collect evidence, and advance to settled/proved.
   */
  executionId?: string;
  /**
   * Present when decision==="approval_required" AND an executionStore was provided.
   * A workflow in "planned" state has been opened. The workflow must be transitioned
   * to "approved" (by a human or OPA or threshold-escrow mechanism) before it can run.
   * This id serves as the approval token: POST /api/workflows/:executionId/approve.
   */
  approvalToken?: string;
  /**
   * Signed, encoded ApprovalCapabilityToken (base64url) issued on "approval_required".
   * Unlike approvalToken (raw workflow id), this is a tamper-evident capability bound
   * to executionId+tenantId with TTL+nonce — the migration target for approval auth.
   */
  approvalCapabilityToken?: string;
  signature: string;           // signature over the canonical payload below
  /**
   * Key identifier — stable reference to the signing key used for this receipt.
   * Present when the signer exposes a `kid` (e.g. Ed25519Signer).
   * Absent for HMAC signers (symmetric key has no distributable identity).
   * Included in the canonical payload so tampering with the kid breaks the signature.
   */
  kid?: string;
  /**
   * Present when a KillSwitch was consulted and tripped.
   * Contains the scope, reason, and tripped status for audit / decision trace.
   */
  killSwitchVerdict?: KillSwitchVerdict;
  /**
   * Vendor-neutral agent provenance (v313). Normalized cross-vendor identity
   * of the agent that performed this action, with a deterministic fingerprint.
   * Included in the canonical payload so tampering with provenance breaks the signature.
   */
  provenance?: AgentProvenance;
}

export interface RunActionResult {
  decision: AdapterDecision;
  approvalClass: ApprovalClass;
  riskClass: string;
  receipt: ExecutionReceipt;
  /** Server-derived risk class that drove the policy decision. */
  serverRiskClass: string;
  /** The client's original riskClass claim (for audit / override detection). */
  clientClaimedRiskClass: string;
  /** Where the risk classification came from. */
  riskSource: "coding_taxonomy" | "general_taxonomy" | "fail_closed_default";
}

export interface RunActionOptions {
  /** Injectable clock for deterministic receipts. Defaults to Date.now()-based ISO. */
  now?: () => string;
  /**
   * Optional ExecutionStore (e.g. InMemoryExecutionStore or PgExecutionStore).
   * When provided:
   *   - decision==="allowed": opens a workflow and advances it to "running"
   *     (planned → approved → running). The workflow id is included in the
   *     receipt as `executionId`.
   *   - decision==="approval_required": opens a workflow in "planned" state and
   *     returns its id as `approvalToken` in the receipt (awaiting external approval).
   *   - decision==="denied": no workflow is opened (no-op for the store).
   * When omitted, the adapter behaves exactly as sub-step 1 (pure, no side effects).
   */
  executionStore?: ExecutionStore;
  /**
   * Actor label for ExecutionWorkflow transitions. Defaults to the intent's actorId.
   */
  workflowActor?: string;
  /** TTL (ms) for the signed ApprovalCapabilityToken on "approval_required". Default 15min. */
  capabilityTtlMs?: number;
  /**
   * Optional KillSwitch — when tripped, forces decision to "denied" regardless of
   * normal policy. The verdict is included in the receipt for audit. fail-closed:
   * a missing killSwitch is treated as not-tripped (no denial).
   */
  killSwitch?: KillSwitch;
  /**
   * Optional agent provenance input. When provided, it is normalized to a
   * vendor-neutral canonical record and bound into the receipt signature.
   */
  provenance?: AgentProvenanceInput;
}

/**
 * Canonical signing payload for a receipt — deterministic (fixed field order),
 * excludes the receipt's own signature, and binds the signed decision trace.
 * executionId and approvalToken are included when present so the receipt is
 * tamper-evident: you cannot swap the workflow that was opened.
 */
function canonicalReceiptPayload(r: Omit<ExecutionReceipt, "signature">): string {
  const ks = r.killSwitchVerdict;
  const ksPart = ks
    ? `${ks.tripped}:${ks.scope ?? ""}:${ks.reason ?? ""}`
    : "";
  return [
    r.version,
    r.intentId,
    r.tenantId,
    r.actorId,
    r.toolId,
    r.resourceRef,
    r.riskClass,
    r.approvalClass,
    r.decision,
    r.valueMicrounits,
    r.issuedAt,
    r.decisionTrace.signature, // bind the approval trace into the receipt
    r.serverRiskClass,
    r.clientClaimedRiskClass,
    r.riskSource,
    r.executionId ?? "",        // bind the opened workflow id (empty if not opened)
    r.approvalToken ?? "",      // bind the approval token (empty if not waiting)
    r.approvalCapabilityToken ?? "", // bind the signed capability token (empty if none)
    r.kid ?? "",                // bind the signing key identifier (empty for HMAC)
    ksPart,                     // bind kill-switch verdict (empty if not consulted)
    r.provenance?.provenanceId ?? "", // bind agent provenance fingerprint (empty if absent)
  ].join("|");
}

/**
 * runActionThroughTfa — evaluate an ActionIntent and emit a decision + signed receipt.
 *
 * Sub-step 1 (pure): connects to the orchestrator's canonical policy functions.
 * Sub-step 2 (durable): when `opts.executionStore` is provided, opens an ExecutionWorkflow:
 *   - "allowed" → planned → approved → running  (executionId in receipt)
 *   - "approval_required" → planned              (approvalToken in receipt; awaits approval)
 *   - "denied" → no workflow opened (no-op)
 *
 * INVARIANTS
 *   • fail-closed: workflow errors do not swallow the decision — if the store fails,
 *     the error propagates. The caller chooses whether to retry or surface it.
 *   • tenant isolation: the workflow is opened under valid.tenantId.
 *   • the receipt signature covers executionId/approvalToken so they are tamper-evident.
 */
export function runActionThroughTfa(
  intent: ActionIntent,
  signer: Signer,
  opts: RunActionOptions = {},
): RunActionResult {
  // fail-closed: rejects any malformed / expired intent.
  const valid = validateActionIntent(intent);

  // Server-side risk classification overrides ANY client-supplied riskClass.
  // This is the Trust Gate: the server decides how dangerous the action is.
  const clientClaimedRiskClass = valid.riskClass;
  const { riskClass: serverRiskClass, source: riskSource } = classifyActionServerSide(valid.toolId);
  (valid as any).riskClass = serverRiskClass;

  // Resolve approval through the SAME canonical mapping the router uses.
  const approvalClass = resolveApprovalClass(serverRiskClass);
  let decision = decisionForApprovalClass(approvalClass);

  // KillSwitch chokepoint: when tripped, downgrade ANY decision to denied.
  let killSwitchVerdict: KillSwitchVerdict | undefined;
  if (opts.killSwitch) {
    const ksResult = applyKillSwitch(decision, opts.killSwitch, { tenantId: valid.tenantId, actionType: valid.toolId });
    decision = ksResult.decision as AdapterDecision;
    killSwitchVerdict = ksResult.killSwitch;
  }

  // Normalize provenance when provided; fail-closed on malformed input propagates.
  const provenance = opts.provenance ? normalizeAgentProvenance(opts.provenance) : undefined;

  // Reuse the kernel's signed decision-trace logic (it reads ctx.riskClass only).
  // v320: also inject agentProvenance so it is cryptographically bound into the
  // DecisionTrace signature — the agent's identity is tamper-evident at the policy
  // layer, not only in the outer receipt.
  const ctx = { riskClass: serverRiskClass, ...(provenance !== undefined ? { agentProvenance: provenance } : {}) } as ActionContext;

  // v243: run the pre-action simulation (dry-run) so its predicted effect is
  // bound into the signed DecisionTrace — and from there, surfaced on the
  // ExecutionReceipt for callers who don't want to re-derive it. simulateAction
  // is pure (no I/O); errors are swallowed (advisory only, never gates the
  // decision) per the same fail-open-for-advisory-data contract used by the
  // approval-policy router itself.
  let simulation: SimulationResult | undefined;
  try {
    simulation = simulateAction({ actionType: valid.toolId, valueMicrounits: valid.valueMicrounits });
  } catch {
    // Advisory only — proceed without simulation if it fails for any reason.
  }

  const decisionTrace = createDecisionTrace(ctx, approvalClass, signer, "tfa-agent-adapter", simulation);

  const issuedAt = opts.now ? opts.now() : new Date().toISOString();
  const actor = opts.workflowActor ?? valid.actorId;

  // ── Sub-step 2: open an ExecutionWorkflow when a store is provided ──────────
  let executionId: string | undefined;
  let approvalToken: string | undefined;
  let approvalCapabilityToken: string | undefined;

  if (opts.executionStore) {
    const store = opts.executionStore;

    if (decision === "allowed") {
      // Open and immediately advance to "running" (planned → approved → running).
      const wf = store.create({
        tenantId: valid.tenantId,
        actionId: valid.nonce as any, // intentId doubles as the actionId for this workflow
        intentId: valid.nonce,
      });
      store.transition(wf.id, valid.tenantId, "approved", actor, "auto-approved by TFA policy");
      store.transition(wf.id, valid.tenantId, "running", actor, "execution started by TFA adapter");
      executionId = wf.id;
    } else if (decision === "approval_required") {
      // Open in "planned" state — awaits an external approval step.
      const wf = store.create({
        tenantId: valid.tenantId,
        actionId: valid.nonce as any,
        intentId: valid.nonce,
      });
      approvalToken = wf.id;
      // Also issue a SIGNED capability token bound to this workflow (executionId+
      // tenantId+TTL+nonce). approvalToken (raw id) stays for backward-compat; new
      // consumers should migrate to this tamper-evident capability.
      const capTtl = opts.capabilityTtlMs ?? CAPABILITY_TOKEN_DEFAULT_TTL_MS;
      approvalCapabilityToken = encodeCapabilityToken(
        issueCapabilityToken(wf.id, valid.tenantId, signer, capTtl, opts.now),
      );
    }
    // decision === "denied": no workflow opened. The receipt is the proof of denial.
  }

  const unsigned: Omit<ExecutionReceipt, "signature"> = {
    version: "tfa-receipt-v1",
    intentId: valid.nonce,
    tenantId: valid.tenantId,
    actorId: valid.actorId,
    toolId: valid.toolId,
    resourceRef: valid.resourceRef,
    riskClass: serverRiskClass,
    approvalClass,
    decision,
    valueMicrounits: valid.valueMicrounits.toString(),
    decisionTrace,
    issuedAt,
    serverRiskClass,
    clientClaimedRiskClass,
    riskSource,
    ...(executionId !== undefined ? { executionId } : {}),
    ...(approvalToken !== undefined ? { approvalToken } : {}),
    ...(approvalCapabilityToken !== undefined ? { approvalCapabilityToken } : {}),
    ...(signer.kid !== undefined ? { kid: signer.kid } : {}),
    ...(killSwitchVerdict !== undefined ? { killSwitchVerdict } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
  const signature = signer.sign(canonicalReceiptPayload(unsigned));
  const receipt: ExecutionReceipt = { ...unsigned, signature };

  return { decision, approvalClass, riskClass: serverRiskClass, receipt, serverRiskClass, clientClaimedRiskClass, riskSource };
}

/**
 * ExecutionStatusReceipt — a signed, portable snapshot of a workflow's current status.
 *
 * Issued on demand via GET /api/execution/:id/receipt. Useful for:
 *   • Polling after POST /api/execution/:id/approve — confirms the workflow is now "running".
 *   • Webhook payloads — a self-verifying proof of the state at a point in time.
 *   • Audit evidence — a third party can verify status without querying the TFA server.
 *
 * The signature covers a deterministic canonical payload so any party with the
 * signer's verify key can confirm both the workflow id and its current status
 * without re-querying TFA (portable, self-verifying).
 *
 * version: "tfa-status-receipt-v1" — distinct from "tfa-receipt-v1" (the initial
 * decision receipt) to avoid version confusion.
 */
export interface ExecutionStatusReceipt {
  version: "tfa-status-receipt-v1";
  executionId: string;     // workflow id
  tenantId: string;
  status: string;          // current ExecutionStatus
  actorId: string;         // actor from the last run-log entry
  runLogLength: number;    // tamper-evident: increasing monotonically
  issuedAt: string;        // ISO-8601 timestamp of this receipt
  signature: string;       // signature over canonical payload (see below)
}

/**
 * Canonical signing payload for a status receipt.
 * Deterministic field order — same algorithm as the decision receipt.
 * Covers executionId+status+runLogLength so you cannot swap a status or
 * truncate the log without breaking the signature.
 */
function canonicalStatusReceiptPayload(
  r: Omit<ExecutionStatusReceipt, "signature">,
): string {
  return [
    r.version,
    r.executionId,
    r.tenantId,
    r.status,
    r.actorId,
    String(r.runLogLength),
    r.issuedAt,
  ].join("|");
}

/**
 * buildStatusReceipt — build and sign an ExecutionStatusReceipt from a live workflow.
 *
 * The receipt reflects the workflow's current status (whatever it is now, including
 * post-approval "running"). It is freshly signed at issuedAt so callers can use
 * it as a timestamped proof of state.
 *
 * fail-closed: throws if the workflow has an empty run-log (invariant violation).
 * The signer must be the same one used at runtime (HMAC or Ed25519).
 *
 * Zero external dependencies.
 */
export function buildStatusReceipt(
  wf: ExecutionWorkflow,
  signer: Signer,
  now?: () => string,
): ExecutionStatusReceipt {
  if (wf.runLog.length === 0) {
    throw new Error(`workflow ${wf.id} has an empty run-log (invariant violation)`);
  }
  const lastEntry = wf.runLog[wf.runLog.length - 1];
  const issuedAt = now ? now() : new Date().toISOString();

  const unsigned: Omit<ExecutionStatusReceipt, "signature"> = {
    version: "tfa-status-receipt-v1",
    executionId: wf.id,
    tenantId: wf.tenantId,
    status: wf.status,
    actorId: lastEntry.actor,
    runLogLength: wf.runLog.length,
    issuedAt,
  };

  const signature = signer.sign(canonicalStatusReceiptPayload(unsigned));
  return { ...unsigned, signature };
}

/**
 * verifyStatusReceipt — confirm an ExecutionStatusReceipt's signature.
 * Returns true only if the signature is valid.
 * fail-closed: any structural problem returns false (never throws).
 */
export function verifyStatusReceipt(
  receipt: ExecutionStatusReceipt,
  signer: Signer,
): boolean {
  try {
    if (!receipt || receipt.version !== "tfa-status-receipt-v1") return false;
    if (typeof receipt.signature !== "string" || receipt.signature.length === 0) return false;
    const { signature, ...unsigned } = receipt;
    return signer.verify(canonicalStatusReceiptPayload(unsigned), signature);
  } catch {
    return false;
  }
}

export interface ExecutionReceiptVerifyKeys {
  /** Legacy direct signer (HMAC or Ed25519). */
  signer?: Signer;
  /**
   * KeyRing for kid-based verification — the preferred path for portable proofs.
   * When receipt carries a `kid` AND keyRing is provided, resolves the key from
   * the ring and verifies against THAT key. Rotation-proof; revoked keys fail.
   */
  keyRing?: import("../passport/key-ring.ts").KeyRing;
}

/**
 * verifyExecutionReceipt — confirm a receipt's signature AND its embedded decision
 * trace, without re-running policy. Returns true only if both verify.
 * Supports direct Signer or KeyRing-based verification.
 * fail-closed: any structural problem returns false (never throws).
 */
export function verifyExecutionReceipt(receipt: ExecutionReceipt, keys: Signer | ExecutionReceiptVerifyKeys): boolean {
  try {
    if (!receipt || receipt.version !== "tfa-receipt-v1") return false;
    if (typeof receipt.signature !== "string" || receipt.signature.length === 0) return false;

    const { signature, ...unsigned } = receipt;
    const payload = canonicalReceiptPayload(unsigned);

    // Determine signer function and trace verifier
    let verifySignature: (data: string, sig: string) => boolean;
    let verifyTrace: (data: string, sig: string) => boolean;

    const kid = typeof receipt.kid === "string" && receipt.kid.length > 0 ? receipt.kid : null;

    if ("sign" in (keys as any) && "verify" in (keys as any)) {
      // Legacy Signer path
      const signer = keys as Signer;
      verifySignature = (data, sig) => signer.verify(data, sig);
      verifyTrace = (data, sig) => signer.verify(data, sig);
    } else {
      const k = keys as ExecutionReceiptVerifyKeys;
      if (kid && k.keyRing) {
        // KeyRing path (rotation-proof)
        verifySignature = (data, sig) => k.keyRing!.verify(data, sig, kid);
        verifyTrace = (data, sig) => k.keyRing!.verify(data, sig, kid);
      } else if (k.signer) {
        verifySignature = (data, sig) => k.signer!.verify(data, sig);
        verifyTrace = (data, sig) => k.signer!.verify(data, sig);
      } else {
        return false; // no usable key material
      }
    }

    if (!verifySignature(payload, signature)) return false;

    // Verify the embedded approval trace too, rebuilding the EXACT canonical
    // payload via the exported canonicalTracePayload() — this must stay in
    // lock-step with createDecisionTrace()'s signing payload, INCLUDING the
    // simulation field when present (v243) and contextualRisk when present (v286),
    // or verification will spuriously fail for any receipt whose decision trace
    // carries those fields.
    const t = receipt.decisionTrace;
    const tracePayload = canonicalTracePayload(
      "tfa-agent-adapter",
      t.riskClass,
      t.approvalClass,
      t.timestamp,
      t.simulation,
      (t as any).contextualRisk,
      (t as any).riskIntelligence,
      t.provenance,
    );
    return verifyTrace(tracePayload, t.signature);
  } catch {
    return false;
  }
}
