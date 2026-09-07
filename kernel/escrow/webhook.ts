/**
 * lib/escrow/webhook.ts — HMAC-signed webhooks per tenant (Settlement #3).
 *
 * Design:
 *   • Each tenant registers ≥1 webhook endpoints (url + events + secret).
 *   • When a settlement state changes, WebhookService.dispatch() is called.
 *   • Dispatch HMAC-SHA256-signs the canonical JSON payload with the registration
 *     secret and hands the delivery off to the injected WebhookRelayer.
 *   • Consumers verify the signature offline: sha256=<base64-HMAC-SHA256(secret, payload)>.
 *   • The relayer is an injectable adapter: InMemoryWebhookRelayer (tests/dev),
 *     HttpWebhookRelayer (production). Never inline HTTP calls.
 *
 * Invariants:
 *   • Tenant isolation: registrations scoped by tenantId; cross-tenant = null/empty.
 *   • fail-closed on missing tenantId, empty url, or empty secret.
 *   • BigInt amounts in event payloads serialized as strings.
 *   • Dispatch errors are swallowed — a failed delivery must not abort the settlement.
 *   • Signature header: x-tfa-signature: sha256=<base64>
 *   • Event timestamp: x-tfa-event and x-tfa-timestamp headers on every delivery.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

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
  /** HMAC secret — caller supplies or a random 32-byte secret is generated. */
  secret: string;
  createdAt: string;
  active: boolean;
}

export interface CreateWebhookInput {
  tenantId: string;
  url: string;
  events: string[];
  /** Optional caller-supplied secret. Defaults to a random 32-byte hex string. */
  secret?: string;
}

export class WebhookError extends Error {
  code: "invalid_input" | "not_found" | "tenant_mismatch";
  constructor(code: "invalid_input" | "not_found" | "tenant_mismatch", message: string) {
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

  constructor(store: WebhookStore, relayer: WebhookRelayer, deliveryLog: WebhookDeliveryLog = new InMemoryWebhookDeliveryLog()) {
    this.store = store;
    this.relayer = relayer;
    this.deliveryLog = deliveryLog;
  }

  /** Register a new webhook endpoint for a tenant. */
  async register(input: CreateWebhookInput): Promise<WebhookRegistration> {
    if (!input?.tenantId) throw new WebhookError("invalid_input", "tenantId required");
    if (!input.url || !input.url.startsWith("http")) {
      throw new WebhookError("invalid_input", "url must be a valid http/https URL");
    }
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new WebhookError("invalid_input", "events must be a non-empty array");
    }

    const secret =
      input.secret && input.secret.length >= 16
        ? input.secret
        : randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const reg: WebhookRegistration = {
      id: randomUUID(),
      tenantId: input.tenantId,
      url: input.url,
      events: input.events,
      secret,
      createdAt: new Date().toISOString(),
      active: true,
    };
    await this.store.put(reg);
    return reg;
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
   * Errors from individual deliveries are swallowed — a failed delivery must not abort callers.
   */
  async dispatch(tenantId: string, event: WebhookEvent): Promise<void> {
    if (!tenantId || !event?.event) return;
    let regs: WebhookRegistration[];
    try { regs = await this.store.list(tenantId); } catch { return; }

    const payload = JSON.stringify(event);
    const ts = event.occurredAt;

    await Promise.all(
      regs
        .filter((r) => r.active && r.events.includes(event.event))
        .map(async (reg) => {
          const sig = WebhookService.signPayload(reg.secret, payload);
          const delivery: WebhookDelivery = {
            registrationId: reg.id,
            url: reg.url,
            payload,
            signature: sig,
            headers: {
              "content-type": "application/json",
              "x-tfa-signature": sig,
              "x-tfa-event": event.event,
              "x-tfa-timestamp": ts,
              "x-tfa-delivery-id": randomUUID(),
            },
            tenantId,
            event: event.event,
          };
          let result: DeliveryResult;
          try {
            result = await this.relayer.deliver(delivery);
          } catch (err: unknown) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          try {
            await this.deliveryLog.record({
              id: delivery.headers["x-tfa-delivery-id"],
              tenantId,
              registrationId: reg.id,
              event: event.event,
              occurredAt: ts,
              attemptedAt: new Date().toISOString(),
              ok: result.ok,
              statusCode: result.statusCode,
              error: result.error,
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
   * Returns: "sha256=<base64>"
   */
  static signPayload(secret: string, payload: string): string {
    const mac = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(payload, "utf8")
      .digest("base64");
    return `sha256=${mac}`;
  }

  /**
   * Verify a signature produced by signPayload (timing-safe).
   */
  static verifySignature(secret: string, payload: string, signature: string): boolean {
    try {
      const expected = Buffer.from(WebhookService.signPayload(secret, payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
