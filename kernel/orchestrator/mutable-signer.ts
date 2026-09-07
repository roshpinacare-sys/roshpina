/**
 * lib/orchestrator/mutable-signer.ts — MutableSigner: thread-safe delegating wrapper.
 *
 * PURPOSE
 * -------
 * Enables live key rotation without restarting the process or rebuilding the stack.
 * Every component (auditStore, orchestrator, policies, sovereignty routes) holds
 * a reference to a single MutableSigner instance. When the key is rotated,
 * the inner signer is replaced atomically — all callers immediately use the new key.
 *
 * DESIGN
 * ------
 *   • Wraps any Signer implementation (HmacSigner or Ed25519Signer).
 *   • `rotate(newSigner)` atomically replaces the inner delegate.
 *   • `algorithm` reflects the current inner signer's algorithm.
 *   • No locking needed: JS is single-threaded; assignment is atomic.
 *   • The `rotatedAt` timestamp and `rotationCount` support audit trail.
 *
 * SECURITY NOTE
 * -------------
 * After rotation, bundles signed with the OLD key will no longer verify against
 * the new signer. Callers responsible for long-lived signatures (export bundles,
 * passports) must re-sign after rotation — or retain the old signer for
 * verification of pre-rotation artifacts (out of scope for this primitive).
 *
 * Rotation is idempotent if the same signer instance is passed twice — it
 * still records a rotation event (callers are responsible for deduplication).
 */

import type { Signer } from "./types.ts";

// ─── Rotation event ───────────────────────────────────────────────────────────

export interface KeyRotationEvent {
  /** Rotation sequence number (1-based). */
  sequence: number;
  /** ISO 8601 timestamp of when the rotation occurred. */
  rotatedAt: string;
  /** Algorithm of the new signer post-rotation. */
  newAlgorithm: string;
}

// ─── MutableSigner ────────────────────────────────────────────────────────────

export class MutableSigner implements Signer {
  private inner: Signer;
  private _rotationCount = 0;
  private _lastRotatedAt: string | null = null;
  private readonly _rotationLog: KeyRotationEvent[] = [];

  constructor(initial: Signer) {
    if (!initial || typeof initial.sign !== "function" || typeof initial.verify !== "function") {
      throw new MutableSignerError("INVALID_SIGNER", "initial signer must implement Signer interface");
    }
    this.inner = initial;
  }

  // ─── Signer interface ───────────────────────────────────────────────────────

  get algorithm(): string {
    return this.inner.algorithm;
  }

  sign(data: string): string {
    return this.inner.sign(data);
  }

  verify(data: string, signature: string): boolean {
    return this.inner.verify(data, signature);
  }

  // ─── Rotation ───────────────────────────────────────────────────────────────

  /**
   * Atomically replace the inner signer with `newSigner`.
   *
   * Returns the rotation event for audit logging.
   * Throws MutableSignerError if `newSigner` is invalid.
   */
  rotate(newSigner: Signer): KeyRotationEvent {
    if (!newSigner || typeof newSigner.sign !== "function" || typeof newSigner.verify !== "function") {
      throw new MutableSignerError("INVALID_SIGNER", "new signer must implement Signer interface");
    }
    this._rotationCount += 1;
    this._lastRotatedAt = new Date().toISOString();
    const event: KeyRotationEvent = {
      sequence: this._rotationCount,
      rotatedAt: this._lastRotatedAt,
      newAlgorithm: newSigner.algorithm,
    };
    this._rotationLog.push(event);
    // Atomic assignment (JS single-threaded)
    this.inner = newSigner;
    return event;
  }

  // ─── Introspection ──────────────────────────────────────────────────────────

  /** Number of rotations since this instance was created. */
  get rotationCount(): number { return this._rotationCount; }

  /** ISO 8601 timestamp of last rotation, or null if never rotated. */
  get lastRotatedAt(): string | null { return this._lastRotatedAt; }

  /** Ordered log of all rotation events (most recent last). */
  get rotationLog(): readonly KeyRotationEvent[] { return this._rotationLog; }

  /** Access the current inner signer (read-only). */
  get currentSigner(): Signer { return this.inner; }
}

// ─── Error ────────────────────────────────────────────────────────────────────

export type MutableSignerErrorCode = "INVALID_SIGNER";

export class MutableSignerError extends Error {
  readonly code: MutableSignerErrorCode;
  constructor(code: MutableSignerErrorCode, message: string) {
    super(message);
    this.name = "MutableSignerError";
    this.code = code;
  }
}
