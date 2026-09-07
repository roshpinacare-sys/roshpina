/**
 * lib/risk/confidence-gate.ts — ConfidenceGate GuardPolicy
 *
 * PURPOSE
 * -------
 * Maps an agent-supplied confidence score (0.0–1.0) to an approval decision:
 *
 *   score ≥ autoThreshold       → "auto"   (allowed, decision recorded)
 *   score ≥ hitlThreshold       → "human"  (HITL required, returned as deny to force queuing)
 *   score <  hitlThreshold      → "deny"   (blocked)
 *
 * This implements the ecos candidate "Confidence/HITL gate" pattern as a clean
 * GuardPolicy that integrates with the existing approval-policy chain (placed
 * AFTER approvalPolicyRouter, or as a standalone gate for confidence-aware actions).
 *
 * DESIGN PRINCIPLES
 * -----------------
 * • Governance-as-DATA: thresholds live in `ConfidenceGateConfig` so tenant admins
 *   can ship different policies without touching kernel code.
 * • FAIL-CLOSED: missing/invalid/NaN score = 0 (lowest confidence → deny).
 * • Signed decision trace (`ConfidenceGateTrace`) covers score + verdict + thresholds
 *   so the gate's decision is tamper-evident and auditable.
 * • Does NOT replace approvalPolicyRouter — it composes with it. Recommended
 *   placement: THIRD in chain (after injectRiskClass, approvalPolicyRouter).
 * • Zero external dependencies — node:crypto only (through Signer interface).
 *
 * CONFIDENCE SCORE SOURCES
 * ------------------------
 * • ActionIntent.confidenceScore (optional field, set by the calling agent)
 * • Injected via ctx.confidenceScore from a pre-processing step
 * • If absent, treated as 0 (fail-closed)
 *
 * INTEGRATION
 * -----------
 * ```ts
 * import { confidenceGate, DEFAULT_CONFIDENCE_CONFIG } from "./confidence-gate";
 * const gate = confidenceGate(signer, DEFAULT_CONFIDENCE_CONFIG);
 * const policies = [injectRiskClass(), approvalPolicyRouter(signer), gate];
 * ```
 */

import type { ActionContext, ApprovalClass, GuardPolicy, Signer } from "../orchestrator/types";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * ConfidenceGateConfig — thresholds that govern score→verdict mapping.
 *
 * All thresholds are inclusive on the lower bound (score ≥ threshold = passes).
 * Invariant: 0 ≤ hitlThreshold ≤ autoThreshold ≤ 1.
 */
export interface ConfidenceGateConfig {
  /**
   * Minimum score for auto-approval.
   * score ≥ autoThreshold → auto (proceed without human).
   * Default: 0.85
   */
  autoThreshold: number;
  /**
   * Minimum score for HITL queuing.
   * hitlThreshold ≤ score < autoThreshold → human review required.
   * score < hitlThreshold → deny.
   * Default: 0.50
   */
  hitlThreshold: number;
  /**
   * Name of this gate instance, recorded in the trace.
   * Default: "confidence-gate"
   */
  name?: string;
}

/**
 * DEFAULT_CONFIDENCE_CONFIG — conservative defaults.
 * Tune per-tenant by constructing a different config.
 */
export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceGateConfig = {
  autoThreshold: 0.85,
  hitlThreshold: 0.50,
  name: "confidence-gate",
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class ConfidenceGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConfidenceGateError";
  }
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

/**
 * ConfidenceVerdict — the gate's decision for a given score.
 * Maps to ApprovalClass for audit consistency.
 */
export type ConfidenceVerdict = "auto" | "human" | "deny";

/**
 * ConfidenceGateTrace — signed, tamper-evident record of the gate's decision.
 * Analogous to DecisionTrace in approval-policy.ts.
 */
export interface ConfidenceGateTrace {
  policy: string;
  score: number;           // clamped to [0, 1]; NaN/missing → 0
  verdict: ConfidenceVerdict;
  autoThreshold: number;
  hitlThreshold: number;
  timestamp: string;
  signature: string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * validateConfig — fail-closed config validation.
 * Throws ConfidenceGateError if thresholds violate invariants.
 */
export function validateConfig(cfg: ConfidenceGateConfig): void {
  if (cfg.hitlThreshold < 0 || cfg.hitlThreshold > 1) {
    throw new ConfidenceGateError("invalid_threshold", `hitlThreshold must be in [0, 1], got ${cfg.hitlThreshold}`);
  }
  if (cfg.autoThreshold < 0 || cfg.autoThreshold > 1) {
    throw new ConfidenceGateError("invalid_threshold", `autoThreshold must be in [0, 1], got ${cfg.autoThreshold}`);
  }
  if (cfg.hitlThreshold > cfg.autoThreshold) {
    throw new ConfidenceGateError(
      "invalid_threshold",
      `hitlThreshold (${cfg.hitlThreshold}) must be ≤ autoThreshold (${cfg.autoThreshold})`,
    );
  }
}

// ─── Score resolution ─────────────────────────────────────────────────────────

/**
 * resolveScore — extract confidence score from ActionContext.
 * fail-closed: missing, undefined, NaN, Infinity, or out-of-range → 0.
 */
export function resolveScore(ctx: ActionContext): number {
  const raw = ctx.confidenceScore;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 0; // fail-closed: don't treat > 1 as max confidence
  return raw;
}

// ─── Verdict resolution ───────────────────────────────────────────────────────

/**
 * resolveVerdict — map score → verdict given the gate config.
 * Thresholds are inclusive on the lower bound.
 * fail-closed: any score below hitlThreshold → deny.
 */
export function resolveVerdict(score: number, cfg: ConfidenceGateConfig): ConfidenceVerdict {
  if (score >= cfg.autoThreshold) return "auto";
  if (score >= cfg.hitlThreshold) return "human";
  return "deny";
}

// ─── Canonical signing ────────────────────────────────────────────────────────

function canonicalTracePayload(
  policy: string,
  score: number,
  verdict: ConfidenceVerdict,
  autoThreshold: number,
  hitlThreshold: number,
  timestamp: string,
): string {
  // Keys sorted for determinism
  return JSON.stringify({
    autoThreshold,
    hitlThreshold,
    policy,
    score,
    timestamp,
    verdict,
  });
}

// ─── GuardPolicy factory ──────────────────────────────────────────────────────

/**
 * confidenceGate — factory that returns a GuardPolicy implementing the confidence
 * gate with the given signer and configuration.
 *
 * Behaviour:
 *   • Resolves the confidence score from `ctx.confidenceScore` (fail-closed: 0 if absent)
 *   • Maps score → verdict using `cfg.autoThreshold` and `cfg.hitlThreshold`
 *   • Signs a ConfidenceGateTrace and stores it on `ctx.confidenceGateTrace` (JSON)
 *   • "auto"  → allow: true  (gate passes; downstream policies still apply)
 *   • "human" → allow: false (reason: HITL_REQUIRED — orchestrator should queue for review)
 *   • "deny"  → allow: false (reason: CONFIDENCE_BELOW_THRESHOLD — hard block)
 *
 * fail-closed: if cfg is invalid (throws from validateConfig), the factory itself
 * throws — this surfaces misconfiguration at startup, not at evaluation time.
 *
 * @param signer  — Same signer used throughout the stack (HMAC-SHA256 or Ed25519)
 * @param cfg     — Gate thresholds; default = DEFAULT_CONFIDENCE_CONFIG
 * @param now     — Injectable clock for deterministic tests
 */
export function confidenceGate(
  signer: Signer,
  cfg: ConfidenceGateConfig = DEFAULT_CONFIDENCE_CONFIG,
  now?: () => string,
): GuardPolicy {
  // Fail fast on misconfiguration
  validateConfig(cfg);

  const name = cfg.name ?? "confidence-gate";

  return {
    name,
    evaluate(ctx: ActionContext) {
      const score = resolveScore(ctx);
      const verdict = resolveVerdict(score, cfg);
      const timestamp = now ? now() : new Date().toISOString();

      const payload = canonicalTracePayload(
        name,
        score,
        verdict,
        cfg.autoThreshold,
        cfg.hitlThreshold,
        timestamp,
      );
      const signature = signer.sign(payload);

      const trace: ConfidenceGateTrace = {
        policy: name,
        score,
        verdict,
        autoThreshold: cfg.autoThreshold,
        hitlThreshold: cfg.hitlThreshold,
        timestamp,
        signature,
      };

      // Always attach trace to ctx so the orchestrator can record it
      ctx.confidenceGateTrace = JSON.stringify(trace);

      if (verdict === "auto") {
        return { allow: true };
      }

      if (verdict === "human") {
        return {
          allow: false,
          reason: `HITL_REQUIRED: confidence score ${score} is below autoThreshold ${cfg.autoThreshold} — human review required | trace=${ctx.confidenceGateTrace}`,
        };
      }

      // deny
      return {
        allow: false,
        reason: `CONFIDENCE_BELOW_THRESHOLD: score ${score} < hitlThreshold ${cfg.hitlThreshold} — action blocked | trace=${ctx.confidenceGateTrace}`,
      };
    },
  };
}

/**
 * verifyConfidenceGateTrace — verify the signature on a ConfidenceGateTrace.
 * fail-closed: any structural or crypto problem → false (never throws).
 */
export function verifyConfidenceGateTrace(
  trace: ConfidenceGateTrace,
  signer: Signer,
): boolean {
  try {
    if (!trace || typeof trace !== "object") return false;
    const { signature, ...unsigned } = trace;
    if (typeof signature !== "string" || signature.length === 0) return false;

    const payload = canonicalTracePayload(
      unsigned.policy,
      unsigned.score,
      unsigned.verdict,
      unsigned.autoThreshold,
      unsigned.hitlThreshold,
      unsigned.timestamp,
    );

    return signer.verify(payload, signature);
  } catch {
    return false;
  }
}
