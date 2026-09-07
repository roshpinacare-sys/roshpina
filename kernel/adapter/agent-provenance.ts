/**
 * lib/adapter/agent-provenance.ts — vendor-neutral agent provenance.
 *
 * THE STRATEGIC WEDGE (why this is the layer the giants structurally cannot own)
 * -----------------------------------------------------------------------------
 * As of 2026 the AI-agent market is consolidating into single-vendor vertical
 * stacks: xAI+Cursor, OpenAI+Windsurf, Anthropic, Google, plus agent payment rails
 * (Coinbase x402, AWS AgentCore). Each giant verifies its OWN agents — but a vendor
 * cannot be the neutral arbiter of its own agents, and a Fortune-500 buyer running
 * agents from SEVERAL of these vendors needs ONE trustworthy audit trail across ALL
 * of them. No vertically-integrated vendor has the incentive to build that neutral,
 * cross-vendor layer. TFA does.
 *
 * This module is the mechanism: it normalizes "which vendor's agent (and model)
 * performed this action" into a single canonical schema, so a TFA receipt carries
 * vendor-neutral provenance and an enterprise gets one audit trail spanning xAI,
 * OpenAI, Anthropic, Google, and custom agents alike. It is the connective tissue
 * that makes TFA indispensable regardless of which model vendor wins.
 *
 * Deterministic, pure, zero-dep. fail-closed: missing vendor/agentId throws; an
 * unrecognized vendor is preserved as "custom" with the raw label kept (never drop
 * information, never silently mislabel).
 */

import { createHash } from "node:crypto";

/** Known agent vendors, normalized. "custom" preserves the raw label for anything else. */
export type AgentVendor =
  | "xai"
  | "openai"
  | "anthropic"
  | "google"
  | "cursor"
  | "windsurf"
  | "github"
  | "aws"
  | "coinbase"
  | "custom";

/** Aliases → canonical vendor. Lowercased, punctuation-insensitive lookups. */
const VENDOR_ALIASES: Record<string, AgentVendor> = {
  xai: "xai", grok: "xai", "grok-build": "xai",
  openai: "openai", chatgpt: "openai", gpt: "openai", windsurf: "windsurf", openclaw: "openai",
  anthropic: "anthropic", claude: "anthropic", "claude-code": "anthropic",
  google: "google", gemini: "google", vertex: "google",
  cursor: "cursor", anysphere: "cursor", composer: "cursor",
  github: "github", copilot: "github",
  aws: "aws", bedrock: "aws", agentcore: "aws",
  coinbase: "coinbase", x402: "coinbase",
};

export interface AgentProvenanceInput {
  /** Vendor / platform that ran the agent (free text; normalized internally). */
  vendor: string;
  /** Stable agent identifier within the vendor (required). */
  agentId: string;
  /** Optional product surface (e.g. "cursor", "claude-code", "grok-build"). */
  product?: string;
  /** Optional model identifier (e.g. "grok-build-1", "claude-opus-4.8"). */
  model?: string;
  /** Optional session/run id for correlating multi-step work. */
  sessionId?: string;
}

export interface AgentProvenance {
  vendor: AgentVendor;
  /** The original vendor label, always preserved (audit fidelity). */
  vendorRaw: string;
  agentId: string;
  product?: string;
  model?: string;
  sessionId?: string;
  /**
   * Deterministic cross-vendor fingerprint (sha256 of the canonical tuple).
   * Stable for the same identity across receipts → enables one audit trail.
   */
  provenanceId: string;
}

export class ProvenanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProvenanceError";
  }
}

/** Normalize a free-text vendor label to a canonical vendor (fail-open to "custom"). */
export function normalizeVendor(raw: string): AgentVendor {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ProvenanceError("invalid_vendor", "vendor must be a non-empty string");
  }
  const key = raw.trim().toLowerCase().replace(/[\s_.]+/g, "-");
  if (key in VENDOR_ALIASES) return VENDOR_ALIASES[key];
  // try the bare first token (e.g. "openai gpt-5" → "openai")
  const head = key.split("-")[0];
  return VENDOR_ALIASES[head] ?? "custom";
}

/** Canonical string the fingerprint is computed over (stable field order). */
function canonicalProvenance(p: Omit<AgentProvenance, "provenanceId">): string {
  return [
    "tfa-agent-prov-v1",
    p.vendor,
    p.vendorRaw,
    p.agentId,
    p.product ?? "",
    p.model ?? "",
    p.sessionId ?? "",
  ].join("|");
}

/**
 * normalizeAgentProvenance — build a vendor-neutral provenance record with a
 * deterministic cross-vendor fingerprint. fail-closed on missing vendor/agentId.
 */
export function normalizeAgentProvenance(input: AgentProvenanceInput): AgentProvenance {
  if (!input || typeof input !== "object") {
    throw new ProvenanceError("invalid_input", "provenance input must be an object");
  }
  if (typeof input.agentId !== "string" || input.agentId.trim().length === 0) {
    throw new ProvenanceError("invalid_agent_id", "agentId is required");
  }
  const vendor = normalizeVendor(input.vendor); // throws on empty vendor
  const base: Omit<AgentProvenance, "provenanceId"> = {
    vendor,
    vendorRaw: input.vendor.trim(),
    agentId: input.agentId.trim(),
    ...(input.product ? { product: input.product.trim() } : {}),
    ...(input.model ? { model: input.model.trim() } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId.trim() } : {}),
  };
  const provenanceId = createHash("sha256").update(canonicalProvenance(base)).digest("hex");
  return { ...base, provenanceId };
}

/**
 * sameAgent — do two provenance records denote the same agent identity?
 * (Deterministic fingerprint equality — the basis for a cross-vendor audit trail.)
 */
export function sameAgent(a: AgentProvenance, b: AgentProvenance): boolean {
  return !!a && !!b && a.provenanceId === b.provenanceId;
}
