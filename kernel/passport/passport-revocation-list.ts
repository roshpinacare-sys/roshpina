/**
 * lib/passport/passport-revocation-list.ts — Per-passport revocation list.
 *
 * Revocation today lives at the KEY level (KeyRing): when a signing key is
 * compromised, ALL passports signed with that key stop verifying. That is the
 * right behaviour for key compromise, but it is the wrong tool for fraud:
 *
 *   "Agent X submitted a fraudulent funds_transfer — revoke THAT action."
 *
 * PassportRevocationList gives each tenant a list of individual revoked
 * passport ids.  The verifier checks it independently of the KeyRing so both
 * controls can run together without coupling.
 *
 * Invariants / fail-closed:
 *   • Revocation is permanent — once a passportId is on the list it stays.
 *   • isRevoked(id, wrongTenant) → false (cross-tenant isolation, never leaks).
 *   • isRevoked with missing/empty args → false (unknown = not revoked, not error).
 *   • revoke() validates both passportId and tenantId; throws on empty string.
 *   • The reason field defaults to "revoked" when absent (never blank).
 *
 * Zero external dependencies — in-memory, pure TypeScript.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single entry in the per-tenant revocation list. */
export type RevocationEntry = {
  passportId: string;
  tenantId: string;
  /** ISO-8601 timestamp of revocation. */
  revokedAt: string;
  /** Human-readable reason (e.g. "fraudulent_transfer", "policy_violation"). */
  reason: string;
};

export class PassportRevocationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PassportRevocationError";
    this.code = code;
  }
}

// ─── PassportRevocationList ───────────────────────────────────────────────────

/**
 * PassportRevocationList — tenant-scoped, per-passport revocation registry.
 *
 * Stored as a nested Map: tenantId → passportId → RevocationEntry.
 * Additive-only: revoke() is idempotent (re-revoking is a no-op).
 */
export class PassportRevocationList {
  /** tenantId → (passportId → RevocationEntry) */
  private readonly store = new Map<string, Map<string, RevocationEntry>>();

  /**
   * Revoke a specific passport within a tenant.
   *
   * Idempotent — revoking an already-revoked passport is a safe no-op
   * (the original entry is preserved; reason is not overwritten).
   *
   * @throws PassportRevocationError if passportId or tenantId is empty/non-string.
   */
  revoke(
    passportId: string,
    tenantId: string,
    reason = "revoked",
    now: () => string = defaultNow,
  ): void {
    if (typeof passportId !== "string" || passportId.length === 0) {
      throw new PassportRevocationError("invalid_passport_id", "passportId must be a non-empty string");
    }
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new PassportRevocationError("invalid_tenant_id", "tenantId must be a non-empty string");
    }
    const effectiveReason =
      typeof reason === "string" && reason.length > 0 ? reason : "revoked";

    let tenantMap = this.store.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.store.set(tenantId, tenantMap);
    }

    // Idempotent: do not overwrite an existing entry.
    if (!tenantMap.has(passportId)) {
      tenantMap.set(passportId, {
        passportId,
        tenantId,
        revokedAt: now(),
        reason: effectiveReason,
      });
    }
  }

  /**
   * Check whether a passport has been revoked for the given tenant.
   *
   * fail-closed:
   *   • Cross-tenant: always false (never leaks another tenant's revocations).
   *   • Missing/empty args: false (cannot be revoked if we cannot find it).
   */
  isRevoked(passportId: string, tenantId: string): boolean {
    if (typeof passportId !== "string" || passportId.length === 0) return false;
    if (typeof tenantId !== "string" || tenantId.length === 0) return false;
    return this.store.get(tenantId)?.has(passportId) ?? false;
  }

  /**
   * Return the revocation entry for a passport, or null if not revoked.
   *
   * Tenant-scoped: a passportId from another tenant returns null.
   */
  get(passportId: string, tenantId: string): RevocationEntry | null {
    if (typeof passportId !== "string" || passportId.length === 0) return null;
    if (typeof tenantId !== "string" || tenantId.length === 0) return null;
    return this.store.get(tenantId)?.get(passportId) ?? null;
  }

  /**
   * List all revocation entries for a tenant, ordered by revokedAt ascending.
   *
   * Returns an empty array for unknown tenants — never throws.
   */
  list(tenantId: string): RevocationEntry[] {
    if (typeof tenantId !== "string" || tenantId.length === 0) return [];
    const tenantMap = this.store.get(tenantId);
    if (!tenantMap) return [];
    return [...tenantMap.values()].sort((a, b) => a.revokedAt.localeCompare(b.revokedAt));
  }

  /** Total number of revoked passports across ALL tenants (for monitoring). */
  get totalSize(): number {
    let n = 0;
    for (const m of this.store.values()) n += m.size;
    return n;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultNow(): string {
  return new Date().toISOString();
}
