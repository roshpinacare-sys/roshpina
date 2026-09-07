/**
 * lib/policy/policy-schema.ts — Declarative policy (policy-as-DATA, not code).
 * The pivot from feature to platform: a third party (or a tenant admin) authors governance as a
 * JSON document — spending limits, allowed action types, autonomy rules — WITHOUT touching kernel
 * code. The compiler turns this into a GuardPolicy the Orchestrator already understands.
 * Money limits are micro-cents (μ¢) as decimal strings to preserve BigInt precision in JSON.
 */
export type Effect = "allow" | "deny";

export interface PolicyCondition {
  /** action.type is one of these */
  actionType?: string[];
  /** action.type is NOT one of these (use for fail-closed allow-lists) */
  actionTypeNotIn?: string[];
  /** payload.amount (μ¢) strictly greater than this decimal string */
  amountAbove?: string;
  /** payload.amount (μ¢) at most this decimal string */
  amountAtMost?: string;
  /** match action.isAutonomous */
  isAutonomous?: boolean;
  /** match action.isFinancial */
  isFinancial?: boolean;
  /** action.source is one of these */
  source?: string[];
  /** ctx.tenantId is one of these */
  tenantId?: string[];
  /**
   * Minimum trust score (0–100) required for the action's source identity.
   * Evaluated via TrustScoreProvider injected at compile time.
   * Fail-closed: if no provider is configured, the condition never matches (deny path).
   * This is the heart of Trust Price Discovery — earned authority, not asserted identity.
   */
  minTrustScore?: number;
  /**
   * Maximum number of allowed financial actions (ledger.mint/withdraw/transfer with
   * outcome="allowed") the tenant may have performed so far in the current calendar
   * month (UTC). If the tenant's count is >= this value, the condition matches —
   * intended to be paired with `then: "deny"` to implement plan limits (free/pro)
   * as policy-as-data, not code.
   *
   * Evaluated via UsageCountProvider injected at compile time.
   * Fail-closed: if no provider is configured, the condition never matches
   * (limits silently not enforced is safer than blocking everything — but note
   * this means the provider MUST be wired for limits to take effect).
   */
  maxMonthlyActions?: number;
}

export interface PolicyRule {
  /** all present fields must match (AND). Empty condition = always matches. */
  if: PolicyCondition;
  then: Effect;
  /** required when then="deny" — recorded in the audit */
  reason?: string;
}

export interface DeclarativePolicy {
  name: string;
  /** evaluated in order; first matching rule wins */
  rules: PolicyRule[];
  /** applied when no rule matches. Omit → "deny" (fail-closed by default). */
  default?: Effect;
}
