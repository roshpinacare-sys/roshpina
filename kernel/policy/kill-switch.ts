/**
 * lib/policy/kill-switch.ts — KillSwitch: emergency stop / circuit breaker.
 *
 * WHY (use-breaking gap, OWASP Agentic guidance): a production trust gate must be
 * able to STOP instantly — a runaway agent, a compromised tenant, or a dangerous
 * class of action — without a redeploy. Consulted by the approval path; when
 * tripped, forces a `denied` decision regardless of normal policy.
 *
 * Three independent scopes (any one trips → deny):
 *   • GLOBAL       — halt everything (big red button).
 *   • TENANT       — halt one tenant (compromised key, billing freeze).
 *   • ACTION TYPE  — halt one action class everywhere (freeze all infra.apply).
 *
 * fail-closed: malformed isTripped() input trips (deny), never opens. Each
 * engagement carries a reason for the audit trail. Zero external dependencies.
 */

export type KillSwitchScope = "global" | "tenant" | "action_type";

export interface KillSwitchVerdict {
  tripped: boolean;
  scope?: KillSwitchScope;
  reason?: string;
}

export interface KillSwitchCheck {
  tenantId?: string;
  actionType?: string;
}

export class KillSwitch {
  private globalReason: string | null = null;
  private readonly tenantReasons = new Map<string, string>();
  private readonly actionTypeReasons = new Map<string, string>();

  engageGlobal(reason: string): void { this.globalReason = nonEmpty(reason, "global kill-switch reason"); }
  disengageGlobal(): void { this.globalReason = null; }

  engageTenant(tenantId: string, reason: string): void {
    this.tenantReasons.set(nonEmpty(tenantId, "tenantId"), nonEmpty(reason, "tenant kill-switch reason"));
  }
  disengageTenant(tenantId: string): void { this.tenantReasons.delete(tenantId); }

  engageActionType(actionType: string, reason: string): void {
    this.actionTypeReasons.set(nonEmpty(actionType, "actionType"), nonEmpty(reason, "action-type kill-switch reason"));
  }
  disengageActionType(actionType: string): void { this.actionTypeReasons.delete(actionType); }

  get isArmed(): boolean {
    return this.globalReason !== null || this.tenantReasons.size > 0 || this.actionTypeReasons.size > 0;
  }

  /** fail-closed: a malformed check trips. Global > tenant > action_type. */
  isTripped(check: KillSwitchCheck): KillSwitchVerdict {
    if (!check || typeof check !== "object") {
      return { tripped: true, scope: "global", reason: "fail-closed: malformed kill-switch check" };
    }
    if (this.globalReason !== null) return { tripped: true, scope: "global", reason: this.globalReason };
    if (typeof check.tenantId === "string" && this.tenantReasons.has(check.tenantId)) {
      return { tripped: true, scope: "tenant", reason: this.tenantReasons.get(check.tenantId) };
    }
    if (typeof check.actionType === "string" && this.actionTypeReasons.has(check.actionType)) {
      return { tripped: true, scope: "action_type", reason: this.actionTypeReasons.get(check.actionType) };
    }
    return { tripped: false };
  }

  snapshot(): { global: string | null; tenants: string[]; actionTypes: string[] } {
    return { global: this.globalReason, tenants: [...this.tenantReasons.keys()], actionTypes: [...this.actionTypeReasons.keys()] };
  }
}

export type AdapterDecisionLike = "allowed" | "approval_required" | "denied";

/** Downgrade ANY decision to "denied" when the switch is tripped; else passthrough. */
export function applyKillSwitch<T extends AdapterDecisionLike>(
  decision: T, killSwitch: KillSwitch, check: KillSwitchCheck,
): { decision: AdapterDecisionLike; killSwitch: KillSwitchVerdict } {
  const verdict = killSwitch.isTripped(check);
  return verdict.tripped ? { decision: "denied", killSwitch: verdict } : { decision, killSwitch: verdict };
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`KillSwitch: ${field} must be a non-empty string`);
  return value;
}
