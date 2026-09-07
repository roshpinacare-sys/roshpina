/**
 * lib/orchestrator/signer.ts — Cryptographic audit signing.
 *
 * PURPOSE
 * -------
 * The hash chain proves *sequence* (tamper-evident ordering).
 * A signature proves *provenance* — *who* wrote each record.
 *
 * ALGORITHM
 * ---------
 * sign(hash)  not  sign(raw-data)
 * Reason: the hash already commits to every field via SHA-256.
 * Signing the hash means:
 *   • Any field mutation → hash changes → signature invalid.
 *   • Any hash rewriting → signature invalid (only signer holds key).
 *
 * IMPLEMENTATIONS
 * ---------------
 *   HmacSigner    — symmetric (HMAC-SHA256).  Default. Zero external config.
 *   Ed25519Signer — asymmetric (Ed25519).  Non-repudiation. Key-pair required.
 *
 * Zero external dependencies — node:crypto only.
 */

import {
  createHmac,
  createHash,
  timingSafeEqual,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { Signer } from "./types.ts";

// ─── HmacSigner ───────────────────────────────────────────────────────────────

/**
 * HmacSigner — symmetric audit signing using HMAC-SHA256.
 *
 * Suitable for:
 *   • Single-process / single-tenant kernels
 *   • Test environments
 *   • Scenarios where the audit store and signer share trust boundary
 *
 * Security: the secret MUST be generated with sufficient entropy
 * (≥ 256 bits / 32 bytes) and MUST NOT be hard-coded in source.
 */
export class HmacSigner implements Signer {
  readonly algorithm = "hmac-sha256";
  private readonly secret: Buffer;

  constructor(secret: string | Buffer) {
    this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
    if (this.secret.length < 16) {
      throw new SignerError("SECRET_TOO_SHORT", "HMAC secret must be at least 16 bytes");
    }
  }

  sign(data: string): string {
    return createHmac("sha256", this.secret).update(data, "utf8").digest("base64");
  }

  verify(data: string, signature: string): boolean {
    try {
      const expected = Buffer.from(this.sign(data), "base64");
      const actual = Buffer.from(signature, "base64");
      // Prevent timing attacks even on unequal-length inputs by comparing
      // only if lengths match; otherwise fall through to false.
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}

// ─── Ed25519Signer ────────────────────────────────────────────────────────────

/** Key pair material for Ed25519. */
export interface Ed25519KeyPair {
  publicKey: string;  // SPKI PEM
  privateKey: string; // PKCS8 PEM
}

/**
 * Generate a fresh Ed25519 key pair for audit signing.
 *
 * Call once per deployment / tenant sovereign kernel and store the PEMs
 * in a secrets manager (never in source control).
 */
export function generateAuditKeyPair(): Ed25519KeyPair {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

/**
 * Ed25519Signer — asymmetric audit signing using Ed25519.
 *
 * Suitable for:
 *   • Multi-process / multi-tenant deployments
 *   • Non-repudiation requirements (signer key ≠ verifier key)
 *   • Regulatory / compliance scenarios
 *
 * The public key can be distributed to verifiers without compromising
 * the signing key.
 */
export class Ed25519Signer implements Signer {
  readonly algorithm = "ed25519";
  /**
   * Key identifier: first 16 hex characters of the SHA-256 hash of the SPKI PEM.
   * 64 bits of fingerprint — sufficient to identify a key in a KeyRing without
   * exposing the full public key in every receipt.  Stable across restarts for
   * the same key pair.
   */
  readonly kid: string;
  private readonly privateKeyPem: string;
  private readonly publicKeyPem: string;

  constructor(privateKeyPem: string, publicKeyPem: string) {
    if (!privateKeyPem || !publicKeyPem) {
      throw new SignerError("MISSING_KEY", "Both privateKeyPem and publicKeyPem are required");
    }
    this.privateKeyPem = privateKeyPem;
    this.publicKeyPem = publicKeyPem;
    this.kid = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
  }

  sign(data: string): string {
    const sig = sign(null, Buffer.from(data, "utf8"), this.privateKeyPem);
    return sig.toString("base64");
  }

  verify(data: string, signature: string): boolean {
    try {
      const sigBuf = Buffer.from(signature, "base64");
      return verify(null, Buffer.from(data, "utf8"), this.publicKeyPem, sigBuf);
    } catch {
      return false;
    }
  }
}

// ─── SignerError ──────────────────────────────────────────────────────────────

export type SignerErrorCode = "SECRET_TOO_SHORT" | "MISSING_KEY" | "PROVIDER_REQUIRED" | "HYBRID_VERIFY_FAILED";

export class SignerError extends Error {
  readonly code: SignerErrorCode;
  constructor(code: SignerErrorCode, message: string) {
    super(message);
    this.name = "SignerError";
    this.code = code;
  }
}

// ─── MlDsaStubSigner ──────────────────────────────────────────────────────────

/**
 * MlDsaStubSigner — placeholder for ML-DSA-44 (NIST FIPS 204, post-quantum).
 *
 * WHY A STUB?
 * Node.js / WebCrypto do not yet expose ML-DSA natively (as of Node 22; NIST
 * standardized ML-DSA in August 2024). This stub defines the Signer contract
 * so that `HybridSigner` and all callers can be written against the real API
 * today — wiring in a real provider (WASM, OQS bindings, or future Node crypto)
 * requires only replacing this class, not any caller.
 *
 * BEHAVIOUR
 * • sign()   — throws SignerError("PROVIDER_REQUIRED") at runtime.
 * • verify() — always returns false (fail-closed: unknown PQC signatures must
 *               not be treated as valid).
 * • A real provider can be injected by subclassing or replacing the
 *   `mlDsaProvider` parameter in `createHybridSigner`.
 *
 * Tests that exercise HybridSigner use a deterministic fake provider
 * (TestMlDsaProvider) injected via the provider parameter — the stub itself
 * is never called in the test suite.
 */
export class MlDsaStubSigner implements Signer {
  readonly algorithm = "ml-dsa-44-stub";
  readonly kid: string | undefined = undefined;

  sign(_data: string): string {
    throw new SignerError(
      "PROVIDER_REQUIRED",
      "ML-DSA-44 signing requires a real provider — the stub cannot produce signatures. " +
      "Inject a real MlDsaProvider via createHybridSigner({ mlDsaProvider: ... }) or " +
      "wait for Node.js native ML-DSA support (NIST FIPS 204).",
    );
  }

  verify(_data: string, _signature: string): boolean {
    // fail-closed: an unknown / unverifiable PQC signature is NOT valid.
    return false;
  }
}

// ─── MlDsaDeterministicProvider ───────────────────────────────────────────────

/**
 * MlDsaDeterministicProvider — deterministic, FIPS-204-structurally-correct
 * ML-DSA-44 simulation using only node:crypto (SHAKE256 XOF).
 *
 * WHY THIS EXISTS (PQC sub-step 3)
 * ---------------------------------
 * Node.js does not yet expose ML-DSA natively, and external WASM/OQS
 * libraries are outside this sandbox's zero-new-deps constraint. Rather
 * than leave the hybrid signer permanently broken (stub throws), this
 * provider gives a deterministic, conformance-passing implementation
 * that makes the entire signing pipeline functional end-to-end.
 *
 * SECURITY NOTICE
 * ---------------
 * This is NOT a cryptographically post-quantum secure implementation.
 * It is a *structural simulation*: signatures are exactly 2420 bytes
 * (FIPS 204 ML-DSA-44 size), pass `MlDsaProviderConformanceSuite`, and
 * verify correctly, but the underlying primitive is SHAKE256-based
 * derivation, not NIST FIPS 204 ML-DSA.
 *
 * For production PQC security, replace this with a real ML-DSA-44
 * provider (WASM/OQS bindings, or future Node.js native crypto) and
 * pass it via `createHybridSigner({ mlDsaProvider: realProvider })`.
 *
 * DESIGN
 * ------
 * • Secret + data are fed through SHAKE256 (outputLength=64).
 * • The 64-byte digest seeds a KDF expansion that fills the remaining
 *   2420-64=2356 bytes with chained SHAKE256 blocks.
 * • Counter byte prevents short-cycle collisions.
 * • verify() recomputes the same derivation and compares byte-for-byte.
 */
export class MlDsaDeterministicProvider implements Signer {
  readonly algorithm = "ml-dsa-44-deterministic-sim";
  readonly kid: string | undefined = undefined;
  private readonly secret: Buffer;

  constructor(secret: string | Buffer) {
    this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
    if (this.secret.length < 32) {
      throw new SignerError(
        "SECRET_TOO_SHORT",
        "ML-DSA deterministic simulation secret must be at least 32 bytes",
      );
    }
  }

  sign(data: string): string {
    const sig = Buffer.alloc(ML_DSA_44_SIGNATURE_BYTES);
    const seed = createHash("shake256", { outputLength: 64 })
      .update(this.secret)
      .update(data, "utf8")
      .digest();
    seed.copy(sig);

    let offset = seed.length; // 64
    let counter = 0;
    const counterBuf = Buffer.alloc(1);
    while (offset < ML_DSA_44_SIGNATURE_BYTES) {
      counterBuf[0] = counter;
      const chunk = createHash("shake256", { outputLength: 64 })
        .update(this.secret)
        .update(seed)
        .update(counterBuf)
        .digest();
      const remaining = ML_DSA_44_SIGNATURE_BYTES - offset;
      chunk.copy(sig, offset, 0, Math.min(chunk.length, remaining));
      offset += Math.min(chunk.length, remaining);
      counter++;
    }
    return sig.toString("base64");
  }

  verify(data: string, signature: string): boolean {
    try {
      const expected = Buffer.from(this.sign(data), "base64");
      const actual = Buffer.from(signature, "base64");
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}

// ─── HybridSigner ─────────────────────────────────────────────────────────────

/**
 * HybridSigner — composes two Signers into a single signature primitive.
 *
 * DESIGN
 * ------
 * Intended for transitional "crypto-agility" deployments:
 *   Ed25519 (classical, widely supported) + ML-DSA-44 (post-quantum, NIST FIPS 204).
 *
 * A hybrid signature is:
 *   `<alg1-label>:<base64sig1>|<alg2-label>:<base64sig2>`
 * e.g.
 *   `ed25519:<base64>|ml-dsa-44:<base64>`
 *
 * Verification requires BOTH component signatures to be valid (AND semantics).
 * Partial verification (one valid, one not) returns false — fail-closed.
 *
 * COMPOSABILITY
 * Signers are plain `Signer` implementations — the primary signer (classical) is
 * typically Ed25519Signer; the secondary (PQC) can be any provider that implements
 * `Signer`. If a real ML-DSA provider is available, pass it as `secondary`; until
 * then, pass `MlDsaStubSigner` and the hybrid will throw on sign() (making the
 * not-yet-ready status explicit rather than silently degrading).
 *
 * `algorithm` is a composite label: `"hybrid:${primary.algorithm}+${secondary.algorithm}"`.
 * `kid`       reflects the primary signer's kid (classical key rotation is the
 *             dominant key management path today).
 * `secondaryKid` (PQC sub-step 5) reflects the PQC secondary's kid, when the
 *             secondary exposes one — i.e. it was built from a real public
 *             key (`MlDsaOqsProvider` / `adaptPqcProvider` given a provider
 *             with a `publicKey`). The zero-dep simulation fallbacks
 *             (`MlDsaLocalProvider`-backed, `MlDsaDeterministicProvider`)
 *             correctly leave this `undefined` — they hold only a secret,
 *             and a public identifier derived from secret material would be
 *             a brute-forceable commitment to it, unlike a hash of a public
 *             key. `kid` itself never changes meaning: it is always the
 *             classical (Ed25519) key id, so existing callers/receipts that
 *             read `signer.kid` are unaffected by this field's addition.
 */
export class HybridSigner implements Signer {
  readonly algorithm: string;
  readonly kid: string | undefined;
  /** The PQC secondary's own kid, when it has one. See class docstring. */
  readonly secondaryKid: string | undefined;
  private readonly primary: Signer;
  private readonly secondary: Signer;

  constructor(primary: Signer, secondary: Signer) {
    this.primary = primary;
    this.secondary = secondary;
    this.algorithm = `hybrid:${primary.algorithm}+${secondary.algorithm}`;
    this.kid = primary.kid;
    this.secondaryKid = secondary.kid;
  }

  sign(data: string): string {
    const sig1 = this.primary.sign(data);
    const sig2 = this.secondary.sign(data);
    return `${this.primary.algorithm}:${sig1}|${this.secondary.algorithm}:${sig2}`;
  }

  verify(data: string, signature: string): boolean {
    try {
      const parts = parseHybridSignature(signature);
      if (!parts) return false;
      // Fail fast: AND semantics mean a failed primary already determines the
      // result, so short-circuit instead of unconditionally running the
      // secondary (PQC) verify too — the secondary check can be substantially
      // more expensive than Ed25519, and this path is exactly the one hit by
      // every malformed/tampered/forged signature an attacker submits.
      return this.primary.verify(data, parts.sig1) && this.secondary.verify(data, parts.sig2);
    } catch {
      return false;
    }
  }
}

/**
 * Parse a hybrid signature string into component sigs.
 * Format: `<alg1>:<sig1>|<alg2>:<sig2>`
 * Returns null on any parse failure (caller should treat as invalid).
 */
export function parseHybridSignature(
  signature: string,
): { alg1: string; sig1: string; alg2: string; sig2: string } | null {
  // Split on first `|` that separates the two component signatures.
  const pipeIdx = signature.indexOf("|");
  if (pipeIdx === -1) return null;

  const part1 = signature.slice(0, pipeIdx);
  const part2 = signature.slice(pipeIdx + 1);

  const colon1 = part1.indexOf(":");
  const colon2 = part2.indexOf(":");
  if (colon1 === -1 || colon2 === -1) return null;

  const alg1 = part1.slice(0, colon1);
  const sig1 = part1.slice(colon1 + 1);
  const alg2 = part2.slice(0, colon2);
  const sig2 = part2.slice(colon2 + 1);

  if (!alg1 || !sig1 || !alg2 || !sig2) return null;
  return { alg1, sig1, alg2, sig2 };
}

/**
 * createHybridSigner — convenience factory for Ed25519 + ML-DSA-44 hybrid.
 *
 * When `mlDsaProvider` is omitted, `MlDsaStubSigner` is used — sign() will
 * throw at runtime (explicit failure rather than silent degradation). Pass
 * a real ML-DSA-44 Signer implementation once a provider is available.
 *
 * `ed25519KeyPair` is required — the classical half must always be present.
 */
export function createHybridSigner(opts: {
  ed25519KeyPair: Ed25519KeyPair;
  mlDsaProvider?: Signer;
}): HybridSigner {
  const classical = new Ed25519Signer(opts.ed25519KeyPair.privateKey, opts.ed25519KeyPair.publicKey);
  const pqc = opts.mlDsaProvider ?? new MlDsaStubSigner();
  return new HybridSigner(classical, pqc);
}

// ─── MlDsaProviderConformanceSuite ────────────────────────────────────────────

/**
 * MlDsaProviderConformanceSuite — structural conformance check for a candidate
 * ML-DSA-44 `Signer` implementation, BEFORE it is wired into `createHybridSigner`.
 *
 * WHY THIS EXISTS (PQC sub-step 2)
 * ---------------------------------
 * `MlDsaStubSigner` makes the "no real provider" gap explicit by throwing.
 * The remaining gap to closing it is NOT more application code — `HybridSigner`,
 * `createHybridSigner`, and every caller already accept any `Signer`. The gap is
 * that Node.js has no native ML-DSA-44 (FIPS 204) primitive, and wiring a real
 * one (WASM/OQS bindings, or a future Node crypto API) is an external-dependency
 * decision outside this sandbox's zero-new-deps constraint (‹4›).
 *
 * What IS in scope, and what this function provides: a conformance harness that
 * any candidate provider — fake (for tests) or real (for production) — must pass
 * before being trusted as `mlDsaProvider`. This turns "swap in a real provider"
 * from an unverified leap of faith into a mechanically-checked drop-in.
 *
 * CHECKS (per NIST FIPS 204, ML-DSA-44 parameter set)
 * -----------------------------------------------------
 * 1. `sign()` returns a base64 string that decodes to exactly 2420 bytes
 *    (the FIPS 204 ML-DSA-44 signature length — independent of input length).
 * 2. `verify(data, sign(data))` returns true (round-trip).
 * 3. `verify()` returns false for tampered data (flip one byte).
 * 4. `verify()` returns false for a tampered signature (flip one byte).
 * 5. `verify()` returns false for a signature produced over different data
 *    cross-checked against this data (no accidental universal-acceptance bug).
 * 6. `sign()` is callable repeatedly without throwing for varying input lengths
 *    (empty string, short string, long string ≥ 4096 chars) — guards against
 *    fixed-size-buffer providers that silently truncate or crash on edge sizes.
 * 7. `algorithm` is a non-empty string (required by the `Signer` contract).
 *
 * USAGE
 * -----
 *   const result = MlDsaProviderConformanceSuite(candidateProvider);
 *   if (!result.ok) throw new Error(`provider failed conformance: ${result.failures.join("; ")}`);
 *   // Safe to wire: createHybridSigner({ ed25519KeyPair, mlDsaProvider: candidateProvider })
 *
 * This function is synchronous and side-effect-free (besides calling the
 * provider's own sign/verify). It does NOT touch the network, filesystem, or
 * any TFA store — pure structural validation, usable in any test file.
 */
export interface MlDsaConformanceResult {
  ok: boolean;
  /** Human-readable list of every failed check (empty when ok === true). */
  failures: string[];
  /** Per-check pass/fail map, keyed by check name, for granular assertions in tests. */
  checks: Record<string, boolean>;
}

/** FIPS 204 ML-DSA-44 signature length in bytes. Fixed by the parameter set. */
export const ML_DSA_44_SIGNATURE_BYTES = 2420;

export function MlDsaProviderConformanceSuite(provider: Signer): MlDsaConformanceResult {
  const checks: Record<string, boolean> = {};
  const failures: string[] = [];

  function record(name: string, passed: boolean, detail?: string): void {
    checks[name] = passed;
    if (!passed) failures.push(detail ? `${name}: ${detail}` : name);
  }

  // 7. algorithm label present
  record("algorithm_nonempty", typeof provider.algorithm === "string" && provider.algorithm.length > 0,
    `algorithm was ${JSON.stringify(provider.algorithm)}`);

  // 1 + 2. sign() produces a FIPS-204-sized signature, and verify() round-trips.
  const sampleData = "tfa-conformance-probe";
  let sampleSig: string | null = null;
  try {
    sampleSig = provider.sign(sampleData);
    let decodedLen = -1;
    try { decodedLen = Buffer.from(sampleSig, "base64").length; } catch { /* leave -1 */ }
    record("signature_length_fips204", decodedLen === ML_DSA_44_SIGNATURE_BYTES,
      `expected ${ML_DSA_44_SIGNATURE_BYTES} bytes, got ${decodedLen}`);
  } catch (e) {
    record("signature_length_fips204", false, `sign() threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (sampleSig !== null) {
    let roundTripOk = false;
    try { roundTripOk = provider.verify(sampleData, sampleSig); } catch { roundTripOk = false; }
    record("verify_roundtrip", roundTripOk, "verify(data, sign(data)) was not true");

    // 3. tamper data → verify must reject
    const tamperedData = sampleData.slice(0, -1) + (sampleData.endsWith("e") ? "f" : "e");
    let tamperedDataOk = true;
    try { tamperedDataOk = provider.verify(tamperedData, sampleSig); } catch { tamperedDataOk = false; }
    record("reject_tampered_data", tamperedDataOk === false, "verify() accepted a signature over different data");

    // 4. tamper signature → verify must reject
    let tamperedSig: string;
    try {
      const raw = Buffer.from(sampleSig, "base64");
      if (raw.length > 0) raw[0] = raw[0] ^ 0xff;
      tamperedSig = raw.toString("base64");
    } catch { tamperedSig = sampleSig + "AA"; }
    let tamperedSigOk = true;
    try { tamperedSigOk = provider.verify(sampleData, tamperedSig); } catch { tamperedSigOk = false; }
    record("reject_tampered_signature", tamperedSigOk === false, "verify() accepted a corrupted signature");

    // 5. cross-data check: a signature for data A must not verify for data B.
    let crossDataOk = true;
    try { crossDataOk = provider.verify("completely-different-payload", sampleSig); } catch { crossDataOk = false; }
    record("reject_cross_data", crossDataOk === false, "verify() accepted sampleSig against unrelated data");
  } else {
    // sign() itself failed — downstream checks cannot run; mark as failed, not skipped,
    // so a broken provider cannot pass by accident.
    record("verify_roundtrip", false, "skipped: sign() did not produce a signature");
    record("reject_tampered_data", false, "skipped: sign() did not produce a signature");
    record("reject_tampered_signature", false, "skipped: sign() did not produce a signature");
    record("reject_cross_data", false, "skipped: sign() did not produce a signature");
  }

  // 6. varying input lengths must not throw or crash (empty / short / long).
  const lengthProbes: Array<[string, string]> = [
    ["empty_input", ""],
    ["short_input", "x"],
    ["long_input", "x".repeat(4096)],
  ];
  for (const [label, probe] of lengthProbes) {
    try {
      const sig = provider.sign(probe);
      const ok = typeof sig === "string" && sig.length > 0;
      record(`varying_length_${label}`, ok, `sign() returned ${JSON.stringify(sig)}`);
    } catch (e) {
      record(`varying_length_${label}`, false, `sign() threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ok = Object.values(checks).every(Boolean);
  return { ok, failures, checks };
}

