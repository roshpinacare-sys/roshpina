/**
 * lib/passport/index.ts — barrel export for the Action Passport subsystem.
 */

export { issuePassport, computePassportHash, canonicalStringify, resolveProvenance } from "./passport";
export type { IssuePassportOptions } from "./passport";
export { PassportError, ClaimError } from "./types";
export type {
  ActionPassport,
  PassportAudit,
  PassportLedgerEffect,
  PassportPolicyDecision,
  PassportVersion,
  PassportErrorCode,
  WorkerAttestation,
  ClaimErrorCode,
  RiskEvidence,
} from "./types";

export {
  buildPassportClaim,
  computeClaimHash,
  canonicalPassportClaim,
  normalizeRevocationStatus,
  revokeClaim,
  isClaimRevoked,
  clearRevocations,
  REVOCATION_STATUSES,
} from "./claim";
export type { PassportClaim, RevocationStatus, BuildClaimOptions } from "./claim";

export { verifyPassportClaim } from "./claim-verifier";
export type { ClaimVerifyResult, ClaimVerifyKeys, ClaimVerifyOpts, ClaimCheck } from "./claim-verifier";

export { verifyActionPassport } from "./passport-verifier";
export type { PassportVerifyResult, PassportVerifyKeys, PassportVerifyOpts, PassportCheck } from "./passport-verifier";

export { KeyRing, KeyRingError, computeKid } from "./key-ring";
export type { KeyRingEntry, KeyAlgorithm, KeyStatus } from "./key-ring";

export { PassportRevocationList, PassportRevocationError } from "./passport-revocation-list";
export type { RevocationEntry } from "./passport-revocation-list";
