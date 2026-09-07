/**
 * lib/escrow/http-webhook-relayer.ts — HttpWebhookRelayer: production HTTP delivery adapter.
 *
 * PURPOSE
 * -------
 * Sends signed webhook payloads to registered endpoints with:
 *   • Retry logic: up to maxRetries attempts (default: 3).
 *   • Exponential backoff: baseDelayMs * 2^attempt, with jitter (±10%).
 *   • Timeout: each HTTP request times out after requestTimeoutMs (default: 10s).
 *   • Fail-closed on any non-2xx response or network error; last error recorded.
 *
 * DESIGN
 * ------
 * Implements WebhookRelayer interface — a pure adapter. No side-effects beyond
 * outbound HTTP. Delivery errors are returned (not thrown) — callers decide if
 * failures abort their flow. WebhookService.dispatch() swallows them already.
 *
 * Retry policy:
 *   • Attempt 1: immediate.
 *   • Attempt 2: baseDelayMs * 1 * jitter.
 *   • Attempt 3: baseDelayMs * 2 * jitter.
 *   • Attempt N: baseDelayMs * 2^(N-2) * jitter (capped at maxDelayMs).
 *
 * The relayer uses the global fetch() API (Node 18+, available in Node 22).
 * AbortController is used for timeout enforcement.
 *
 * Zero external dependencies — node:crypto for jitter seed, built-in fetch.
 */

import type { WebhookRelayer, WebhookDelivery, DeliveryResult } from "./webhook";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface HttpWebhookRelayerConfig {
  /** Maximum retry attempts (including the first). Default: 3. */
  maxRetries?: number;
  /** Initial backoff in ms before the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum backoff cap in ms. Default: 30_000 (30 seconds). */
  maxDelayMs?: number;
  /** Per-request HTTP timeout in ms. Default: 10_000 (10 seconds). */
  requestTimeoutMs?: number;
  /** Jitter fraction ±. Default: 0.1 (±10%). */
  jitterFraction?: number;
}

const DEFAULTS: Required<HttpWebhookRelayerConfig> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  requestTimeoutMs: 10_000,
  jitterFraction: 0.1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute backoff delay for a given attempt index (0-based).
 * attempt=0 → 0ms (first try is immediate).
 * attempt=1 → baseDelayMs * jitter.
 * attempt=2 → baseDelayMs * 2 * jitter.
 * etc., capped at maxDelayMs.
 */
function backoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFraction: number,
): number {
  if (attempt === 0) return 0;
  const exp = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFraction;
  return Math.min(Math.round(exp * jitter), maxDelayMs);
}

/** Returns true if the HTTP status code is considered a success (2xx). */
function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

// ─── HttpWebhookRelayer ───────────────────────────────────────────────────────

export class HttpWebhookRelayer implements WebhookRelayer {
  private readonly cfg: Required<HttpWebhookRelayerConfig>;

  constructor(config: HttpWebhookRelayerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  async deliver(delivery: WebhookDelivery): Promise<DeliveryResult> {
    const { maxRetries, baseDelayMs, maxDelayMs, requestTimeoutMs, jitterFraction } = this.cfg;
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delay = backoffMs(attempt, baseDelayMs, maxDelayMs, jitterFraction);
      if (delay > 0) await sleep(delay);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const response = await fetch(delivery.url, {
          method: "POST",
          headers: delivery.headers,
          body: delivery.payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatusCode = response.status;

        if (is2xx(response.status)) {
          return { ok: true, statusCode: response.status };
        }

        // Non-2xx: retry on 5xx; do not retry on 4xx (client errors are permanent)
        lastError = `HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          // Permanent client error — no point retrying
          return { ok: false, statusCode: response.status, error: lastError };
        }
        // 5xx: continue retrying
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          lastError = `timeout after ${requestTimeoutMs}ms`;
        } else {
          lastError = err instanceof Error ? err.message : String(err);
        }
        // Network errors are retriable
      }
    }

    return {
      ok: false,
      statusCode: lastStatusCode,
      error: lastError ?? "unknown error",
    };
  }
}
