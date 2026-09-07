/**
 * lib/orchestrator/action-intent.ts — ActionIntent canonical object + fail-closed validator.
 *
 * First item from MANIFEST "החסר הבא": ActionIntent canonical object with
 * tenantId, actorId, toolId, resourceRef, riskClass, valueMicrounits(μ¢),
 * privacyLevel, approvalPolicyRef, nonce, expiry, provenance, evidencePolicy
 * + validator fail-closed.
 *
 * DESIGN
 * ------
 * • validateActionIntent is FAIL-CLOSED: any missing, malformed, or out-of-range
 *   field throws a descriptive error. No silent defaults.
 * • canonicalActionIntent produces deterministic JSON (sorted keys) for signing
 *   and hashing — the same canonical rules used by DecisionTrace.
 * • All monetary values validated as BigInt μ¢, non-negative.
 * • expiry validated as valid ISO-8601 and must be strictly in the future.
 * • riskClass validated against the canonical RISK_CLASSES set.
 * • privacyLevel validated against the canonical PRIVACY_LEVELS set.
 *
 * Zero external dependencies — node:crypto only for deterministic JSON.
 */

import type { ActionIntent, ActionRiskClass, PrivacyLevel } from "./types.ts";

/** Canonical privacy levels, ordered least→most restrictive. */
export const PRIVACY_LEVELS: readonly PrivacyLevel[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

const VALID_RISK_CLASSES = new Set<string>([
  "read_only",
  "write_safe",
  "write_destructive",
  "value_moving",
  "irreversible",
  "privacy_sensitive",
  "regulated",
]);

const VALID_PRIVACY_LEVELS = new Set<string>(PRIVACY_LEVELS as readonly string[]);

/** Validates that `value` is a non-empty string. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ActionIntent validation failed: ${field} must be a non-empty string`);
  }
  return value;
}

/** Validates that `value` is a valid ISO-8601 timestamp string. */
function requireISOTimestamp(value: unknown, field: string): string {
  const s = requireNonEmptyString(value, field);
  // ISO-8601 requires at least a T or a space separator and a valid Date parse.
  if (!/\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new Error(`ActionIntent validation failed: ${field} must be a valid ISO-8601 timestamp`);
  }
  return s;
}

/**
 * validateActionIntent — fail-closed validator.
 * Throws on any invalid or missing field. Returns the validated intent.
 */
export function validateActionIntent(intent: unknown): ActionIntent {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
    throw new Error("ActionIntent validation failed: input must be an object");
  }
  const obj = intent as Record<string, unknown>;

  const tenantId = requireNonEmptyString(obj.tenantId, "tenantId");
  const actorId = requireNonEmptyString(obj.actorId, "actorId");
  const toolId = requireNonEmptyString(obj.toolId, "toolId");
  const resourceRef = requireNonEmptyString(obj.resourceRef, "resourceRef");
  const approvalPolicyRef = requireNonEmptyString(obj.approvalPolicyRef, "approvalPolicyRef");
  const nonce = requireNonEmptyString(obj.nonce, "nonce");
  const provenance = requireNonEmptyString(obj.provenance, "provenance");
  const evidencePolicy = requireNonEmptyString(obj.evidencePolicy, "evidencePolicy");

  // riskClass
  const riskClassRaw = obj.riskClass;
  if (typeof riskClassRaw !== "string" || !VALID_RISK_CLASSES.has(riskClassRaw)) {
    throw new Error(`ActionIntent validation failed: riskClass must be a valid ActionRiskClass`);
  }
  const riskClass = riskClassRaw as ActionRiskClass;

  // valueMicrounits — must be BigInt, non-negative
  const valueRaw = obj.valueMicrounits;
  if (typeof valueRaw !== "bigint") {
    throw new Error(`ActionIntent validation failed: valueMicrounits must be BigInt μ¢`);
  }
  if (valueRaw < 0n) {
    throw new Error(`ActionIntent validation failed: valueMicrounits must be non-negative`);
  }

  // privacyLevel
  const privacyLevelRaw = obj.privacyLevel;
  if (typeof privacyLevelRaw !== "string" || !VALID_PRIVACY_LEVELS.has(privacyLevelRaw)) {
    throw new Error(`ActionIntent validation failed: privacyLevel must be a valid PrivacyLevel`);
  }
  const privacyLevel = privacyLevelRaw as PrivacyLevel;

  // expiry — valid ISO-8601 and in the future
  const expiry = requireISOTimestamp(obj.expiry, "expiry");
  const now = Date.now();
  const expiryMs = Date.parse(expiry);
  if (expiryMs <= now) {
    throw new Error(`ActionIntent validation failed: expiry must be in the future`);
  }

  return {
    tenantId,
    actorId,
    toolId,
    resourceRef,
    riskClass,
    valueMicrounits: valueRaw,
    privacyLevel,
    approvalPolicyRef,
    nonce,
    expiry,
    provenance,
    evidencePolicy,
  };
}

/**
 * Create a canonical JSON string of an ActionIntent.
 * Keys are emitted in pre-sorted (lexicographic) order — no runtime sort needed
 * because the field set is fixed and known at authoring time.
 * BigInt values are serialized as strings to avoid JSON limitations.
 *
 * Efficiency: eliminates Object.keys()+.sort()+object-rebuild on every signing
 * call by inlining the 12 keys in their correct order at compile time — O(1)
 * instead of O(k log k) per invocation.
 */
export function canonicalActionIntent(intent: ActionIntent): string {
  // Keys in lexicographic order (verified: actorId < approvalPolicyRef < evidencePolicy
  // < expiry < nonce < privacyLevel < provenance < resourceRef < riskClass
  // < tenantId < toolId < valueMicrounits).
  return JSON.stringify({
    actorId:          intent.actorId,
    approvalPolicyRef: intent.approvalPolicyRef,
    evidencePolicy:   intent.evidencePolicy,
    expiry:           intent.expiry,
    nonce:            intent.nonce,
    privacyLevel:     intent.privacyLevel,
    provenance:       intent.provenance,
    resourceRef:      intent.resourceRef,
    riskClass:        intent.riskClass,
    tenantId:         intent.tenantId,
    toolId:           intent.toolId,
    valueMicrounits:  intent.valueMicrounits.toString(),
  });
}
