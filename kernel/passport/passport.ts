/**
 * lib/passport/passport.ts — issuePassport: assemble a signed ActionPassport.
 *
 * Pure, side-effect free aggregator. Reads:
 *   • the AuditRecord from an AuditStore (by id)
 *   • the delegation chain (if the audit record's `source` resolves to an
 *     IdentityStore entry; otherwise null)
 *   • an optional caller-provided LedgerTransaction (BigInt-safe serialised)
 *
 * Produces a canonical JSON body, hashes it (SHA-256), signs the hash with
 * the supplied Signer, and returns the assembled ActionPassport.
 *
 * Fail-closed:
 *   • missing auditId / store / signer → PassportError
 *   • audit id not found in the store   → PassportError
 *   • optional expectedTenantId mismatch → PassportError
 *
 * Zero external dependencies — node:crypto only.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuditId, AuditRecord, AuditStore, Signer } from "../orchestrator/types";
import type { IdentityStore, AgentIdentity } from "../agent-identity/types";
import { buildDelegationChain } from "../agent-identity/delegation";
import type { LedgerTransaction } from "../ledger/types";
import {
  PassportError,
  type ActionPassport,
  type PassportAudit,
  type PassportLedgerEffect,
  type WorkerAttestation,
  type RiskEvidence,
} from "./types";
import type { AgentProvenance, AgentProvenanceInput } from "../adapter/agent-provenance";
import { normalizeAgentProvenance } from "../adapter/agent-provenance";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface IssuePassportOptions {
  /** Audit record to anchor the passport on. Required. */
  auditId: AuditId;
  /** Audit store that owns the record. Required. */
  auditStore: AuditStore;
  /** Signer used to sign the passport hash. Required (passport = signed proof). */
  signer: Signer;
  /**
   * Identity store to resolve the audit record's `source` into a delegation
   * chain. Optional — if omitted, `delegationChain` is null.
   */
  identityStore?: IdentityStore;
  /**
   * Ledger transaction associated with the action. Optional — callers wire
   * this when the action is a mint/withdraw/transfer.
   */
  ledgerEffect?: LedgerTransaction;
  /**
   * If provided, the audit record's tenantId must match exactly.
   * Defence-in-depth against passing the wrong auditId across tenants.
   */
  expectedTenantId?: string;
  /** Override `issuedAt` (mostly for tests). Defaults to new Date().toISOString(). */
  now?: () => string;
  /** Override `passportId` (mostly for tests). Defaults to randomUUID(). */
  passportIdFactory?: () => string;
  /**
   * Optional worker attestation to embed in the passport.
   * When provided (e.g. from a released EscrowAgreement.attestation),
   * it is included in the canonical body so tampering breaks the passport hash.
   */
  attestation?: WorkerAttestation | null;
  /**
   * Optional vendor-neutral agent provenance to embed in the passport (v315).
   * Accepts raw AgentProvenanceInput (normalized internally) or a pre-normalized
   * AgentProvenance. When provided, it is included in the canonical body so
   * tampering with provenance breaks the passport hash.
   * Cross-vendor fingerprint enables one audit trail across xAI/OpenAI/Anthropic/Google.
   */
  provenance?: AgentProvenanceInput | AgentProvenance;
}

/**
 * Assemble + sign an ActionPassport for the given auditId.
 *
 * Returns a fully-populated, JSON-serialisable ActionPassport.
 */
export function issuePassport(opts: IssuePassportOptions): ActionPassport {
  if (!opts || typeof opts !== "object") {
    throw new PassportError("opts is required", "missing_audit_id");
  }
  if (!opts.auditId) {
    throw new PassportError("auditId is required", "missing_audit_id");
  }
  if (!opts.auditStore) {
    throw new PassportError("auditStore is required", "missing_audit_store");
  }
  if (!opts.signer) {
    throw new PassportError("signer is required", "missing_signer");
  }

  const record = opts.auditStore.getRecord(opts.auditId);
  if (!record) {
    throw new PassportError(
      `audit record not found: ${opts.auditId}`,
      "audit_not_found",
    );
  }

  if (opts.expectedTenantId && record.tenantId !== opts.expectedTenantId) {
    throw new PassportError(
      `audit record tenant (${record.tenantId}) does not match expected (${opts.expectedTenantId})`,
      "tenant_mismatch",
    );
  }

  const delegationChain = resolveDelegationChain(record, opts.identityStore);
  const ledgerEffect = opts.ledgerEffect
    ? serialiseLedgerEffect(opts.ledgerEffect)
    : null;
  const riskEvidence = extractRiskEvidence(record.reason);
  const provenance = resolveProvenance(opts.provenance);

  const body = {
    version: "1" as const,
    passportId: (opts.passportIdFactory ?? randomUUID)(),
    issuedAt: (opts.now ?? defaultNow)(),
    tenantId: record.tenantId,
    audit: toPassportAudit(record),
    delegationChain,
    policyDecision: {
      outcome: record.outcome,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    },
    ledgerEffect,
    // attestation is always present in the body for determinism: null when absent.
    attestation: opts.attestation ?? null,
    algorithm: opts.signer.algorithm,
    // kid is included when the signer exposes one (Ed25519Signer).
    // Included in canonical body so tampering breaks the passport hash.
    ...(opts.signer.kid !== undefined ? { kid: opts.signer.kid } : {}),
    // riskEvidence is included when the audit trace carries riskIntelligence.
    ...(riskEvidence !== undefined ? { riskEvidence } : {}),
    // provenance is included when the caller supplies agent identity (v315).
    // Included in canonical body so tampering with cross-vendor identity breaks the hash.
    ...(provenance !== undefined ? { provenance } : {}),
  };

  const hash = computePassportHash(body);
  const signature = opts.signer.sign(hash);

  return { ...body, hash, signature };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultNow(): string {
  return new Date().toISOString();
}

function toPassportAudit(record: AuditRecord): PassportAudit {
  const audit: PassportAudit = {
    id: record.id,
    tenantId: record.tenantId,
    actionId: record.actionId,
    actionType: record.actionType,
    source: record.source,
    outcome: record.outcome,
    occurredAt: record.occurredAt,
    prevHash: record.prevHash,
    hash: record.hash,
  };
  if (record.reason !== undefined) audit.reason = record.reason;
  if (record.signature !== undefined) audit.signature = record.signature;
  return audit;
}

function resolveDelegationChain(
  record: AuditRecord,
  identityStore?: IdentityStore,
): AgentIdentity[] | null {
  if (!identityStore) return null;
  if (!record.source) return null;
  // If `source` doesn't resolve to an identity, chain is simply null.
  // We do not throw — many actions are sourced by free-form labels (services,
  // tests). The passport records the truth: no resolved chain.
  if (!identityStore.getById(record.source)) return null;
  return buildDelegationChain(identityStore, record.source, record.tenantId);
}

function serialiseLedgerEffect(tx: LedgerTransaction): PassportLedgerEffect {
  return {
    transactionId: tx.id,
    tenantId: tx.tenantId,
    kind: tx.kind,
    debitAccountId: tx.debitAccountId,
    creditAccountId: tx.creditAccountId,
    amount: tx.amount.toString(),
    memo: tx.memo,
    initiatedBy: tx.initiatedBy,
    createdAt: tx.createdAt,
  };
}

/**
 * Extract structured RiskEvidence from an audit record's reason field.
 * The reason field carries the JSON-encoded DecisionTrace when the action
 * was allowed; the trace may contain a `riskIntelligence` block.
 *
 * fail-closed:
 *   • missing / non-JSON reason → undefined
 *   • missing / malformed riskIntelligence → undefined
 *   • partial / unexpected factor shape → undefined
 *
 * Pure, zero external dependencies.
 */

/**
 * resolveProvenance — normalize caller-supplied provenance to AgentProvenance.
 * Accepts either a raw AgentProvenanceInput (with vendor/agentId strings) or
 * an already-normalized AgentProvenance (detected by presence of provenanceId).
 * Returns undefined when input is absent. Throws ProvenanceError on invalid input
 * (fail-closed: bad provenance → error, never silently dropped).
 */
export function resolveProvenance(
  input: AgentProvenanceInput | AgentProvenance | undefined,
): AgentProvenance | undefined {
  if (input === undefined || input === null) return undefined;
  // Already normalized (has provenanceId): pass through.
  if ("provenanceId" in input && typeof (input as AgentProvenance).provenanceId === "string") {
    return input as AgentProvenance;
  }
  // Raw input: normalize (throws ProvenanceError on invalid vendor/agentId).
  return normalizeAgentProvenance(input as AgentProvenanceInput);
}

export function extractRiskEvidence(auditReason: string | undefined): RiskEvidence | undefined {
  if (!auditReason || typeof auditReason !== "string") return undefined;
  try {
    const trace = JSON.parse(auditReason);
    if (!trace || typeof trace !== "object" || !trace.riskIntelligence) return undefined;
    const ri = trace.riskIntelligence;
    if (typeof ri.riskScore !== "number" || !Array.isArray(ri.factors)) return undefined;
    const factors = ri.factors.map((f: unknown) => {
      if (!f || typeof f !== "object") return null;
      const factor = (f as Record<string, unknown>).factor;
      const contribution = (f as Record<string, unknown>).contribution;
      const detail = (f as Record<string, unknown>).detail;
      if (typeof factor !== "string" || typeof contribution !== "number" || typeof detail !== "string") {
        return null;
      }
      return { factor, contribution, detail };
    });
    if (factors.some((f: unknown) => f === null)) return undefined;
    return { riskScore: ri.riskScore, factors };
  } catch {
    // fail-closed: any parsing error → no riskEvidence (never throw).
    return undefined;
  }
}

/**
 * Canonical hash over the passport body (everything except `hash` + `signature`).
 *
 * JSON.stringify with a fixed key order makes the digest stable across hosts.
 * The body never contains BigInts (ledger amounts are pre-serialised strings),
 * so plain JSON.stringify is safe.
 */
export function computePassportHash(body: unknown): string {
  const canonical = canonicalStringify(body);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively. Arrays preserve order.
 * Exported for the standalone verifier so it can reproduce the same hash
 * without depending on this module.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      JSON.stringify(k) +
      ":" +
      canonicalStringify((value as Record<string, unknown>)[k]),
  );
  return "{" + parts.join(",") + "}";
}
