/**
 * lib/passport/key-ring.ts — KeyRing: KID-based verification key resolver.
 *
 * THE PORTABILITY MOAT
 * --------------------
 * A portable proof is only worth something if a third party can still verify it
 * *years later* — including after the issuer has rotated signing keys. The kernel
 * already supports rotation (MutableSigner), but a verifier that holds only the
 * *current* public key cannot verify a proof signed by a *previous* key. That
 * breaks "portable proof".
 *
 * The KeyRing closes that gap. It is a verifier-side registry of key history:
 *   • every signing key gets a stable `kid` (key id) derived from its material;
 *   • a proof carries the `kid` it was signed with;
 *   • the verifier resolves `kid → key entry` from the ring and verifies against
 *     THAT key — so an old proof stays verifiable across any number of rotations.
 *
 * fail-closed:
 *   • unknown kid → reject (never "trust by default");
 *   • REVOKED kid → reject ALWAYS (a compromised key must invalidate its proofs,
 *     even historical ones — this is the one case where old proofs stop verifying);
 *   • "retiring" keys still verify (that is the rotation overlap window).
 *
 * Ed25519-first: asymmetric keys mean verifiers hold only PUBLIC keys and can
 * verify offline without ever holding a secret. HMAC is supported for symmetric
 * internal use but is not portable in the same way.
 *
 * Zero external dependencies (node:crypto only).
 */

import { createHash, createHmac, timingSafeEqual, verify as edVerify } from "node:crypto";

export type KeyAlgorithm = "ed25519" | "hmac-sha256";
export type KeyStatus = "active" | "retiring" | "revoked";

export interface KeyRingEntry {
  /** Stable key id derived from the key material (see computeKid). */
  kid: string;
  algorithm: KeyAlgorithm;
  /** SPKI PEM public key — required for ed25519 verification. */
  publicKey?: string;
  /** HMAC secret — required for hmac-sha256 verification (symmetric). */
  secret?: string;
  status: KeyStatus;
  createdAt: string;
  retiredAt?: string;
}

export class KeyRingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "KeyRingError";
  }
}

/**
 * computeKid — a deterministic, collision-resistant key id derived from the key
 * material. The same public key (or secret) always yields the same kid, so a
 * proof's kid is stable across processes and deployments.
 *
 * Format: 16 lowercase hex chars (64-bit fingerprint) — consistent with
 * Ed25519Signer.kid so receipts and passports resolve through KeyRing end-to-end.
 */
export function computeKid(algorithm: KeyAlgorithm, keyMaterial: string): string {
  if (algorithm !== "ed25519" && algorithm !== "hmac-sha256") {
    throw new KeyRingError("invalid_algorithm", `unknown algorithm: ${String(algorithm)}`);
  }
  if (typeof keyMaterial !== "string" || keyMaterial.length === 0) {
    throw new KeyRingError("invalid_key_material", "keyMaterial must be a non-empty string");
  }
  // For ed25519, hash the raw keyMaterial (publicKey PEM) to match Ed25519Signer.kid.
  // For hmac-sha256, include the algorithm prefix to disambiguate from ed25519.
  const input = algorithm === "ed25519" ? keyMaterial : `${algorithm}|${keyMaterial}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * KeyRing — verifier-side registry of key history. Holds many keys; resolves a
 * proof's kid to the key that signed it; verifies fail-closed.
 */
export class KeyRing {
  private readonly keys = new Map<string, KeyRingEntry>();

  /** Number of keys currently registered. */
  get size(): number {
    return this.keys.size;
  }

  /**
   * Register a key. The entry must carry the verification material its algorithm
   * needs (publicKey for ed25519, secret for hmac-sha256). Re-registering the
   * same kid replaces the entry (e.g. to update status).
   */
  register(entry: KeyRingEntry): void {
    if (!entry || typeof entry !== "object") {
      throw new KeyRingError("invalid_entry", "entry must be an object");
    }
    if (typeof entry.kid !== "string" || entry.kid.length === 0) {
      throw new KeyRingError("invalid_kid", "kid must be a non-empty string");
    }
    if (entry.algorithm === "ed25519") {
      if (typeof entry.publicKey !== "string" || entry.publicKey.length === 0) {
        throw new KeyRingError("missing_public_key", "ed25519 entry requires a publicKey (SPKI PEM)");
      }
    } else if (entry.algorithm === "hmac-sha256") {
      if (typeof entry.secret !== "string" || entry.secret.length === 0) {
        throw new KeyRingError("missing_secret", "hmac-sha256 entry requires a secret");
      }
    } else {
      throw new KeyRingError("invalid_algorithm", `unknown algorithm: ${String(entry.algorithm)}`);
    }
    const status: KeyStatus = entry.status ?? "active";
    if (status !== "active" && status !== "retiring" && status !== "revoked") {
      throw new KeyRingError("invalid_status", `unknown status: ${String(status)}`);
    }
    this.keys.set(entry.kid, { ...entry, status });
  }

  /** Resolve a kid to its entry, or null if unknown. */
  resolve(kid: string): KeyRingEntry | null {
    if (typeof kid !== "string" || kid.length === 0) return null;
    return this.keys.get(kid) ?? null;
  }

  /** The current active key (the one new proofs should be signed with), or null. */
  active(): KeyRingEntry | null {
    for (const e of this.keys.values()) {
      if (e.status === "active") return e;
    }
    return null;
  }

  /**
   * Rotate: mark every current "active" key as "retiring" and register the new
   * key as "active". Old proofs keep verifying against the retiring keys until
   * those keys are revoked.
   */
  rotate(newActive: KeyRingEntry, now: string = new Date().toISOString()): void {
    for (const [kid, e] of this.keys) {
      if (e.status === "active") this.keys.set(kid, { ...e, status: "retiring", retiredAt: now });
    }
    this.register({ ...newActive, status: "active" });
  }

  /** Revoke a kid (compromise): its proofs stop verifying immediately, forever. */
  revoke(kid: string, now: string = new Date().toISOString()): void {
    const e = this.keys.get(kid);
    if (!e) throw new KeyRingError("unknown_kid", `cannot revoke unknown kid: ${kid}`);
    this.keys.set(kid, { ...e, status: "revoked", retiredAt: now });
  }

  /** List all known key entries (active, retiring, and revoked). */
  list(): KeyRingEntry[] {
    return [...this.keys.values()];
  }

  /**
   * Verify a signature against the key resolved by `kid`.
   * fail-closed: unknown kid, revoked kid, or any error → false.
   */
  verify(payload: string, signatureB64: string, kid: string): boolean {
    try {
      const entry = this.resolve(kid);
      if (!entry) return false;                 // unknown key → reject
      if (entry.status === "revoked") return false; // compromised key → reject always
      if (typeof payload !== "string" || typeof signatureB64 !== "string") return false;

      if (entry.algorithm === "ed25519") {
        if (!entry.publicKey) return false;
        const sig = Buffer.from(signatureB64, "base64");
        return edVerify(null, Buffer.from(payload, "utf8"), entry.publicKey, sig);
      }
      // hmac-sha256
      if (!entry.secret) return false;
      const expected = createHmac("sha256", entry.secret).update(payload).digest();
      const got = Buffer.from(signatureB64, "base64");
      if (expected.length !== got.length) return false;
      return timingSafeEqual(expected, got);
    } catch {
      return false;
    }
  }
}
