/**
 * lib/track-record/proof-bundle.ts — Public Trust API: the portable, externally-verifiable
 * proof of a track record (deep-audit report, cycle K7 — "the real moat").
 *
 * The track record's score is only valuable if a THIRD PARTY can trust it without trusting us.
 * A proof bundle packages:
 *   • the computed TrackRecord (score + explanation)
 *   • the supporting Action Passports (each already self-verifying via the kernel signer)
 *   • the issuer public key + algorithm
 *   • a bundle-level hash over the canonical contents
 * so any party can: (1) verify each passport offline with the public key, (2) recompute the score
 * from the same passports, (3) confirm the bundle hash. Trust becomes PORTABLE — the asset the
 * report says competitors cannot copy because it is earned, signed history.
 *
 * This module builds the bundle; verification is done by the existing standalone verifier plus
 * the deterministic computeTrackRecord (same inputs → same score, by construction).
 */
import { createHash } from "node:crypto";
import type { TrackRecord } from "./track-record";

export interface ProofPassportEntry {
  passportId: string;
  auditId: string;
  actionType: string;
  outcome: string;
  /** the passport's own signature (verifiable offline with publicKey) */
  signature?: string;
}

export interface TrustProofBundle {
  version: "1";
  tenantId: string;
  identityId: string;
  record: TrackRecord;
  passports: ProofPassportEntry[];
  publicKey: string | null;
  algorithm: string;
  /** SHA-256 over the canonical bundle body (everything except this field) */
  bundleHash: string;
  issuedAt: string;
}

import { canonicalJson } from "../common/canonical-json";

/**
 * Build a verifiable proof bundle for an identity's track record.
 * `passports` are the supporting entries (the caller selects the relevant audit/passport records);
 * `record` is the deterministic TrackRecord; `publicKey`/`algorithm` come from the kernel signer.
 */
export function buildTrustProofBundle(input: {
  tenantId: string;
  identityId: string;
  record: TrackRecord;
  passports: ProofPassportEntry[];
  publicKey: string | null;
  algorithm: string;
}): TrustProofBundle {
  if (!input.tenantId || !input.identityId) throw new Error("buildTrustProofBundle: tenantId and identityId required");
  const body = {
    version: "1" as const,
    tenantId: input.tenantId,
    identityId: input.identityId,
    record: input.record,
    passports: input.passports,
    publicKey: input.publicKey,
    algorithm: input.algorithm,
    issuedAt: new Date().toISOString(),
  };
  const bundleHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, bundleHash };
}

/**
 * Recompute the bundle hash and confirm it matches — the cheap integrity check any verifier runs
 * before trusting the contents. (Per-passport signature verification is done by the standalone
 * verifier with the publicKey; score recomputation is done by computeTrackRecord.)
 */
export function verifyBundleHash(bundle: TrustProofBundle): boolean {
  if (!bundle || bundle.version !== "1") return false;
  const { bundleHash, ...body } = bundle;
  const recomputed = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return recomputed === bundleHash;
}
