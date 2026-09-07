/**
 * lib/orchestrator/retry-policy.ts — exponential-backoff retry policy.
 *
 * Continuation of MANIFEST "החסר הבא" #2 (Durable ExecutionWorkflow): the first
 * sub-step of retry handling. A `running` workflow can transition to `failed`;
 * a supervisor then decides whether and when to re-lease and re-run it. This
 * module is the pure, deterministic decision core for that supervisor.
 *
 * DESIGN
 * ------
 * • PURE: no I/O, no store mutation, no wall-clock reads. Given (attempts, config)
 *   it returns a plan. The supervisor owns scheduling and re-leasing.
 * • DETERMINISTIC by default: jitter is 0 unless asked for, and when used it draws
 *   from an INJECTABLE rng so tests are reproducible.
 * • FAIL-CLOSED: any invalid config or attempt count throws ExecutionError
 *   ("invalid_retry_config") — never a silent "retry forever" or "delay 0".
 * • CONNECTED to the domain: `countFailures` / `planRetryForWorkflow` operate on
 *   an ExecutionWorkflow's tamper-evident run-log, so the attempt count is derived
 *   from real history rather than a mutable counter (no schema change needed).
 *
 * Zero external dependencies.
 */

import { ExecutionError } from "./execution-workflow.ts";
import type { ExecutionWorkflow } from "./types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * RetryPolicyConfig — governance-as-data for backoff.
 *   maxAttempts  total attempts allowed (the initial run counts as attempt 0 of
 *                failures; `maxAttempts` caps how many RETRIES may follow).
 *   baseDelayMs  delay before the 1st retry (attempt 1).
 *   multiplier   growth factor per attempt (>= 1). Default 2 (classic doubling).
 *   maxDelayMs   hard cap on any single delay (>= baseDelayMs).
 *   jitter       fraction in [0,1]; 0 = deterministic. When > 0 the delay is
 *                scaled by (1 - jitter + rng()*2*jitter), i.e. ± jitter around 1.
 */
export interface RetryPolicyConfig {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier?: number;
  maxDelayMs?: number;
  jitter?: number;
}

/** Sensible default: up to 5 retries, 1s → 2s → 4s → 8s → 16s, capped at 60s, no jitter. */
export const DEFAULT_RETRY_POLICY: Readonly<Required<RetryPolicyConfig>> = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
  jitter: 0,
};

/** A single retry decision. */
export interface RetryPlan {
  /** Whether another attempt is permitted. */
  retry: boolean;
  /** The 1-based attempt number this plan describes (attemptsSoFar + 1). */
  attempt: number;
  /** Milliseconds to wait before this attempt. 0 when retry === false. */
  delayMs: number;
}

// ─── Validation (fail-closed) ──────────────────────────────────────────────────

function resolve(config: RetryPolicyConfig): Required<RetryPolicyConfig> {
  const c = {
    maxAttempts: config.maxAttempts,
    baseDelayMs: config.baseDelayMs,
    multiplier: config.multiplier ?? DEFAULT_RETRY_POLICY.multiplier,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    jitter: config.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
  const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
  const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!isInt(c.maxAttempts) || c.maxAttempts < 1) {
    throw new ExecutionError("invalid_retry_config", "maxAttempts must be an integer >= 1");
  }
  if (!isNum(c.baseDelayMs) || c.baseDelayMs <= 0) {
    throw new ExecutionError("invalid_retry_config", "baseDelayMs must be a positive number");
  }
  if (!isNum(c.multiplier) || c.multiplier < 1) {
    throw new ExecutionError("invalid_retry_config", "multiplier must be a number >= 1");
  }
  if (!isNum(c.maxDelayMs) || c.maxDelayMs < c.baseDelayMs) {
    throw new ExecutionError("invalid_retry_config", "maxDelayMs must be a number >= baseDelayMs");
  }
  if (!isNum(c.jitter) || c.jitter < 0 || c.jitter > 1) {
    throw new ExecutionError("invalid_retry_config", "jitter must be a number in [0, 1]");
  }
  return c;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * computeBackoffMs — the delay (ms) before retry attempt N (1-based), capped.
 * Deterministic when jitter === 0. With jitter, draws from `rng` (default 0.5,
 * the neutral midpoint — i.e. no shift — so omitting rng stays deterministic).
 */
export function computeBackoffMs(
  attempt: number,
  config: RetryPolicyConfig,
  rng: () => number = () => 0.5,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new ExecutionError("invalid_retry_config", "attempt must be an integer >= 1");
  }
  const c = resolve(config);
  const raw = c.baseDelayMs * Math.pow(c.multiplier, attempt - 1);
  let delay = Math.min(raw, c.maxDelayMs);
  if (c.jitter > 0) {
    const r = rng();
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r > 1) {
      throw new ExecutionError("invalid_retry_config", "rng must return a number in [0, 1]");
    }
    const scale = 1 - c.jitter + r * 2 * c.jitter;
    delay = Math.min(delay * scale, c.maxDelayMs);
  }
  return Math.round(delay);
}

/** Whether another retry is permitted given how many attempts already failed. */
export function shouldRetry(attemptsSoFar: number, config: RetryPolicyConfig): boolean {
  if (!Number.isInteger(attemptsSoFar) || attemptsSoFar < 0) {
    throw new ExecutionError("invalid_retry_config", "attemptsSoFar must be an integer >= 0");
  }
  const c = resolve(config);
  return attemptsSoFar < c.maxAttempts;
}

/**
 * nextRetry — the full decision: should we retry, and if so after how long?
 * `attemptsSoFar` is the count of failures already observed (0 on first failure).
 */
export function nextRetry(
  attemptsSoFar: number,
  config: RetryPolicyConfig,
  rng: () => number = () => 0.5,
): RetryPlan {
  const retry = shouldRetry(attemptsSoFar, config);
  const attempt = attemptsSoFar + 1;
  if (!retry) return { retry: false, attempt, delayMs: 0 };
  return { retry: true, attempt, delayMs: computeBackoffMs(attempt, config, rng) };
}

// ─── Domain glue ──────────────────────────────────────────────────────────────

/** Count how many times this workflow has transitioned INTO "failed". */
export function countFailures(wf: ExecutionWorkflow): number {
  let n = 0;
  for (const entry of wf.runLog) {
    if (entry.toStatus === "failed") n++;
  }
  return n;
}

/**
 * planRetryForWorkflow — derive a RetryPlan from a workflow's real history.
 * The workflow MUST currently be in "failed" status (fail-closed: retrying a
 * non-failed workflow is a programming error and is rejected). The attempt count
 * comes from the tamper-evident run-log, not a mutable field.
 */
export function planRetryForWorkflow(
  wf: ExecutionWorkflow,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  rng: () => number = () => 0.5,
): RetryPlan {
  if (wf.status !== "failed") {
    throw new ExecutionError(
      "invalid_retry_config",
      `retry only applies to a failed workflow (status is "${wf.status}")`,
    );
  }
  const failures = countFailures(wf);
  // attemptsSoFar = failures - 1, because the current failure is the one we are
  // reacting to; clamp at 0 so the first failure yields attempt 1.
  const attemptsSoFar = Math.max(0, failures - 1);
  return nextRetry(attemptsSoFar, config, rng);
}
