/**
 * lib/escrow/share-gate.ts — ShareGate: the single outbound emission gate (I27).
 *
 * K2 sharpening (v144, "the share-gate wakes up") — three laws, wired at
 * WebhookService.register/dispatch and proven in kernel-smoke case 9.
 *
 * DNA: Nimbus I27 — "an outbound share leaves the machine only through the
 * share-gate" (research/nimbus-agent/SECURITY-INVARIANTS.md, I27) — sharpened
 * with AgentKit's action-abstraction shape (research/agentfi/03: the actor
 * declares intent, the kit holds the keys): here callers declare intent via
 * WebhookService.register/dispatch; the gate alone decides WHERE bytes may go
 * and WHAT bytes may leave; the transport below it is dumb.
 *
 *   1. DESTINATION LAW — the gate decides where bytes may go (SSRF-safe,
 *      fail-closed). checkDestination refuses: unparseable URLs, non-HTTPS
 *      schemes (unless policy.allowInsecureHttp), URL-embedded credentials,
 *      internal hostnames (localhost / *.localhost / *.local / *.internal /
 *      *.lan / *.home.arpa / single-label bare names), and IP literals in
 *      non-globally-reachable ranges — loopback, RFC1918, CGNAT, link-local
 *      (incl. the 169.254.169.254 cloud-metadata classic), TEST-NETs,
 *      benchmarking, multicast/reserved, IPv6 ::/ ::1 / ULA fc00::/7 /
 *      link-local fe80::/10 / multicast ff00::/8 / documentation 2001:db8::/32,
 *      IPv4-mapped ::ffff:a.b.c.d smugglers (recursed into the v4 check) and
 *      deprecated IPv4-compatible ::a.b.c.d. When policy.resolveOnDispatch is
 *      on (default), the host is RESOLVED at dispatch time through the
 *      injectable resolver (default: node dns.promises.lookup) and refused if
 *      ANY resolved address is non-public — the DNS-rebinding kill. Refused at
 *      register-time (the door) AND re-checked at every emit (the wire):
 *      stale or tampered registrations cannot smuggle a destination in.
 *
 *   2. PAYLOAD LAW — redact before bytes leave; sign the redacted bytes.
 *      The event walks redactEvent(): values under credential-bearing keys
 *      (secret/token/password/api-key/privkey/cookie/session/seed/… families)
 *      are replaced with "[REDACTED]", key PATHS are recorded, depth-capped at
 *      MAX_REDACT_DEPTH with truncation recorded (never silent). BigInts are
 *      serialised as strings (matching the webhook contract). The REDACTED
 *      bytes are what get signed and delivered — receivers verify the
 *      signature over exactly the bytes that left (HMAC via the one crypto
 *      truth, webhook-crypto.ts).
 *
 *   3. SINGLE EMITTER — the transport is dumb, the gate is the only decider.
 *      WebhookService.dispatch routes every per-registration emission through
 *      emit(); the inner WebhookRelayer receives pre-checked, pre-redacted,
 *      pre-signed bytes. The `fetch(` literal stays confined to
 *      http-webhook-relayer.ts (pure transport); the `.deliver(` call site
 *      stays confined to this file. No off switch: a WebhookService without a
 *      gate in front of its relayer is not constructible — the constructor
 *      installs a default ShareGate when none is passed.
 *
 * Fail-closed: every refusal returns {ok:false, error:"share_gate_refused: …"}
 * and emits NOTHING; the refusal lands in the delivery log with its receipt —
 * a refusal is an event, never silence.
 */

import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { signPayload } from "./webhook-crypto";
import type { WebhookRelayer, WebhookDelivery, DeliveryResult, WebhookEvent, WebhookRegistration } from "./webhook";

// ─── Gate types ───────────────────────────────────────────────────────────────

/** Verdict of a destination check. `ok:false` carries the exact refusal reasons. */
export interface ShareGateVerdict {
  ok: boolean;
  reasons: string[];
}

/** Receipt attached to every emission (allowed or refused) and stored in the delivery log. */
export interface ShareGateReceipt {
  verdict: "allow" | "refuse";
  reasons: string[];
  /** Key PATHS redacted from the payload (e.g. "data.apiKey"). */
  redactedKeys: string[];
  /** True when the redaction walk hit the depth cap and cut. */
  truncated: boolean;
}

/** Outcome of one gated emission: the transport result + the gate receipt. */
export interface ShareGateOutcome {
  result: DeliveryResult;
  receipt: ShareGateReceipt;
}

export interface ShareGatePolicy {
  /** Allow plain http:// (dev only). Default false — https only. */
  allowInsecureHttp?: boolean;
  /** Resolve the host at register+dispatch and refuse non-public resolutions. Default true. */
  resolveOnDispatch?: boolean;
}

/** Injectable DNS resolver (tests stub it; default is node's dns.promises.lookup). */
export type ResolveFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

async function defaultResolve(host: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(host, { all: true, verbatim: true });
}

// ─── Destination law: literal IP/hostname classification ─────────────────────

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".corp"];

/** Maximum depth of the redaction walk — beyond it, data is CUT and the cut is recorded. */
export const MAX_REDACT_DEPTH = 8;

/** Keys whose values are treated as credentials and redacted from outbound payloads. */
const REDACT_KEY = /(secret|token|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|privkey|credential|cookie|session|seed|mnemonic|wif|authorization)/i;

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let u32 = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    u32 = u32 * 256 + n;
  }
  return u32 >>> 0;
}

/** True when the IPv4 address (as uint32) is NOT globally reachable. */
function nonPublicIpv4(u32: number): boolean {
  const a = (u32 >>> 24) & 0xff, b = (u32 >>> 16) & 0xff;
  if (a === 0) return true;                       // 0.0.0.0/8 this-network
  if (a === 10) return true;                      // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 0 && ((u32 >>> 8) & 0xff) === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && ((u32 >>> 8) & 0xff) === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true;        // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && ((u32 >>> 8) & 0xff) === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && ((u32 >>> 8) & 0xff) === 113) return true; // TEST-NET-3
  if (a >= 224) return true;                      // multicast 224/4 + reserved 240/4
  return false;
}

/** Expand an IPv6 literal to 8 hextets, or return null. */
function expandIpv6(host: string): number[] | null {
  let s = host.toLowerCase();
  if (s.includes("%")) s = s.split("%")[0]; // zone id — not a routable literal here
  const doubleColon = s.split("::");
  if (doubleColon.length > 2) return null;
  const head = doubleColon[0] ? doubleColon[0].split(":") : [];
  const tail = doubleColon.length === 2 && doubleColon[1] ? doubleColon[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (doubleColon.length === 1 && head.length !== 8) return null;
  if (doubleColon.length === 2 && (fill < 0 || fill > 7)) return null;
  const groups: string[] = [...head];
  if (doubleColon.length === 2) for (let i = 0; i < fill; i++) groups.push("0");
  groups.push(...tail);
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** True when the IPv6 address is NOT globally reachable (incl. v4-mapped recursion). */
function nonPublicIpv6(h: number[]): boolean {
  const isZero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:0:0/96 — recurse into the embedded v4
  if (isZero(0, 5) && h[5] === 0xffff) {
    const u32 = ((h[6] << 16) | h[7]) >>> 0;
    return nonPublicIpv4(u32);
  }
  // Deprecated IPv4-compatible ::a.b.c.d — refuse
  if (isZero(0, 6) && !(h[6] === 0 && h[7] === 1)) return true; // covers :: and ::a.b.c.d, keeps ::1 refused by name below
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return true; // ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true;  // ULA fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true;  // link-local fe80::/10
  if ((h[0] & 0xff00) === 0xff00) return true;  // multicast ff00::/8
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation 2001:db8::/32
  return false;
}

/**
 * Literal destination checks (no DNS): scheme, credentials, internal host
 * names, non-public IP literals. Returns refusal reasons; [] means allowed.
 */
function literalDestinationRefusals(rawUrl: string, policy: Required<ShareGatePolicy>): string[] {
  const reasons: string[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return ["unparseable_url"];
  }
  if (url.protocol !== "https:" && !(policy.allowInsecureHttp && url.protocol === "http:")) {
    reasons.push(url.protocol === "http:" ? "insecure_scheme_http" : `refused_scheme:${url.protocol.replace(":", "")}`);
  }
  if (url.username || url.password) reasons.push("url_embedded_credentials");
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 literal
  if (!host) return [...reasons, "empty_host"];
  const v4 = parseIpv4(host);
  if (v4 !== null) {
    if (nonPublicIpv4(v4)) reasons.push("non_public_ip_literal");
  } else if (host.includes(":")) {
    const h = expandIpv6(host);
    if (h === null || nonPublicIpv6(h)) reasons.push("non_public_ip_literal");
  } else {
    if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
      reasons.push("internal_hostname");
    }
  }
  return reasons;
}

// ─── Payload law: redaction ──────────────────────────────────────────────────

export interface RedactionOutcome {
  event: WebhookEvent;
  /** Key PATHS whose values were redacted (e.g. "data.apiKey"). */
  redactedKeys: string[];
  truncated: boolean;
}

function walkRedact(value: unknown, key: string, path: string, depth: number, out: { redactedKeys: string[]; truncated: boolean }): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    out.truncated = true;
    return "[TRUNCATED]";
  }
  if (typeof value === "bigint") return value.toString(); // webhook contract: BigInt → string
  if (Array.isArray(value)) return value.map((v, i) => walkRedact(v, key, `${path}[${i}]`, depth + 1, out));
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const dst: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      const childPath = path ? `${path}.${k}` : k;
      if (REDACT_KEY.test(k)) {
        dst[k] = "[REDACTED]";
        out.redactedKeys.push(childPath);
      } else {
        dst[k] = walkRedact(src[k], k, childPath, depth + 1, out);
      }
    }
    return dst;
  }
  return value;
}

/**
 * Redact credential-bearing values from an event (by key NAME, path-recorded,
 * depth-capped). The returned event is what the gate stringifies, signs and
 * delivers — receivers verify over exactly the redacted bytes.
 */
export function redactEvent(event: WebhookEvent): RedactionOutcome {
  const out = { redactedKeys: [], truncated: false } as { redactedKeys: string[]; truncated: boolean };
  const walked = walkRedact(event, "", "", 0, out) as WebhookEvent;
  return { event: walked, redactedKeys: out.redactedKeys, truncated: out.truncated };
}

// ─── ShareGate ────────────────────────────────────────────────────────────────

/**
 * ShareGate — the I27 chokepoint. Decorates a dumb WebhookRelayer transport.
 * The gate decides destination + payload; the transport moves pre-signed,
 * pre-redacted bytes. No bypass: WebhookService installs a gate by default.
 */
export class ShareGate {
  private readonly inner: WebhookRelayer;
  private readonly policy: Required<ShareGatePolicy>;
  private readonly resolve: ResolveFn;

  constructor(inner: WebhookRelayer, policy: ShareGatePolicy = {}, deps?: { resolve?: ResolveFn }) {
    if (!inner) throw new Error("ShareGate requires an inner transport");
    this.inner = inner;
    this.policy = {
      allowInsecureHttp: policy.allowInsecureHttp ?? false,
      resolveOnDispatch: policy.resolveOnDispatch ?? true,
    };
    this.resolve = deps?.resolve ?? defaultResolve;
  }

  /**
   * Destination check — the door (register) and the wire (every emit) both call
   * this. Literal checks always; DNS resolution when policy.resolveOnDispatch.
   * Fail-closed: any resolution error refuses (an unresolvable destination is
   * not a destination we can vouch for).
   */
  async checkDestination(rawUrl: string): Promise<ShareGateVerdict> {
    const reasons = literalDestinationRefusals(rawUrl, this.policy);
    if (reasons.length > 0) return { ok: false, reasons };
    if (!this.policy.resolveOnDispatch) return { ok: true, reasons: [] };
    let host: string;
    try {
      host = new URL(rawUrl).hostname.toLowerCase();
      if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    } catch {
      return { ok: false, reasons: ["unparseable_url"] };
    }
    const v4 = parseIpv4(host);
    if (v4 !== null || host.includes(":")) return { ok: true, reasons: [] }; // literal already classified
    try {
      const addrs = await this.resolve(host);
      if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, reasons: ["resolution_empty"] };
      for (const a of addrs) {
        const addr = String(a?.address ?? "").toLowerCase();
        const asV4 = parseIpv4(addr);
        if (asV4 !== null) {
          if (nonPublicIpv4(asV4)) return { ok: false, reasons: [`resolves_non_public:${addr}`] };
        } else {
          const h = expandIpv6(addr.includes("%") ? addr.split("%")[0] : addr);
          if (h === null || nonPublicIpv6(h)) return { ok: false, reasons: [`resolves_non_public:${addr}`] };
        }
      }
      return { ok: true, reasons: [] };
    } catch (e: unknown) {
      return { ok: false, reasons: [`resolution_failed:${e instanceof Error ? e.message : String(e)}`] };
    }
  }

  /**
   * The single emission path: re-check the destination (the wire), redact the
   * event, sign the REDACTED bytes, build the delivery, hand it to the dumb
   * transport. On refusal: nothing is emitted, the receipt says exactly why.
   * K3 (v145): the secret arrives as an EXPLICIT argument — the unseal happens
   * in the service's sign frame; the gate never pulls key material out of a
   * bag. Type-level seal: the registration carried in here has no secret field
   * at all (the store shape lacks it).
   */
  async emit(args: { reg: WebhookRegistration; secret: string; event: WebhookEvent; deliveryId?: string }): Promise<ShareGateOutcome> {
    const refuse = (reasons: string[]): ShareGateOutcome => ({
      result: { ok: false, error: `share_gate_refused: ${reasons.join("; ")}` },
      receipt: { verdict: "refuse", reasons, redactedKeys: [], truncated: false },
    });

    const dest = await this.checkDestination(args.reg.url);
    if (!dest.ok) return refuse(dest.reasons);

    const red = redactEvent(args.event);
    const payload = JSON.stringify(red.event);
    const signature = signPayload(args.secret, payload);
    const delivery: WebhookDelivery = {
      registrationId: args.reg.id,
      url: args.reg.url,
      payload,
      signature,
      headers: {
        "content-type": "application/json",
        "x-tfa-signature": signature,
        "x-tfa-event": args.event.event,
        "x-tfa-timestamp": args.event.occurredAt,
        "x-tfa-delivery-id": args.deliveryId ?? randomUUID(),
      },
      tenantId: args.event.tenantId,
      event: args.event.event,
    };

    const result = await this.inner.deliver(delivery);
    return {
      result,
      receipt: { verdict: "allow", reasons: [], redactedKeys: red.redactedKeys, truncated: red.truncated },
    };
  }
}
