/**
 * lib/mcp-server/capability-token.ts — ApprovalCapabilityToken
 *
 * PURPOSE
 * -------
 * The weak approvalToken (just a workflow-id) allows anyone who knows the id
 * and tenantId to approve any workflow — no expiry, no nonce protection.
 *
 * This module introduces a cryptographically-signed `ApprovalCapabilityToken`
 * that `tfa_approve_execution` can validate, giving:
 *   • Expiry:   token is invalid after `expiresAt`
 *   • Nonce:    single-use; the MCP server checks the nonce hasn't been seen
 *   • Binding:  signature covers executionId + tenantId + expiresAt + nonce
 *               so you cannot reuse a token for a different workflow or tenant
 *
 * TOKEN FORMAT (JSON, base64url-encoded before transport)
 * -------------------------------------------------------
 * {
 *   version:     "tfa-cap-v1"
 *   executionId: string    — bound workflow
 *   tenantId:    string    — bound tenant
 *   issuedAt:   string    — ISO-8601
 *   expiresAt:  string    — ISO-8601
 *   nonce:       string    — random, single-use
 *   signature:   string    — HMAC-SHA256 / Ed25519 over canonical payload
 * }
 *
 * CANONICAL PAYLOAD (deterministic, pipe-separated, same scheme as other receipts)
 * -------------------------------------------------------
 * `${version}|${executionId}|${tenantId}|${issuedAt}|${expiresAt}|${nonce}`
 *
 * FAIL-CLOSED INVARIANTS
 * -------------------------------------------------------
 * • `issueCapability()`: both executionId and tenantId must be non-empty.
 *   ttlMs must be positive. Throws `CapabilityError` on violation.
 * • `verifyCapabilityToken()`: returns `{ valid: false, reason }` on any
 *   structural or semantic error — never throws, never grants access on error.
 * • Expired token → invalid (clock checked against `now` param, injectable
 *   for tests).
 * • Nonce reuse detection is the caller's responsibility — the `usedNonces`
 *   Set should be held by the MCP server instance (see TfaMcpServer).
 *   This module exports `extractNonce()` to support that check.
 *
 * ZERO EXTERNAL DEPENDENCIES — node:crypto only.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Signer } from "../orchestrator/types.ts";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ApprovalCapabilityToken {
  version: "tfa-cap-v1";
  executionId: string;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export type CapabilityVerifyResult =
  | { valid: true; executionId: string; tenantId: string; nonce: string }
  | { valid: false; reason: string };

export const CAPABILITY_TOKEN_DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Error ───────────────────────────────────────────────────────────────────

export class CapabilityError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "CapabilityError";
  }
}

// ─── Canonical payload ───────────────────────────────────────────────────────

function canonicalPayload(
  t: Omit<ApprovalCapabilityToken, "signature">,
): string {
  return [
    t.version,
    t.executionId,
    t.tenantId,
    t.issuedAt,
    t.expiresAt,
    t.nonce,
  ].join("|");
}

// ─── Issue ───────────────────────────────────────────────────────────────────

/**
 * Issue a signed ApprovalCapabilityToken for a specific workflow.
 *
 * @param executionId  — The workflow to bind this capability to (required, non-empty)
 * @param tenantId     — The tenant that owns the workflow (required, non-empty)
 * @param signer       — Signer instance (HMAC-SHA256 or Ed25519)
 * @param ttlMs        — Token lifetime in ms (default: 15 min)
 * @param now          — Injectable clock for deterministic tests
 *
 * Throws `CapabilityError` if executionId or tenantId are empty, or ttlMs ≤ 0.
 */
export function issueCapabilityToken(
  executionId: string,
  tenantId: string,
  signer: Signer,
  ttlMs = CAPABILITY_TOKEN_DEFAULT_TTL_MS,
  now?: () => string,
): ApprovalCapabilityToken {
  if (!executionId) {
    throw new CapabilityError("missing_execution_id", "executionId is required");
  }
  if (!tenantId) {
    throw new CapabilityError("missing_tenant_id", "tenantId is required");
  }
  if (ttlMs <= 0) {
    throw new CapabilityError("invalid_ttl", "ttlMs must be positive");
  }

  const issuedAt = now ? now() : new Date().toISOString();
  const expiresAt = new Date(new Date(issuedAt).getTime() + ttlMs).toISOString();
  const nonce = randomBytes(16).toString("hex");

  const unsigned: Omit<ApprovalCapabilityToken, "signature"> = {
    version: "tfa-cap-v1",
    executionId,
    tenantId,
    issuedAt,
    expiresAt,
    nonce,
  };

  const signature = signer.sign(canonicalPayload(unsigned));
  return { ...unsigned, signature };
}

/**
 * Encode a capability token to a base64url string for transport.
 */
export function encodeCapabilityToken(token: ApprovalCapabilityToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/**
 * Decode a capability token from a base64url string.
 * Returns null if the string is not valid base64url JSON.
 */
export function decodeCapabilityToken(
  encoded: string,
): ApprovalCapabilityToken | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== "tfa-cap-v1"
    ) {
      return null;
    }
    return parsed as ApprovalCapabilityToken;
  } catch {
    return null;
  }
}

/**
 * Verify an ApprovalCapabilityToken.
 *
 * Checks:
 *   1. Structural validity (version, required fields)
 *   2. Signature (signer.verify)
 *   3. Expiry (expiresAt vs now)
 *   4. executionId + tenantId match the expected values (if provided)
 *
 * Does NOT check nonce reuse — that's the caller's responsibility.
 * fail-closed: any error → { valid: false, reason }.
 *
 * @param token           — The capability token to verify
 * @param signer          — Must be the same signer used at issuance
 * @param expectedId      — If provided, token.executionId must equal this
 * @param expectedTenant  — If provided, token.tenantId must equal this
 * @param nowMs           — Injectable clock for deterministic tests (ms since epoch)
 */
export function verifyCapabilityToken(
  token: unknown,
  signer: Signer,
  expectedId?: string,
  expectedTenant?: string,
  nowMs?: number,
): CapabilityVerifyResult {
  try {
    if (!token || typeof token !== "object" || Array.isArray(token)) {
      return { valid: false, reason: "token must be an object" };
    }

    const t = token as Record<string, unknown>;

    if (t.version !== "tfa-cap-v1") {
      return { valid: false, reason: `unknown token version: ${t.version}` };
    }

    for (const field of ["executionId", "tenantId", "issuedAt", "expiresAt", "nonce", "signature"] as const) {
      if (typeof t[field] !== "string" || (t[field] as string).length === 0) {
        return { valid: false, reason: `missing or empty field: ${field}` };
      }
    }

    const typed = t as unknown as ApprovalCapabilityToken;

    // Verify signature
    const { signature, ...unsigned } = typed;
    const ok = signer.verify(canonicalPayload(unsigned), signature);
    if (!ok) {
      return { valid: false, reason: "signature verification failed" };
    }

    // Check expiry
    const expiryMs = new Date(typed.expiresAt).getTime();
    const currentMs = nowMs ?? Date.now();
    if (currentMs > expiryMs) {
      return { valid: false, reason: "capability token has expired" };
    }

    // Check binding
    if (expectedId && typed.executionId !== expectedId) {
      return {
        valid: false,
        reason: `token is bound to a different executionId: expected "${expectedId}", got "${typed.executionId}"`,
      };
    }
    if (expectedTenant && typed.tenantId !== expectedTenant) {
      return {
        valid: false,
        reason: `token is bound to a different tenantId (tenant isolation violation)`,
      };
    }

    return {
      valid: true,
      executionId: typed.executionId,
      tenantId: typed.tenantId,
      nonce: typed.nonce,
    };
  } catch {
    return { valid: false, reason: "unexpected error during capability verification" };
  }
}

/**
 * Extract the nonce from a token object for deduplication checking.
 * Returns null if not present.
 */
export function extractNonce(token: unknown): string | null {
  if (!token || typeof token !== "object" || Array.isArray(token)) return null;
  const n = (token as Record<string, unknown>).nonce;
  return typeof n === "string" && n.length > 0 ? n : null;
}
