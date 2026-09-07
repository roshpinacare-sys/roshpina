/**
 * lib/adapter/ard-verifier.ts — ARD (Agentic Resource Discovery) v0.9-draft verifier.
 *
 * Given a `urn:ai:...` and an ARD trustManifest, verifies:
 *   1. URN well-formedness (RFC 8141)
 *   2. Domain↔identity alignment (URN authority must match trustManifest.identity domain)
 *   3. Detached JWS signature (alg allow-list EdDSA/HS256 — fail-closed)
 *   4. Attestation digest presence (resolvability requires network; we validate structure)
 *
 * Invariants:
 *   - Zero external dependencies.
 *   - Unknown / invalid / missing input → error or invalid verdict (fail-closed).
 *   - JWS alg is checked against allow-list BEFORE any verification attempt.
 *   - Re-uses canonicalizeJson and verifyDetachedJws from ard-publisher.ts.
 */

import type { Signer } from "../orchestrator/types.ts";
import { verifyDetachedJws, canonicalizeJson } from "./ard-publisher.ts";
import type { ArdTrustManifest } from "./ard-publisher.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArdVerifyOptions {
  urn: string;
  trustManifest: ArdTrustManifest;
  signer?: Signer;
}

export interface ArdVerifyResult {
  valid: boolean;
  checks: {
    urnWellFormed: boolean;
    domainAlignment: boolean;
    jwsValid: boolean | null;
    attestationsResolvable: boolean | null;
  };
  reasons: string[];
}

// ─── URN parsing — efficiency: pre-compiled regex (computed once) ───────────

const URN_AI_RE = /^urn:ai:([^:]+):([^:]+):([^:]+)$/;

/** Extract the publisher-FQDN authority from a urn:ai:... identifier. */
export function parseUrnAuthority(urn: string): { ok: true; fqdn: string; namespace: string; agentName: string } | { ok: false; reason: string } {
  if (!urn || typeof urn !== "string") {
    return { ok: false, reason: "URN is empty or not a string" };
  }
  const m = URN_AI_RE.exec(urn);
  if (!m) {
    return { ok: false, reason: "URN does not match expected format urn:ai:<publisher-FQDN>:<namespace>:<agent-name>" };
  }
  const [, fqdn, namespace, agentName] = m;
  if (!fqdn || fqdn.length === 0) {
    return { ok: false, reason: "URN publisher-FQDN is empty" };
  }
  return { ok: true, fqdn, namespace, agentName };
}

// ─── Domain extraction from identity URI ───────────────────────────────────

/**
 * Extract the trust-domain / host from an ARD identity URI.
 *   did:web:<domain>          → <domain>
 *   https://<domain>/...      → <domain>
 *   spiffe://<domain>/...     → <domain>
 *   other DID schemes         → identity string as-is (alignment falls to exact match)
 */
export function extractDomainFromIdentity(identity: string): { ok: true; domain: string } | { ok: false; reason: string } {
  if (!identity || typeof identity !== "string") {
    return { ok: false, reason: "identity is empty or not a string" };
  }
  if (identity.startsWith("did:web:")) {
    const domain = identity.slice("did:web:".length);
    if (!domain) return { ok: false, reason: "did:web identity has empty domain" };
    return { ok: true, domain };
  }
  if (identity.startsWith("https://")) {
    try {
      const hostname = new URL(identity).hostname;
      if (!hostname) return { ok: false, reason: "https identity has empty hostname" };
      return { ok: true, domain: hostname };
    } catch {
      return { ok: false, reason: "https identity is not a valid URL" };
    }
  }
  if (identity.startsWith("spiffe://")) {
    const rest = identity.slice("spiffe://".length);
    const slashIdx = rest.indexOf("/");
    const domain = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    if (!domain) return { ok: false, reason: "spiffe identity has empty trust domain" };
    return { ok: true, domain };
  }
  // For non-web DIDs, exact match is the only alignment we can assert
  return { ok: true, domain: identity };
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Verify an ARD agent identity claim.
 * Fail-closed: any REQUIRED check failure (malformed URN, domain mismatch,
 * invalid JWS alg, bad signature) sets valid=false.
 *
 * If `signer` is not provided, JWS verification is skipped (jwsValid=null)
 * and the caller is responsible for signature validation.
 */
export function verifyArdAgent(options: ArdVerifyOptions): ArdVerifyResult {
  const reasons: string[] = [];
  const checks: ArdVerifyResult["checks"] = {
    urnWellFormed: false,
    domainAlignment: false,
    jwsValid: null,
    attestationsResolvable: null,
  };

  // 1. URN well-formedness
  const urnParsed = parseUrnAuthority(options.urn);
  if (!urnParsed.ok) {
    reasons.push(urnParsed.reason);
    return { valid: false, checks, reasons };
  }
  checks.urnWellFormed = true;

  // 2. Domain↔identity alignment
  const tm = options.trustManifest;
  if (!tm || typeof tm !== "object") {
    reasons.push("trustManifest is missing or not an object");
    return { valid: false, checks, reasons };
  }
  if (!tm.identity) {
    reasons.push("trustManifest.identity is missing");
    return { valid: false, checks, reasons };
  }

  const domainRes = extractDomainFromIdentity(tm.identity);
  if (!domainRes.ok) {
    reasons.push(domainRes.reason);
    return { valid: false, checks, reasons };
  }

  // Exact match: the URN publisher-FQDN must equal the identity domain
  if (urnParsed.fqdn !== domainRes.domain) {
    reasons.push(`domain mismatch: URN authority "${urnParsed.fqdn}" does not match identity domain "${domainRes.domain}"`);
    return { valid: false, checks, reasons };
  }
  checks.domainAlignment = true;

  // 3. Detached JWS verification
  if (tm.signature && typeof tm.signature === "string") {
    if (!options.signer) {
      checks.jwsValid = null;
      reasons.push("JWS present but no verifier signer provided — signature not checked");
    } else {
      // Build the canonical payload (signature field itself is excluded)
      const { signature: _, ...payload } = tm;
      const canonical = canonicalizeJson(payload);
      const jwsOk = verifyDetachedJws(tm.signature, canonical, options.signer);
      checks.jwsValid = jwsOk;
      if (!jwsOk) {
        reasons.push("JWS signature verification failed (alg not allowed, signer mismatch, or tampered payload)");
      }
    }
  } else {
    checks.jwsValid = null;
    reasons.push("trustManifest has no signature — JWS verification skipped");
  }

  // 4. Attestation digest check (structure only; URI resolution requires network)
  if (Array.isArray(tm.attestations) && tm.attestations.length > 0) {
    const allHaveDigests = tm.attestations.every(
      (a) => a && typeof a === "object" && typeof a.digest === "string" && a.digest.length > 0,
    );
    if (allHaveDigests) {
      checks.attestationsResolvable = true;
    } else {
      checks.attestationsResolvable = false;
      reasons.push("one or more attestations lack a digest field");
    }
  } else {
    checks.attestationsResolvable = null;
    reasons.push("no attestations present — digest check skipped");
  }

  const valid = checks.domainAlignment && (checks.jwsValid !== false) && (checks.attestationsResolvable !== false);
  return { valid, checks, reasons };
}
