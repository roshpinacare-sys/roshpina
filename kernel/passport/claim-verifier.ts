/**
 * lib/passport/claim-verifier.ts — offline verifier for PassportClaim.
 *
 * Pure, zero-dependency (node:crypto only). Recomputes the claim body hash
 * via canonicalPassportClaim and verifies the signature.
 *
 * Returns a structured report so callers can see exactly which checks passed,
 * failed, or were skipped.
 */

import { createHash, createHmac, timingSafeEqual, verify as edVerify } from "node:crypto";
import { canonicalPassportClaim } from "./claim";
import type { KeyRing } from "./key-ring";

export interface ClaimCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  message?: string;
}

export interface ClaimVerifyResult {
  ok: boolean;
  checks: ClaimCheck[];
}

export interface ClaimVerifyKeys {
  /** HMAC secret (Buffer or string) for hmac-sha256 algorithm. */
  hmacSecret?: Buffer | string;
  /** Ed25519 SPKI PEM for ed25519 algorithm. */
  publicKey?: string;
  /**
   * KeyRing for kid-based verification — the preferred path for portable proofs.
   * When the claim carries a `kid` field AND a keyRing is provided, the verifier
   * resolves the key from the ring (including retired/historical keys) and verifies
   * against THAT key. This is what makes a proof rotation-proof.
   *
   * fail-closed: unknown kid → fail; revoked kid → fail (even historical proofs).
   * If no kid is present in the claim, falls back to hmacSecret / publicKey.
   */
  keyRing?: KeyRing;
}

export interface ClaimVerifyOpts {
  /** When true, "skipped" checks cause the result to be not ok. */
  strict?: boolean;
}

/** Verify a PassportClaim. */
export function verifyPassportClaim(
  claim: unknown,
  keys: ClaimVerifyKeys = {},
  opts: ClaimVerifyOpts = {},
): ClaimVerifyResult {
  const checks: ClaimCheck[] = [];
  const addPass = (name: string) => checks.push({ name, status: "pass" });
  const addFail = (name: string, message: string) => checks.push({ name, status: "fail", message });
  const addSkip = (name: string, message: string) => checks.push({ name, status: "skipped", message });

  // ── shape ──────────────────────────────────────────────────────────────
  if (!claim || typeof claim !== "object") {
    addFail("shape", "claim is not an object");
    return { ok: false, checks };
  }

  const c = claim as Record<string, unknown>;
  if (c.version !== "1") {
    addFail("shape.version", `unsupported version: ${c.version}`);
    return { ok: false, checks };
  }

  const required = [
    "claimId",
    "issuedAt",
    "issuer",
    "subject",
    "scope",
    "evidenceRefs",
    "revocationStatus",
    "algorithm",
    "hash",
    "signature",
  ];
  for (const k of required) {
    if (c[k] === undefined) {
      addFail("shape", `missing field: ${k}`);
      return { ok: false, checks };
    }
  }
  addPass("shape");

  // ── revocationStatus value check ───────────────────────────────────────
  const status = c.revocationStatus;
  if (status !== "active" && status !== "revoked" && status !== "expired") {
    addFail("revocationStatus", `unknown status: ${status}`);
  } else {
    addPass("revocationStatus");
  }

  // ── hash recomputation ─────────────────────────────────────────────────
  const { hash: _h, signature: _s, ...body } = c;
  const expectedHash = sha256Hex(canonicalPassportClaim(body));
  if (expectedHash !== c.hash) {
    addFail("claim.hash", `recomputed ${expectedHash} != ${c.hash}`);
  } else {
    addPass("claim.hash");
  }

  // ── signature verification ───────────────────────────────────────────────
  const algo = String(c.algorithm);
  const kid = typeof c.kid === "string" && c.kid.length > 0 ? c.kid : null;

  // ── KeyRing path (rotation-proof): preferred when claim carries kid ──────
  if (kid && keys.keyRing) {
    keys.keyRing.verify(String(c.hash), String(c.signature), kid)
      ? addPass("claim.signature.keyring")
      : addFail("claim.signature.keyring", `KeyRing verification failed for kid: ${kid}`);
  } else if (algo === "hmac-sha256") {
    if (keys.hmacSecret) {
      const secretBuf = Buffer.isBuffer(keys.hmacSecret)
        ? keys.hmacSecret
        : Buffer.from(keys.hmacSecret, "utf8");
      verifyHmac(String(c.hash), String(c.signature), secretBuf)
        ? addPass("claim.signature.hmac")
        : addFail("claim.signature.hmac", "HMAC verification failed");
    } else {
      addSkip("claim.signature.hmac", "no hmacSecret provided");
    }
  } else if (algo === "ed25519") {
    if (keys.publicKey) {
      verifyEd25519(String(c.hash), String(c.signature), keys.publicKey)
        ? addPass("claim.signature.ed25519")
        : addFail("claim.signature.ed25519", "Ed25519 verification failed");
    } else {
      addSkip("claim.signature.ed25519", "no publicKey provided");
    }
  } else {
    addFail("claim.algorithm", `unknown algorithm: ${algo}`);
  }

  const strict = !!opts.strict;
  const ok = checks.every((c) => c.status === "pass" || (!strict && c.status === "skipped"));
  return { ok, checks };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
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
