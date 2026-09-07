/**
 * lib/adapter/ard-publisher.ts — Thin ARD (Agentic Resource Discovery) v0.9-draft adapter.
 * Builds a spec-conformant `/.well-known/ai-catalog.json` payload with a
 * TFA-backed `trustManifest` (identity + detached JWS).
 *
 * Invariants:
 *   - Zero external dependencies.
 *   - ARD is v0.9 draft; this adapter is thin and labelled as such.
 *   - Detached JWS wraps the TFA signer (Ed25519 → EdDSA, HMAC → HS256).
 *   - Unknown / invalid input → error (fail-closed).
 *   - Catalog is cached per tenant to avoid re-signing on every request.
 */

import type { Signer } from "../orchestrator/types.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArdAttestation {
  type: string;
  uri: string;
  digest?: string;
}

export interface ArdProvenance {
  relation: string;
  sourceId: string;
  sourceDigest?: string;
}

export interface ArdTrustManifest {
  identity: string;
  identityType?: "did" | "spiffe" | "https";
  attestations?: ArdAttestation[];
  provenance?: ArdProvenance[];
  signature?: string; // detached JWS
}

export interface ArdAgent {
  id: string;
  name: string;
  description: string;
  trustManifest?: ArdTrustManifest;
}

export interface ArdCatalog {
  schemaVersion: string;
  publisher: {
    name: string;
    uri: string;
  };
  agents: ArdAgent[];
}

export interface BuildArdCatalogOptions {
  tenantId: string;
  signer: Signer;
  /**
   * Optional FQDN override for the tenant's identity.
   * Defaults to `did:web:<tenantId>.tfa.local`.
   */
  domain?: string;
  /**
   * Optional public key for attestation URI construction.
   */
  publicKey?: string | null;
  /**
   * Optional recent audit hash to include in provenance.
   */
  recentAuditHash?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlRaw(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Map TFA signer algorithm to JWS "alg" header value.
 * fail-closed: unknown algorithm throws.
 */
function jwsAlgFromSigner(signer: Signer): string {
  const alg = signer.algorithm;
  if (alg === "ed25519") return "EdDSA";
  if (alg === "hmac-sha256" || alg === "hmac") return "HS256";
  if (alg === "hybrid-ed25519-mldsa") return "EdDSA"; // primary classical alg in header
  throw new Error(`unsupported signer algorithm for JWS: ${alg}`);
}

/**
 * Create a detached JWS (RFC 7515) over a canonical JSON payload.
 * Returns `header..signature` (payload omitted).
 *
 * Security note: this is a TFA-native signing wrapper, not a general-purpose
 * JWS implementation. ARD consumers must verify the alg before trusting.
 */
export function createDetachedJws(payload: string, signer: Signer): string {
  const header = b64url(
    JSON.stringify({
      alg: jwsAlgFromSigner(signer),
      kid: signer.kid ?? undefined,
      typ: "JWS",
      // Tag this as a TFA-sim wrapper so callers know the layering.
      crit: ["tfa-sim"],
      "tfa-sim": "TFA signer wrapped as ARD detached JWS — verify alg before trusting",
    }),
  );
  const body = b64url(payload);
  const sigRaw = signer.sign(`${header}.${body}`);
  const sig = b64urlRaw(Buffer.from(sigRaw, "base64"));
  return `${header}..${sig}`;
}

/**
 * Verify a detached JWS produced by `createDetachedJws`.
 * The payload must be supplied by the caller (it is not embedded in the token).
 * Returns true only if the JWS alg is in the allow-list AND the signature verifies.
 *
 * Safety: only "EdDSA" and "HS256" are accepted; anything else returns false.
 */
export function verifyDetachedJws(token: string, payload: string, signer: Signer): boolean {
  const parts = token.split("..");
  if (parts.length !== 2) return false;
  const [header, sig] = parts;
  if (!header || !sig) return false;

  let headerJson: any;
  try {
    headerJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  // fail-closed: reject unknown / disallowed algorithms
  const allowedAlgs = new Set(["EdDSA", "HS256"]);
  if (!allowedAlgs.has(headerJson.alg)) return false;

  // The signer must match the algorithm declared in the header
  const expectedAlg = jwsAlgFromSigner(signer);
  if (headerJson.alg !== expectedAlg) return false;

  const body = b64url(payload);
  const toVerify = `${header}.${body}`;

  try {
    const sigBytes = Buffer.from(sig, "base64url").toString("base64");
    return signer.verify(toVerify, sigBytes);
  } catch {
    return false;
  }
}

// ─── Catalog Builder ─────────────────────────────────────────────────────────

/** Derive ARD identityType from an identity URI. */
function deriveIdentityType(identity: string): ArdTrustManifest["identityType"] {
  if (identity.startsWith("did:")) return "did";
  if (identity.startsWith("spiffe://")) return "spiffe";
  if (identity.startsWith("https://")) return "https";
  return undefined;
}

function buildIdentity(opts: BuildArdCatalogOptions): string {
  if (opts.domain) {
    // If domain is a full URI, use it directly
    if (/^(did:|spiffe:|https:)/.test(opts.domain)) return opts.domain;
    return `did:web:${opts.domain}`;
  }
  return `did:web:${opts.tenantId}.tfa.local`;
}

/**
 * Build a canonical ARD catalog payload for the given tenant.
 * The payload is deterministic and JSON-stable (keys sorted) so that
 * signatures and hashes are reproducible.
 */
export function buildArdCatalog(opts: BuildArdCatalogOptions): ArdCatalog {
  if (!opts.tenantId || typeof opts.tenantId !== "string") {
    throw new Error("tenantId is required");
  }
  if (!opts.signer || typeof opts.signer.sign !== "function") {
    throw new Error("signer is required");
  }

  const identity = buildIdentity(opts);
  const identityType = deriveIdentityType(identity);

  // Attestations: TFA provenance as ARD attestation URIs
  const attestations: ArdAttestation[] = [
    {
      type: "TFA-VerifiedProvenance",
      uri: `https://tfa.dev/verify/${encodeURIComponent(opts.tenantId)}`,
      digest: opts.recentAuditHash ?? undefined,
    },
  ];

  // Provenance: cross-vendor agent identity mapping
  const provenance: ArdProvenance[] = [
    {
      relation: "publishedFrom",
      sourceId: `urn:tfa:tenant:${opts.tenantId}`,
      sourceDigest: opts.recentAuditHash ?? undefined,
    },
  ];

  const trustManifestPayload: ArdTrustManifest = {
    identity,
    identityType,
    attestations,
    provenance,
  };

  // Canonical JSON for signing (stable key order, no extra whitespace)
  const canonicalPayload = canonicalizeJson(trustManifestPayload);
  const signature = createDetachedJws(canonicalPayload, opts.signer);

  const agent: ArdAgent = {
    id: `urn:ai:${identity.replace(/^did:web:/, "").replace(/^https:\/\//, "")}:tfa:trust-gate`,
    name: "TFA Trust Gate",
    description: "Policy-gated action execution with verifiable receipts and transparency-log anchoring",
    trustManifest: {
      ...trustManifestPayload,
      signature,
    },
  };

  return {
    schemaVersion: "v0.9-draft",
    publisher: {
      name: "TFA Trust Control Plane",
      uri: "https://tfa.dev",
    },
    agents: [agent],
  };
}

/**
 * Deterministic JSON canonicalization for signing.
 * Sorts object keys, handles arrays linearly, stringifies bigints.
 * Omits keys whose value is undefined (matches JSON.stringify behaviour).
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "bigint")) {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k]));
  return "{" + pairs.join(",") + "}";
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const catalogCache = new Map<string, { catalog: ArdCatalog; at: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build (or retrieve from cache) an ARD catalog for a tenant.
 * Caching avoids re-signing on every request (compute-once).
 */
export function getCachedArdCatalog(opts: BuildArdCatalogOptions): ArdCatalog {
  const key = opts.tenantId + "|" + (opts.domain ?? "") + "|" + (opts.recentAuditHash ?? "");
  const now = Date.now();
  const cached = catalogCache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.catalog;
  }
  const catalog = buildArdCatalog(opts);
  catalogCache.set(key, { catalog, at: now });
  return catalog;
}

/** Exposed for tests. */
export function _clearArdCatalogCache(): void {
  catalogCache.clear();
}
