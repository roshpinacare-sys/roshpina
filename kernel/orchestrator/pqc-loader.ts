/**
 * lib/orchestrator/pqc-loader.ts — PQC Provider Dynamic Loader
 *
 * PURPOSE
 * -------
 * Attempts to load a real ML-DSA-44 provider from externally-installed modules
 * (OQS npm bindings, WebAssembly, or future Node.js native crypto). When no real
 * provider is available — the common case in zero-dep sandboxes and fresh
 * installs — falls back to `MlDsaLocalProvider` (built-in simulation) and
 * finally to `MlDsaDeterministicProvider` so the hybrid signer pipeline
 * remains functional end-to-end.
 *
 * DESIGN
 * ------
 * • `tryLoadOqsModule()`  — dynamic-import of `@open-quantum-safe/liboqs`.
 * • `tryLoadWasmModule()` — dynamic-import of known WASM / pure-JS ML-DSA pkgs.
 * • `tryLoadLocalProvider()` — built-in zero-dep local simulation (v309).
 * • `resolveHybridMlDsaProvider()` — ordered resolution:
 *     1. Explicit `provider` option (caller-supplied) wins unconditionally.
 *     2. Real compiled providers: OQS → WASM (discovered via dynamic import).
 *     3. Built-in local provider (zero-dep, full adapter path, labeled "-sim").
 *     4. Last-resort deterministic fallback with a stable derived secret.
 *
 * All dynamic imports are wrapped in try/catch. A missing module is NOT an
 * error — it is the expected path in sandbox / dev / until ops installs the
 * real native dependency.
 *
 * SECURITY
 * --------
 * The local / deterministic fallbacks are clearly labeled simulation
 * (algorithm string includes "-sim"). They must NEVER be presented as
 * post-quantum secure in production. Ops monitoring should alert when
 * `algorithm` ends with "-sim", prompting the operator to `npm install`
 * a real compiled provider.
 */

import { randomBytes } from "node:crypto";
import { MlDsaDeterministicProvider } from "./signer.ts";
import { adaptPqcProvider } from "./pqc-adapter.ts";
import { MlDsaLocalProvider } from "./pqc-local-provider.ts";
import { wrapCompiledModule } from "./pqc-compiled-provider.ts";
import type { Signer } from "./types.ts";
import type { Uint8ArraySigner } from "./pqc-adapter.ts";

// ─── Known module names (priority order) ────────────────────────────────────

const OQS_MODULE_NAMES = [
  "@open-quantum-safe/liboqs",
  "liboqs-js",
] as const;

const WASM_MODULE_NAMES = [
  "ml-dsa",
  "@noble/post-quantum",
  "pqcrypto",
] as const;

// ─── Module probing ─────────────────────────────────────────────────────────

/**
 * Load the built-in local ML-DSA provider.
 *
 * This provider lives in the repository (zero external deps) and implements
 * the same `Uint8ArraySigner` interface a real OQS/WASM module would expose.
 * When present it is preferred over the deterministic fallback so the hybrid
 * pipeline exercises the full adapter path.
 */
export async function tryLoadLocalProvider(
  opts?: { secret?: string | Buffer },
): Promise<Uint8ArraySigner | undefined> {
  // The local provider is always available in the repo; we simply instantiate it.
  // Async signature matches the other tryLoad* helpers for uniform resolution.
  try {
    return new MlDsaLocalProvider(opts);
  } catch {
    return undefined;
  }
}

/**
 * Synchronous variant of `tryLoadLocalProvider` for boot paths that cannot await.
 */
export function tryLoadLocalProviderSync(
  opts?: { secret?: string | Buffer },
): Uint8ArraySigner | undefined {
  try {
    return new MlDsaLocalProvider(opts);
  } catch {
    return undefined;
  }
}

/**
 * Attempt to load an OQS-style npm module.
 *
 * Uses `wrapCompiledModule` so that real OQS bindings (class-based) as well
 * as naive Uint8ArraySigner exports are detected and wrapped correctly.
 * Returns `undefined` if the module is not installed or does not conform.
 */
export async function tryLoadOqsModule(): Promise<Uint8ArraySigner | undefined> {
  for (const name of OQS_MODULE_NAMES) {
    try {
      const mod = await import(name) as any;
      const target = mod.default ?? mod;
      const wrapped = wrapCompiledModule(target);
      if (wrapped) return wrapped;
    } catch {
      // Module not installed — expected, not an error.
    }
  }
  return undefined;
}

/**
 * Attempt to load a WASM / pure-JS ML-DSA module.
 *
 * Uses `wrapCompiledModule` so that real ml-dsa / @noble/post-quantum
 * packages (which expose keyGen + sign(msg,sk) + verify(sig,msg,pk))
 * are properly wrapped into `Uint8ArraySigner` before the adapter path.
 */
export async function tryLoadWasmModule(): Promise<Uint8ArraySigner | undefined> {
  for (const name of WASM_MODULE_NAMES) {
    try {
      const mod = await import(name) as any;
      const target = mod.default ?? mod;
      const wrapped = wrapCompiledModule(target);
      if (wrapped) return wrapped;
    } catch {
      // Module not installed — expected, not an error.
    }
  }
  return undefined;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface ResolveHybridOptions {
  /** Caller-supplied provider wins over everything else. */
  provider?: Uint8ArraySigner | Signer;
  /**
   * Secret seed for the deterministic fallback.
   * If omitted, a random 32-byte secret is generated (not stable across restarts).
   * In production, inject a stable secret so deterministic signatures are
   * reproducible for the same key lifecycle.
   */
  deterministicSecret?: string | Buffer;
}

/**
 * Resolve the best available ML-DSA-44 provider for hybrid signing.
 *
 * Resolution order:
 *   1. Explicit `opts.provider` (Uint8ArraySigner or full Signer).
 *   2. Real compiled OQS module via `tryLoadOqsModule()`.
 *   3. Real compiled WASM module via `tryLoadWasmModule()`.
 *   4. Built-in local provider via `tryLoadLocalProvider()` (labeled "-sim").
 *   5. `MlDsaDeterministicProvider` with `opts.deterministicSecret`.
 *
 * This function is async because dynamic imports are async. Call it once
 * during composition boot and await the result before creating the stack.
 */
export async function resolveHybridMlDsaProvider(
  opts: ResolveHybridOptions = {},
): Promise<Signer> {
  // 1. Explicit provider wins.
  if (opts.provider) {
    const raw = opts.provider;
    // If it already looks like a Signer, use it directly.
    if (
      typeof (raw as any).algorithm === "string" &&
      typeof (raw as any).sign === "function" &&
      typeof (raw as any).verify === "function"
    ) {
      return raw as Signer;
    }
    // Otherwise adapt from Uint8ArraySigner.
    return adaptPqcProvider(raw as Uint8ArraySigner);
  }

  // 2. Real compiled providers (OQS → WASM).
  const oqs = await tryLoadOqsModule();
  if (oqs) return adaptPqcProvider(oqs);

  const wasm = await tryLoadWasmModule();
  if (wasm) return adaptPqcProvider(wasm);

  // 3. Built-in local provider (zero-dep, full adapter path).
  // If caller passed deterministicSecret, wire it into the local provider
  // so signatures remain stable across restarts (same contract as before).
  const local = await tryLoadLocalProvider(
    opts.deterministicSecret ? { secret: opts.deterministicSecret } : undefined,
  );
  if (local) {
    const adapted = adaptPqcProvider(local);
    // Override algorithm to clearly label this as the built-in local simulation,
    // not a real compiled OQS/WASM module. Ops monitoring can alert on "-sim".
    return { ...adapted, algorithm: "ml-dsa-44-local-sim" };
  }

  // 4. Last-resort deterministic fallback — zero-dep, functional, clearly labeled.
  // CSPRNG (not Math.random()): this becomes the signing key, so it needs
  // real entropy even though it is never stable across restarts.
  const secret = opts.deterministicSecret ?? randomBytes(32);
  return new MlDsaDeterministicProvider(secret);
}

/**
 * Synchronous variant of `resolveHybridMlDsaProvider` for contexts where
 * async boot is not possible (e.g. some test harnesses).
 *
 * Skips real-module probing (dynamic import requires await) because compiled
 * providers cannot be safely loaded without async boot. Resolution order:
 *   1. Explicit `opts.provider`.
 *   2. Built-in local provider (sync path).
 *   3. Last-resort deterministic fallback.
 */
export function resolveHybridMlDsaProviderSync(
  opts: Omit<ResolveHybridOptions, "provider"> & { provider?: Signer } = {},
): Signer {
  if (opts.provider) {
    return opts.provider;
  }

  // 2. Built-in local provider (sync path).
  const local = tryLoadLocalProviderSync(
    opts.deterministicSecret ? { secret: opts.deterministicSecret } : undefined,
  );
  if (local) {
    const adapted = adaptPqcProvider(local);
    return { ...adapted, algorithm: "ml-dsa-44-local-sim" };
  }

  // 3. Last-resort deterministic fallback.
  // CSPRNG (not Math.random()): this becomes the signing key, so it needs
  // real entropy even though it is never stable across restarts.
  const secret = opts.deterministicSecret ?? randomBytes(32);
  return new MlDsaDeterministicProvider(secret);
}
