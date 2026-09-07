/** lib/track-record — Verified Track Record read-model (trust price discovery, step 1). */
export { computeTrackRecord, type TrackRecord, type ChainReader, type EscrowReader, type AccountOwnerResolver, type TrackRecordOptions } from "./track-record";
export {
  type TrackRecordCache,
  InMemoryTrackRecordCache,
  getCachedOrCompute,
} from "./track-record-cache";

export { buildTrustProofBundle, verifyBundleHash, type TrustProofBundle, type ProofPassportEntry } from "./proof-bundle";
export {
  buildTrustProofBundleV2,
  verifyProofBundleV2,
  PROOF_BUNDLE_DEFAULT_VALID_MS,
  type TrustProofBundleV2,
  type ProofBundleSignerKey,
  type ProofBundleEvidenceItem,
  type ProofBundleApprovalRef,
  type ProofBundleLedgerRef,
  type ProofBundlePolicyRef,
  type BuildTrustProofBundleV2Input,
  type ProofBundleVerifyOptions,
} from "./proof-bundle-v2";

export {
  buildCountProof,
  verifyCountProof,
  countProofSigningPayload,
  COUNT_PROOF_VERSION,
  CountProofError,
  type CountProof,
  type CountProofWitness,
  type CountProofPayloadFields,
  type BuildCountProofInput,
  type CountProofErrorCode,
} from "./count-proof";

export {
  buildPredicateProof,
  verifyPredicateProof,
  predicateProofSigningPayload,
  PREDICATE_PROOF_VERSION,
  PredicateProofError,
  type PredicateProof,
  type PredicateProofWitness,
  type PredicateProofPayloadFields,
  type BuildPredicateProofInput,
  type PredicateProofErrorCode,
} from "./predicate-proof";

export {
  buildRedactedProofBundle,
  verifyRedactedProofBundle,
  type RedactedTrustProofBundle,
  type RedactedArrayDigest,
  type RedactedBundleVerifyOptions,
} from "./redacted-proof-bundle";

export {
  BILLING_DISPUTE_PROOF_VERSION,
  buildBillingDisputeProof,
  verifyBillingDisputeProof,
  billingDisputeProofSigningPayload,
  classifyDiscrepancy,
  BillingDisputeProofError,
  type BillingDisputeProof,
  type BillingDisputeProofPayloadFields,
  type BuildBillingDisputeProofInput,
  type BillingDiscrepancyType,
} from "./billing-dispute-proof";
