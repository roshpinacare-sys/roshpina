/**
 * lib/passport/claim.ts — PassportClaim: portable, versioned claim about a passport.
 *
 * A PassportClaim is a signed, self-contained assertion issued by a TFA kernel
 * about the status of an ActionPassport. It carries:
 *   • issuer, subject, scope — who said what about which passport
 *   • evidence_refs — supporting audit record ids
 *   • revocation_status — active / revoked / expired
 *
 * The claim is canonicalised, hashed (SHA-256), and signed so it can be verified
 * offline by a zero-dependency verifier (lib/passport/claim-verifier.ts).
 *
 * Fail-closed:
 *   • missing or invalid required fields → ClaimError
 *   • unknown/empty revocationStatus → "revoked" (most restrictive)
 *   • unknown/empty scope → rejected
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Signer } from "../orchestrator/types";
import { ClaimError } from "./types";
import type { RiskEvidence } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RevocationStatus = "active" | "revoked" | "expired";

export interface PassportClaim {
  /** Schema version. Bump on breaking changes. */
  version: "1";
  /** Unique claim id (uuid). */
  claimId: string;
  /** ISO-8601 timestamp of issuance. */
  issuedAt: string;
  /** Tenant or identity that issued the claim. */
  issuer: string;
  /** The passportId (or auditId) this claim is about. */
  subject: string;
  /** What the claim asserts (e.g. "passport.status"). */
  scope: string;
  /** References to supporting evidence (audit ids, hashes, etc.). */
  evidenceRefs: string[];
  /** Current revocation status of the claim. */
  revocationStatus: RevocationStatus;
  /** Signer algorithm label, e.g. "hmac-sha256" or "ed25519". */
  algorithm: string;
  /**
   * Key id (kid) — stable reference to the KeyRing entry used to sign this
   * claim. Optional but strongly recommended for portable, rotation-proof
   * verification: the verifier resolves the kid → key from a KeyRing and
   * verifies against THAT key, not the current active key.
   *
   * When present it is part of the canonical body (included in the hash).
   */
  kid?: string;
  /**
   * Optional structured risk-intelligence evidence (v303).
   * When present it is included in the canonical body so tampering breaks the hash.
   * Gives the client direct, verifiable transparency into the evaluation score
   * and its contributing factors without parsing the audit trace manually.
   */
  riskEvidence?: RiskEvidence;
  /** SHA-256 of the canonical body (everything except `hash` + `signature`). */
  hash: string;
  /** base64 signature over `hash`. */
  signature: string;
}

export interface BuildClaimOptions {
  /** Who issues the claim. Required. */
  issuer: string;
  /** Which passport (passportId or auditId) the claim is about. Required. */
  subject: string;
  /** The claim scope. Required. */
  scope: string;
  /** Supporting evidence refs. Optional — defaults to empty. */
  evidenceRefs?: string[];
  /** Revocation status. Optional — defaults to "active". */
  revocationStatus?: RevocationStatus;
  /** Signer used to sign the claim hash. Required. */
  signer: Signer;
  /**
   * Key id (kid) to embed in the claim. Strongly recommended when the signer
   * has a stable kid (Ed25519Signer or KeyRing). Included in the canonical
   * body so the verifier knows which key to resolve.
   */
  kid?: string;
  /**
   * Optional structured risk-intelligence evidence (v303).
   * When provided it is included in the canonical body and signed.
   */
  riskEvidence?: RiskEvidence;
  /** Override `claimId` (mostly for tests). Defaults to randomUUID(). */
  claimIdFactory?: () => string;
  /** Override `issuedAt` (mostly for tests). Defaults to new Date().toISOString(). */
  now?: () => string;
}

// ─── In-memory revocation store (minimal, scoped to this module) ────────────

const _revoked = new Set<string>();

/** Revoke a claim by its claimId. Idempotent. */
export function revokeClaim(claimId: string): void {
  _revoked.add(claimId);
}

/** Check whether a claimId has been revoked. */
export function isClaimRevoked(claimId: string): boolean {
  return _revoked.has(claimId);
}

/** Clear the in-memory revocation store (test helper). */
export function clearRevocations(): void {
  _revoked.clear();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Canonical revocation statuses, ordered. */
export const REVOCATION_STATUSES: RevocationStatus[] = ["active", "revoked", "expired"];

/**
 * Build a signed PassportClaim.
 *
 * Fail-closed: every required field is validated; empty/unknown revocationStatus
 * defaults to "revoked" (most restrictive).
 */
export function buildPassportClaim(opts: BuildClaimOptions): PassportClaim {
  if (!opts || typeof opts !== "object") {
    throw new ClaimError("opts is required", "missing_options");
  }
  if (!opts.issuer || typeof opts.issuer !== "string") {
    throw new ClaimError("issuer is required and must be a non-empty string", "missing_issuer");
  }
  if (!opts.subject || typeof opts.subject !== "string") {
    throw new ClaimError("subject is required and must be a non-empty string", "missing_subject");
  }
  if (!opts.scope || typeof opts.scope !== "string") {
    throw new ClaimError("scope is required and must be a non-empty string", "missing_scope");
  }
  if (!opts.signer) {
    throw new ClaimError("signer is required", "missing_signer");
  }

  const revocationStatus = normalizeRevocationStatus(opts.revocationStatus);
  const evidenceRefs = Array.isArray(opts.evidenceRefs)
    ? opts.evidenceRefs.filter((r) => typeof r === "string" && r.length > 0)
    : [];

  const body: Record<string, unknown> = {
    version: "1" as const,
    claimId: (opts.claimIdFactory ?? randomUUID)(),
    issuedAt: (opts.now ?? defaultNow)(),
    issuer: opts.issuer,
    subject: opts.subject,
    scope: opts.scope,
    evidenceRefs,
    revocationStatus,
    algorithm: opts.signer.algorithm,
  };
  // Include kid in the body so it is covered by the hash (tamper-evident).
  if (opts.kid && typeof opts.kid === "string" && opts.kid.length > 0) {
    body.kid = opts.kid;
  }
  // Include riskEvidence in the body so it is covered by the hash (tamper-evident).
  if (opts.riskEvidence && typeof opts.riskEvidence === "object") {
    body.riskEvidence = opts.riskEvidence;
  }

  const hash = computeClaimHash(body);
  const signature = opts.signer.sign(hash);

  return { ...(body as Omit<PassportClaim, "hash" | "signature">), hash, signature };
}

/**
 * Recompute the SHA-256 hash of a claim body.
 * The body must NOT contain `hash` or `signature`.
 */
export function computeClaimHash(body: unknown): string {
  const canonical = canonicalPassportClaim(body);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Deterministic JSON for claim bodies: object keys sorted recursively,
 * arrays preserve order, primitives via JSON.stringify.
 * No BigInts in claim body, so plain JSON.stringify is safe.
 */
export function canonicalPassportClaim(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalPassportClaim).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      JSON.stringify(k) +
      ":" +
      canonicalPassportClaim((value as Record<string, unknown>)[k]),
  );
  return "{" + parts.join(",") + "}";
}

/**
 * Normalise a revocation status string.
 * Unknown/empty/undefined → "revoked" (fail-closed, most restrictive).
 */
export function normalizeRevocationStatus(status?: string): RevocationStatus {
  if (status === "active" || status === "revoked" || status === "expired") {
    return status;
  }
  return "revoked";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultNow(): string {
  return new Date().toISOString();
}
