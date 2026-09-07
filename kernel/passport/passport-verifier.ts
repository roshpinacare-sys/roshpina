/**
 * lib/passport/passport-verifier.ts — offline verifier for ActionPassport with KeyRing support.
 *
 * Pure, zero-dependency (node:crypto only). Recomputes the passport body hash
 * via canonicalStringify and verifies signatures including the KeyRing path.
 *
 * Returns a structured report so callers can see exactly which checks passed,
 * failed, or were skipped.
 *
 * v381: Additive — PassportRevocationList check inserted before signature
 * verification. If a revocation list is supplied and the passport is on it,
 * the check fails immediately (fail-closed). No-list → check skipped (backward
 * compatible). Tenant-scoped: uses passport.tenantId to scope the lookup.
 */

import { createHash, createHmac, timingSafeEqual, verify as edVerify } from "node:crypto";
import { canonicalStringify } from "./passport";
import type { KeyRing } from "./key-ring";
import type { ActionPassport } from "./types";
import type { PassportRevocationList } from "./passport-revocation-list";

export interface PassportCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  message?: string;
}

export interface PassportVerifyResult {
  ok: boolean;
  checks: PassportCheck[];
}

export interface PassportVerifyKeys {
  /** HMAC secret for passport-level HMAC-SHA256 signatures. */
  hmacSecret?: Buffer | string;
  /** Ed25519 SPKI PEM for passport-level Ed25519 signatures. */
  publicKey?: string;
  /** HMAC secret for audit-record-level HMAC-SHA256 signatures. */
  auditHmacSecret?: Buffer | string;
  /** Ed25519 SPKI PEM public key for audit-record-level Ed25519 signatures. */
  auditPublicKey?: string;
  /**
   * KeyRing for kid-based verification — the preferred path for portable proofs.
   * When the passport carries a `kid` field AND a keyRing is provided, the verifier
   * resolves the key from the ring (including retired/historical keys) and verifies
   * against THAT key. This is what makes a proof rotation-proof.
   *
   * fail-closed: unknown kid → fail; revoked kid → fail (even historical proofs).
   * If no kid is present in the passport, falls back to hmacSecret / publicKey.
   */
  keyRing?: KeyRing;
  /**
   * Per-passport revocation list (v381).
   * When provided, the verifier checks whether the passport's passportId has been
   * individually revoked for its tenant BEFORE checking signatures.
   * fail-closed: if the passport is on the list, the "passport.revocation" check
   * fails and the result is not ok — regardless of signature validity.
   * No list supplied → check is "skipped" (backward compatible).
   */
  revocationList?: PassportRevocationList;
}

export interface PassportVerifyOpts {
  /** When true, "skipped" checks cause the result to be not ok. */
  strict?: boolean;
}

/** Verify an ActionPassport. */
export function verifyActionPassport(
  passport: unknown,
  keys: PassportVerifyKeys = {},
  opts: PassportVerifyOpts = {},
): PassportVerifyResult {
  const checks: PassportCheck[] = [];
  const addPass = (name: string) => checks.push({ name, status: "pass" });
  const addFail = (name: string, message: string) => checks.push({ name, status: "fail", message });
  const addSkip = (name: string, message: string) => checks.push({ name, status: "skipped", message });

  // ── shape ──────────────────────────────────────────────────────────────
  if (!passport || typeof passport !== "object") {
    addFail("shape", "passport is not an object");
    return { ok: false, checks };
  }

  const p = passport as Record<string, unknown>;
  if (p.version !== "1") {
    addFail("shape.version", `unsupported version: ${p.version}`);
    return { ok: false, checks };
  }

  const required = [
    "passportId",
    "issuedAt",
    "tenantId",
    "audit",
    "policyDecision",
    "algorithm",
    "hash",
    "signature",
  ];
  for (const k of required) {
    if (p[k] === undefined) {
      addFail("shape", `missing field: ${k}`);
      return { ok: false, checks };
    }
  }
  addPass("shape");

  // ── per-passport revocation check (v381) ───────────────────────────────
  // Checked before signature verification: a revoked passport must be rejected
  // even if the signature is still mathematically valid.
  if (keys.revocationList) {
    const passportId = String(p.passportId);
    const tenantId = String(p.tenantId);
    if (keys.revocationList.isRevoked(passportId, tenantId)) {
      const entry = keys.revocationList.get(passportId, tenantId);
      addFail(
        "passport.revocation",
        `passport ${passportId} has been individually revoked: ${entry?.reason ?? "revoked"}`,
      );
      return { ok: false, checks };
    }
    addPass("passport.revocation");
  } else {
    addSkip("passport.revocation", "no revocation list provided");
  }

  // ── audit hash recomputation ───────────────────────────────────────────
  const audit = p.audit as Record<string, unknown>;
  const expectedAuditHash = computeAuditHash(audit);
  const auditHash = audit.hash as string;
  if (expectedAuditHash !== auditHash) {
    addFail("audit.hash", `recomputed ${expectedAuditHash} != ${auditHash}`);
  } else {
    addPass("audit.hash");
  }

  // ── audit signature (optional) ─────────────────────────────────────────
  if (audit.signature) {
    if (keys.auditHmacSecret) {
      const secretBuf = Buffer.isBuffer(keys.auditHmacSecret)
        ? keys.auditHmacSecret
        : Buffer.from(keys.auditHmacSecret, "utf8");
      verifyHmac(auditHash, audit.signature as string, secretBuf)
        ? addPass("audit.signature.hmac")
        : addFail("audit.signature.hmac", "HMAC verification failed");
    } else if (keys.auditPublicKey) {
      verifyEd25519(auditHash, audit.signature as string, keys.auditPublicKey)
        ? addPass("audit.signature.ed25519")
        : addFail("audit.signature.ed25519", "Ed25519 verification failed");
    } else {
      addSkip("audit.signature", "no audit key provided");
    }
  } else {
    addSkip("audit.signature", "audit record was not signed");
  }

  // ── passport body hash recomputation ───────────────────────────────────
  const { hash: _h, signature: _s, ...body } = p;
  const expectedPassportHash = sha256Hex(canonicalStringify(body));
  const passportHash = p.hash as string;
  if (expectedPassportHash !== passportHash) {
    addFail("passport.hash", `recomputed ${expectedPassportHash} != ${passportHash}`);
  } else {
    addPass("passport.hash");
  }

  // ── passport signature ─────────────────────────────────────────────────
  const algo = String(p.algorithm);
  const kid = typeof p.kid === "string" && p.kid.length > 0 ? p.kid : null;

  // ── KeyRing path (rotation-proof): preferred when passport carries kid ─
  if (kid && keys.keyRing) {
    keys.keyRing.verify(passportHash, p.signature as string, kid)
      ? addPass("passport.signature.keyring")
      : addFail("passport.signature.keyring", `KeyRing verification failed for kid: ${kid}`);
  } else if (algo === "hmac-sha256") {
    if (keys.hmacSecret) {
      const secretBuf = Buffer.isBuffer(keys.hmacSecret)
        ? keys.hmacSecret
        : Buffer.from(keys.hmacSecret, "utf8");
      verifyHmac(passportHash, p.signature as string, secretBuf)
        ? addPass("passport.signature.hmac")
        : addFail("passport.signature.hmac", "HMAC verification failed");
    } else {
      addSkip("passport.signature.hmac", "no hmacSecret provided");
    }
  } else if (algo === "ed25519") {
    if (keys.publicKey) {
      verifyEd25519(passportHash, p.signature as string, keys.publicKey)
        ? addPass("passport.signature.ed25519")
        : addFail("passport.signature.ed25519", "Ed25519 verification failed");
    } else {
      addSkip("passport.signature.ed25519", "no publicKey provided");
    }
  } else {
    addFail("passport.algorithm", `unknown algorithm: ${algo}`);
  }

  const strict = !!opts.strict;
  const ok = checks.every((c) => c.status === "pass" || (!strict && c.status === "skipped"));
  return { ok, checks };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function computeAuditHash(audit: Record<string, unknown>): string {
  const data = [
    audit.id,
    audit.tenantId,
    audit.actionType,
    audit.outcome,
    audit.prevHash,
  ].join("|");
  return sha256Hex(data);
}

function verifyHmac(data: string, signatureB64: string, secretBuf: Buffer): boolean {
  try {
    const expected = createHmac("sha256", secretBuf).update(data, "utf8").digest();
    const actual = Buffer.from(signatureB64, "base64");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function verifyEd25519(data: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(data, "utf8"), publicKeyPem, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
