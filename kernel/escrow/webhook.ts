/**
 * lib/escrow/webhook.ts — HMAC-signed webhooks per tenant (Settlement #3).
 *
 * Design:
 *   • Each tenant registers ≥1 webhook endpoints (url + events + secret).
 *   • When a settlement state changes, WebhookService.dispatch() is called.
 *   • Dispatch routes every emission through the ShareGate (K2, v144): the gate
 *     re-checks the destination, REDACTS credential-bearing values, signs the
 *     REDACTED bytes (one HMAC truth: webhook-crypto.ts) and hands the delivery
 *     to the injected WebhookRelayer — a dumb transport BEHIND the gate.
 *   • Consumers verify the signature offline: sha256=<base64-HMAC-SHA256(secret, redactedPayload)>.
 *   • The relayer is an injectable adapter: InMemoryWebhookRelayer (tests/dev),
 *     HttpWebhookRelayer (production). Never inline HTTP calls; never construct
 *     a WebhookService that can reach the relayer without its gate (the
 *     constructor installs a default ShareGate when none is passed — I27 has
 *     no off switch).
 *
 * Invariants:
 *   • Tenant isolation: registrations scoped by tenantId; cross-tenant = null/empty.
 *   • fail-closed on missing tenantId, empty url, or empty secret.
 *   • K2 destination law: register refuses non-HTTPS/internal/metadata/private
 *     destinations (share_gate_refused) and dispatch re-checks EVERY emission —
 *     tampered/stale store rows cannot smuggle a destination in.
 *   • K2 payload law: outbound payloads are redacted (credential families →
 *     "[REDACTED]", depth-capped) BEFORE signing — receivers verify the exact
 *     bytes that left; the applied redaction-set lands in the delivery log.
 *   • BigInt amounts in event payloads serialized as strings.
 *   • K3 seal law (v145): the store NEVER sees plaintext — register seals at the
 *     door (AES-256-GCM under a deployment-held key, webhook-secrets.ts), the
 *     plaintext is returned to the caller EXACTLY ONCE (WebhookRegistrationCreated),
 *     every read path lacks the field at the type level (DNA: CdpEvmWalletProvider
 *     exportWallet returns {name,address} only), and dispatch unseals just-in-time
 *     inside the sign frame. Wrong/missing sealer = invalid_config (no off switch).
 *   • K3 breaker law (v145): a registration with N consecutive failed deliveries
 *     OPENS (webhook-breaker.ts); while open, dispatch refuses WITHOUT touching
 *     the gate or the transport, and writes the refusal into the delivery log —
 *     never silent. After the cooldown: one half-open probe; success closes,
 *     failure re-opens with a fresh cooldown.
 *   • Dispatch errors are swallowed — a failed delivery must not abort the settlement.
 *   • Signature header: x-tfa-signature: sha256=<base64>
 *   • Event timestamp: x-tfa-event and x-tfa-timestamp headers on every delivery.
 */

import { randomUUID } from "node:crypto";
import { ShareGate } from "./share-gate";
import { signPayload as hmacSign, verifySignature as hmacVerify } from "./webhook-crypto";
import type { ShareGateReceipt } from "./share-gate";
import { secretFingerprint, type SecretSealer, type SealedSecret } from "./webhook-secrets";
import { ConsecutiveFailuresBreaker, type BreakerOptions } from "./webhook-breaker";

// ─── Event types ──────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  "settlement.funded",
  "settlement.partially_released",
  "settlement.released",
  "settlement.disputed",
  "settlement.reversed",
  "settlement.created",
  "escrow.created",
  "escrow.funded",
  "escrow.released",
  "escrow.refunded",
  "escrow.disputed",
  "escrow.undisputed",
  "passport.issued",
  "dispute.opened",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEvent {
  id: string;
  event: WebhookEventType | string;
  tenantId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface WebhookRegistration {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  /** K3: the secret SEALED at rest — the store never sees plaintext. */
  secretSealed: SealedSecret;
  /** K3: non-reversible ops identifier (sha256 prefix) — the only secret-ish thing read paths expose. */
  secretFingerprint: string;
  createdAt: string;
  active: boolean;
}

/**
 * K3: the return of register() — the ONE time the plaintext secret leaves the
 * kernel. The caller keeps it (offline signature verification); the kernel
 * never hands it back again (get/list return WebhookRegistration, which lacks
 * the field at the type level).
 */
export type WebhookRegistrationCreated = WebhookRegistration & { secret: string };

export interface CreateWebhookInput {
  tenantId: string;
  url: string;
  events: string[];
  /** Optional caller-supplied secret. Defaults to a random 32-byte hex string. */
  secret?: string;
}

export class WebhookError extends Error {
  code: "invalid_input" | "invalid_config" | "not_found" | "tenant_mismatch";
  constructor(code: "invalid_input" | "invalid_config" | "not_found" | "tenant_mismatch", message: string) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export interface WebhookStore {
  put(reg: WebhookRegistration): Promise<void>;
  get(tenantId: string, id: string): Promise<WebhookRegistration | null>;
  list(tenantId: string): Promise<WebhookRegistration[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export class InMemoryWebhookStore implements WebhookStore {
  private readonly map = new Map<string, Map<string, WebhookRegistration>>();

  private tenant(id: string): Map<string, WebhookRegistration> {
    let m = this.map.get(id);
    if (!m) { m = new Map(); this.map.set(id, m); }
    return m;
  }

  async put(reg: WebhookRegistration): Promise<void> {
    this.tenant(reg.tenantId).set(reg.id, reg);
  }

  async get(tenantId: string, id: string): Promise<WebhookRegistration | null> {
    return this.tenant(tenantId).get(id) ?? null;
  }

  async list(tenantId: string): Promise<WebhookRegistration[]> {
    return [...this.tenant(tenantId).values()];
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.tenant(tenantId).delete(id);
  }
}

// ─── Relayer ──────────────────────────────────────────────────────────────────

export interface WebhookDelivery {
  registrationId: string;
  url: string;
  payload: string;
  signature: string;
  headers: Record<string, string>;
  tenantId: string;
  event: string;
}

export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookRelayer {
  deliver(delivery: WebhookDelivery): Promise<DeliveryResult>;
}

/**
 * InMemoryWebhookRelayer — captures all deliveries in memory for test assertion.
 * Never sends network traffic. Always succeeds (ok: true) unless `failNextN` is set.
 */
export class InMemoryWebhookRelayer implements WebhookRelayer {
  readonly deliveries: Array<{ delivery: WebhookDelivery; result: DeliveryResult }> = [];
  private failNext = 0;

  /** Force the next N deliveries to fail (for testing error paths). */
  setFailNext(n: number): void { this.failNext = n; }

  async deliver(delivery: WebhookDelivery): Promise<DeliveryResult> {
    let result: DeliveryResult;
    if (this.failNext > 0) {
      this.failNext--;
      result = { ok: false, error: "simulated delivery failure" };
    } else {
      result = { ok: true, statusCode: 200 };
    }
    this.deliveries.push({ delivery, result });
    return result;
  }
}

// ─── Delivery log (resilience: outcomes are recorded, never silently lost) ────

export interface WebhookDeliveryRecord {
  id: string;
  tenantId: string;
  registrationId: string;
  event: string;
  occurredAt: string;
  attemptedAt: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  /** K3 breaker receipt — present when dispatch was refused by an OPEN breaker (v145+). */
  breaker?: { state: "open"; since: string; consecutiveFailures: number };
  /** K2 share-gate receipt — present on every gate-evaluated emission (v144+). */
  gate?: ShareGateReceipt;
}

export interface WebhookDeliveryLog {
  record(rec: WebhookDeliveryRecord): Promise<void>;
  list(tenantId: string, registrationId?: string, limit?: number): Promise<WebhookDeliveryRecord[]>;
}

/** Default cap on stored records per tenant — bounded memory, ring-buffer drop of oldest. */
export const DEFAULT_DELIVERY_LOG_CAP = 500;

/**
 * InMemoryWebhookDeliveryLog — captures delivery outcomes (success and failure) so a
 * relayer giving up after retries is observable instead of silently dropped.
 * Bounded per tenant (oldest dropped first) — no unbounded growth under sustained failures.
 */
export class InMemoryWebhookDeliveryLog implements WebhookDeliveryLog {
  private readonly map = new Map<string, WebhookDeliveryRecord[]>();
  private readonly capPerTenant: number;

  constructor(capPerTenant: number = DEFAULT_DELIVERY_LOG_CAP) {
    this.capPerTenant = capPerTenant > 0 ? capPerTenant : DEFAULT_DELIVERY_LOG_CAP;
  }

  async record(rec: WebhookDeliveryRecord): Promise<void> {
    if (!rec?.tenantId) return; // fail-closed: never store a record with no tenant scope
    let arr = this.map.get(rec.tenantId);
    if (!arr) { arr = []; this.map.set(rec.tenantId, arr); }
    arr.push(rec);
    if (arr.length > this.capPerTenant) arr.shift(); // bounded — oldest first out
  }

  async list(tenantId: string, registrationId?: string, limit = 50): Promise<WebhookDeliveryRecord[]> {
    if (!tenantId) return [];
    const arr = this.map.get(tenantId) ?? [];
    const filtered = registrationId ? arr.filter((r) => r.registrationId === registrationId) : arr;
    return filtered.slice(-limit).reverse(); // newest first
  }
}

// ─── WebhookService ───────────────────────────────────────────────────────────

export class WebhookService {
  private readonly store: WebhookStore;
  private readonly relayer: WebhookRelayer;
  private readonly deliveryLog: WebhookDeliveryLog;
  /** K2: the ONLY path from (registration, event) to the transport. Always present. */
  readonly gate: ShareGate;

  constructor(
    store: WebhookStore,
    relayer: WebhookRelayer,
    deliveryLog: WebhookDeliveryLog = new InMemoryWebhookDeliveryLog(),
    gate?: ShareGate,
    opts?: { sealer: SecretSealer; breaker?: BreakerOptions },
  ) {
    if (!opts?.sealer) {
      // K3 has no off switch: a service that stores plaintext secrets is the
      // disease this law exists to kill — refuse construction, never fall back.
      throw new WebhookError("invalid_config", "sealer required — a WebhookService that stores plaintext secrets is not constructible (K3, no off switch)");
    }
    this.sealer = opts.sealer;
    this.breaker = new ConsecutiveFailuresBreaker(opts.breaker ?? {}); // always on — no off switch
    this.store = store;
    this.relayer = relayer;
    this.deliveryLog = deliveryLog;
    this.gate = gate ?? new ShareGate(relayer); // no gate-less construction — I27 has no off switch
  }

  private readonly sealer: SecretSealer;
  private readonly breaker: ConsecutiveFailuresBreaker;

  /** Register a new webhook endpoint for a tenant (K2: the door — the gate classifies the destination FIRST; K3: the secret is sealed BEFORE the store sees it, and returned to the caller EXACTLY ONCE). */
  async register(input: CreateWebhookInput): Promise<WebhookRegistrationCreated> {
    if (!input?.tenantId) throw new WebhookError("invalid_input", "tenantId required");
    if (!input.url || !input.url.startsWith("http")) {
      throw new WebhookError("invalid_input", "url must be a valid http/https URL");
    }
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new WebhookError("invalid_input", "events must be a non-empty array");
    }
    const dest = await this.gate.checkDestination(input.url);
    if (!dest.ok) {
      throw new WebhookError("invalid_input", `share_gate_refused: ${dest.reasons.join("; ")}`);
    }

    const secret =
      input.secret && input.secret.length >= 16
        ? input.secret
        : randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const secretSealed = this.sealer.seal(secret); // K3: the store boundary sees ciphertext only
    const reg: WebhookRegistration = {
      id: randomUUID(),
      tenantId: input.tenantId,
      url: input.url,
      events: input.events,
      secretSealed,
      secretFingerprint: secretFingerprint(secret),
      createdAt: new Date().toISOString(),
      active: true,
    };
    await this.store.put(reg);
    // K3 the-once-return: plaintext leaves exactly here, never again.
    return { ...reg, secret };
  }

  async get(tenantId: string, id: string): Promise<WebhookRegistration | null> {
    if (!tenantId || !id) return null;
    return this.store.get(tenantId, id);
  }

  async list(tenantId: string): Promise<WebhookRegistration[]> {
    if (!tenantId) return [];
    return this.store.list(tenantId);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!tenantId || !id) return false;
    return this.store.delete(tenantId, id);
  }

  /**
   * Dispatch a webhook event to all active registered endpoints for this tenant + event type.
   * K2 (v144): every per-registration emission routes through this.gate — the gate
   * re-checks the destination (the wire), redacts, signs the redacted bytes, and
   * only then touches the transport. Refusals emit NOTHING and are recorded with
   * their receipt — never silent. Errors are swallowed — a failed delivery must
   * not abort callers.
   */
  async dispatch(tenantId: string, event: WebhookEvent): Promise<void> {
    if (!tenantId || !event?.event) return;
    let regs: WebhookRegistration[];
    try { regs = await this.store.list(tenantId); } catch { return; }

    await Promise.all(
      regs
        .filter((r) => r.active && r.events.includes(event.event))
        .map(async (reg) => {
          const deliveryId = randomUUID();
          // K3 breaker law: consult BEFORE touching the gate or the transport.
          const decision = this.breaker.canAttempt(reg.id);
          if (!decision.allowed) {
            try {
              await this.deliveryLog.record({
                id: deliveryId,
                tenantId,
                registrationId: reg.id,
                event: event.event,
                occurredAt: event.occurredAt,
                attemptedAt: new Date().toISOString(),
                ok: false,
                error: `circuit_breaker_open: ${decision.consecutiveFailures ?? 0} consecutive failures (opened ${decision.since ?? "unknown"})`,
                breaker: { state: "open", since: decision.since ?? "unknown", consecutiveFailures: decision.consecutiveFailures ?? 0 },
              });
            } catch { /* logging must never abort dispatch */ }
            return;
          }

          let result: DeliveryResult;
          let receipt: ShareGateReceipt | undefined;
          // K3 seal law: unseal JUST-IN-TIME — plaintext exists only inside the
          // sign frame (the gate signs the redacted bytes with it, then it dies).
          let plain: string;
          try {
            plain = this.sealer.unseal(reg.secretSealed);
          } catch (err: unknown) {
            // tampered/truncated/wrong-key store row: fail loudly in the log,
            // count it as a failure (fail-closed), emit NOTHING.
            const msg = `secret_unseal_failed: ${err instanceof Error ? err.message : String(err)}`;
            this.breaker.recordFailure(reg.id);
            try {
              await this.deliveryLog.record({
                id: deliveryId,
                tenantId,
                registrationId: reg.id,
                event: event.event,
                occurredAt: event.occurredAt,
                attemptedAt: new Date().toISOString(),
                ok: false,
                error: msg,
              });
            } catch { /* logging must never abort dispatch */ }
            return;
          }
          try {
            const outcome = await this.gate.emit({ reg, secret: plain, event, deliveryId });
            result = outcome.result;
            receipt = outcome.receipt;
          } catch (err: unknown) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          // K3 breaker law: feed the outcome back — consecutive failures trip,
          // any success fully resets.
          if (result.ok) this.breaker.recordSuccess(reg.id);
          else this.breaker.recordFailure(reg.id);
          try {
            await this.deliveryLog.record({
              id: deliveryId,
              tenantId,
              registrationId: reg.id,
              event: event.event,
              occurredAt: event.occurredAt,
              attemptedAt: new Date().toISOString(),
              ok: result.ok,
              statusCode: result.statusCode,
              error: result.error,
              ...(receipt ? { gate: receipt } : {}),
            });
          } catch { /* logging must never abort dispatch */ }
        }),
    );
  }

  /**
   * Read-only audit trail of delivery attempts for a tenant (optionally filtered to
   * one registration). Tenant-scoped — fail-closed (empty tenantId → []).
   */
  async getDeliveryLog(tenantId: string, registrationId?: string, limit?: number): Promise<WebhookDeliveryRecord[]> {
    if (!tenantId) return [];
    return this.deliveryLog.list(tenantId, registrationId, limit);
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /**
   * Sign a payload string with the registration secret using HMAC-SHA256.
   * Returns: "sha256=<base64>" (delegates to the one crypto truth, webhook-crypto.ts).
   */
  static signPayload(secret: string, payload: string): string {
    return hmacSign(secret, payload);
  }

  /**
   * Verify a signature produced by signPayload (timing-safe).
   */
  static verifySignature(secret: string, payload: string, signature: string): boolean {
    return hmacVerify(secret, payload, signature);
  }
}
