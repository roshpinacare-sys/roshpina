/**
 * lib/rbac/require-scope.ts — lightweight, zero-dependency RBAC chokepoint.
 *
 * Usage inside a route handler:
 *
 *   const denial = requireScope(c.scopes, "admin:key-rotation");
 *   if (denial) return denial;
 *
 * Or to require ANY of several scopes (OR semantics):
 *
 *   const denial = requireAnyScope(c.scopes, ["admin:key-rotation", "superadmin"]);
 *   if (denial) return denial;
 *
 * Or to require ALL scopes (AND semantics):
 *
 *   const denial = requireAllScopes(c.scopes, ["data:read", "data:write"]);
 *   if (denial) return denial;
 *
 * Design:
 *   • Always fail-closed: if `scopes` is undefined/null/empty, access is denied.
 *   • Returns `{ status: 403, body: { error: string } }` on denial, `null` on pass.
 *   • The caller decides whether to `return` the denial or combine it with other checks.
 *   • No state, no side-effects, pure function — safe to call anywhere.
 *
 * KNOWN_SCOPES: the canonical list of all defined API-key scopes in TFA.
 *   Used for documentation and to validate scope strings at key-creation time.
 *   Kept here (close to the enforcement logic) as a single source of truth.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal denial response shape — compatible with all route Res interfaces. */
export interface ScopeDenial {
  readonly status: 403;
  readonly body: { readonly error: string };
}

// ─── Known scopes (canonical registry) ───────────────────────────────────────

/**
 * All defined scopes.  Add here when introducing a new privileged operation.
 * Format: "<resource>:<action>" or "<resource>:<sub-resource>:<action>".
 */
export const KNOWN_SCOPES = [
  // Key management
  "admin:key-rotation",

  // Spend-budget management (set/delete tenant and per-actor caps, v420)
  "admin:budget-write",

  // Emergency / break-glass access (issues short-lived signed scope tickets)
  "admin:break-glass",

  // KillSwitch emergency stop / circuit breaker control
  "admin:kill-switch",

  // Agent adapter — intent submission
  "adapter:run",

  // Execution management
  "execution:approve",
  "execution:read",

  // Settlement / escrow
  "settlement:write",
  "settlement:read",

  // Ledger (internal transfer authority)
  "ledger:mint",
  "ledger:transfer",

  // Data export / import
  "sovereignty:export",
  "sovereignty:import",

  // Indexer read-only
  "index:read",

  // MCP server access (JSON-RPC 2.0 bridge)
  "mcp:execute",

  // Catch-all admin (grants all of the above)
  "superadmin",
] as const;

export type Scope = (typeof KNOWN_SCOPES)[number];

// ─── Module-level constant Set for isKnownScope ───────────────────────────────

/**
 * O(1) lookup set for isKnownScope().
 * KNOWN_SCOPES has 17 fixed entries; building this once at module load replaces
 * an O(n) KNOWN_SCOPES.includes() linear scan on every API-key validation call.
 */
const KNOWN_SCOPES_SET: ReadonlySet<string> = new Set(KNOWN_SCOPES);

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Require exactly `scope` to be present.
 * Returns a 403 denial object if the check fails, `null` if it passes.
 *
 * Note: "superadmin" is always accepted as a wildcard when checking any scope.
 *
 * Efficiency: converts `scopes` array to a Set once (O(n) one-time cost) then
 * uses O(1) Set.has() for all membership tests — called on every authenticated
 * API request, so eliminating the repeated O(n) .includes() scans matters.
 */
export function requireScope(
  scopes: string[] | undefined | null,
  scope: string,
): ScopeDenial | null {
  if (!scopes || scopes.length === 0) {
    return deny(`missing ${scope} scope`);
  }
  const scopeSet = new Set(scopes);
  if (scopeSet.has("superadmin") || scopeSet.has(scope)) {
    return null;
  }
  return deny(`missing ${scope} scope`);
}

/**
 * Require AT LEAST ONE of `allowedScopes` to be present (OR semantics).
 * "superadmin" always passes.
 */
export function requireAnyScope(
  scopes: string[] | undefined | null,
  allowedScopes: string[],
): ScopeDenial | null {
  if (!scopes || scopes.length === 0) {
    return deny(`missing one of: ${allowedScopes.join(", ")}`);
  }
  const scopeSet = new Set(scopes);
  if (scopeSet.has("superadmin")) return null;
  for (const s of allowedScopes) {
    if (scopeSet.has(s)) return null;
  }
  return deny(`missing one of: ${allowedScopes.join(", ")}`);
}

/**
 * Require ALL `requiredScopes` to be present (AND semantics).
 * "superadmin" always passes (bypasses all checks).
 */
export function requireAllScopes(
  scopes: string[] | undefined | null,
  requiredScopes: string[],
): ScopeDenial | null {
  if (!scopes || scopes.length === 0) {
    if (requiredScopes.length === 0) return null;
    return deny(`missing required scopes: ${requiredScopes.join(", ")}`);
  }
  const scopeSet = new Set(scopes);
  if (scopeSet.has("superadmin")) return null;
  const missing = requiredScopes.filter((s) => !scopeSet.has(s));
  if (missing.length === 0) return null;
  return deny(`missing required scopes: ${missing.join(", ")}`);
}

/**
 * Validate that a scope string is in the known-scopes registry.
 * Useful at key-creation time to reject unknown scope strings.
 * Uses the module-level KNOWN_SCOPES_SET for O(1) lookup.
 */
export function isKnownScope(scope: string): scope is Scope {
  return KNOWN_SCOPES_SET.has(scope);
}

// ─── Private ──────────────────────────────────────────────────────────────────

function deny(message: string): ScopeDenial {
  return { status: 403, body: { error: message } };
}
