/**
 * lib/orchestrator/pqc-local-provider.ts — Local ML-DSA-44 Provider
 *
 * PURPOSE
 * -------
 * A self-contained `Uint8ArraySigner` that lives in the repository and requires
 * zero external npm dependencies. When present it is auto-discovered by
 * `resolveHybridMlDsaProvider` before the deterministic fallback, so the
 * hybrid signer pipeline uses a provider that goes through the full
 * Uint8ArraySigner → adaptPqcProvider → Signer bridge (same path a real
 * OQS/WASM module would take).
 *
 * DESIGN
 * ------
 * • Uses only `node:crypto` (SHAKE256 XOF) — available in Node ≥ 18.
 * • Signatures are exactly 2420 bytes (FIPS 204 ML-DSA-44 size).
 * • Deterministic: same secret + same message → same signature.
 * • verify() recomputes the derivation and compares byte-for-byte.
 *
 * SECURITY NOTICE
 * ---------------
 * This is a *structural simulation*, not a NIST-validated ML-DSA-44
 * implementation. It is safe for integration testing, CI, and sandbox
 * bootstrapping, but production deployments should replace it with a real
 * post-quantum provider (WASM/OQS bindings or future native Node crypto).
 *
 * The algorithm label is `"ml-dsa-44-local-sim"` so ops monitoring can
 * detect when the local fallback is in use and prompt installation of a
 * real compiled provider.
 */

import { createHash, randomBytes } from "node:crypto";
import { ML_DSA_44_SIGNATURE_BYTES } from "./signer.ts";
import type { Uint8ArraySigner } from "./pqc-adapter.ts";

// ─── Local provider implementation ───────────────────────────────────────────

/** Raw options for the local provider. */
export interface MlDsaLocalProviderOptions {
  /** Secret seed; must be ≥ 32 bytes. If omitted a random 32-byte seed is used. */
  secret?: string | Buffer;
}

/** Signer error used by the local provider (kept internal). */
class LocalProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalProviderError";
    this.code = code;
  }
}

/**
 * MlDsaLocalProvider — Uint8Array-based ML-DSA-44 simulation.
 *
 * Implements the same interface a real OQS npm module or WASM export would
 * expose (`sign(msg: Uint8Array): Uint8Array` + `verify(msg, sig): boolean`).
 */
export class MlDsaLocalProvider implements Uint8ArraySigner {
  private readonly secret: Buffer;

  constructor(opts: MlDsaLocalProviderOptions = {}) {
    this.secret = opts.secret
      ? Buffer.isBuffer(opts.secret) ? opts.secret : Buffer.from(opts.secret, "utf8")
      // CSPRNG, not Math.random(): this secret is the signing key for every
      // signature this instance produces, so it needs real entropy even
      // though the algorithm itself is only a structural simulation.
      : randomBytes(32);
    if (this.secret.length < 32) {
      throw new LocalProviderError(
        "SECRET_TOO_SHORT",
        "Local ML-DSA provider secret must be at least 32 bytes",
      );
    }
  }

  sign(msg: Uint8Array): Uint8Array {
    const sig = Buffer.alloc(ML_DSA_44_SIGNATURE_BYTES);
    const seed = createHash("shake256", { outputLength: 64 })
      .update(this.secret)
      .update(msg)
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
    return sig;
  }

  verify(msg: Uint8Array, sig: Uint8Array): boolean {
    try {
      const expected = this.sign(msg);
      if (expected.length !== sig.length) return false;
      // Constant-time comparison is not critical for a simulation, but we
      // keep it simple and correct: every byte must match.
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== sig[i]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Convenience singleton / factory ─────────────────────────────────────────

/**
 * Create a fresh `MlDsaLocalProvider` instance.
 * Callers that need a deterministic provider can pass `secret`.
 */
export function createMlDsaLocalProvider(opts?: MlDsaLocalProviderOptions): MlDsaLocalProvider {
  return new MlDsaLocalProvider(opts);
}

/**
 * Default local provider with a random secret.
 * Suitable for boot-time auto-discovery where stability is not required.
 */
export const defaultLocalProvider: Uint8ArraySigner = new MlDsaLocalProvider();
