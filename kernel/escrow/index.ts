/** lib/escrow — barrel. Sovereign Escrow: completion-contingent payment over the guarded kernel. */
export { EscrowService, InMemoryEscrowStore, type EscrowStore, type CreateEscrowInput, type FeeConfig } from "./escrow";
export { EscrowError, type EscrowAgreement, type EscrowState, type EscrowErrorCode, type WorkerAttestation } from "./types";
export {
  SettlementService,
  InMemorySettlementStore,
  SettlementError,
  type SettlementStore,
  type CreateSettlementInput,
  type SettlementAgreement,
  type SettlementState,
  type SettlementErrorCode,
} from "./settlement";
export {
  WebhookService,
  InMemoryWebhookRelayer,
  InMemoryWebhookStore,
  InMemoryWebhookDeliveryLog,
  DEFAULT_DELIVERY_LOG_CAP,
  WebhookError,
  WEBHOOK_EVENTS,
  type WebhookStore,
  type WebhookRelayer,
  type WebhookRegistration,
  type WebhookRegistrationCreated,
  type WebhookEvent,
  type WebhookDelivery,
  type DeliveryResult,
  type CreateWebhookInput,
  type WebhookEventType,
  type WebhookDeliveryLog,
  type WebhookDeliveryRecord,
} from "./webhook";
export {
  AesGcmSecretSealer,
  SecretSealError,
  secretFingerprint,
  type SecretSealer,
  type SealedSecret,
} from "./webhook-secrets";
export {
  ConsecutiveFailuresBreaker,
  type BreakerState,
  type BreakerDecision,
  type BreakerOptions,
} from "./webhook-breaker";
export { HttpWebhookRelayer, type HttpWebhookRelayerConfig } from "./http-webhook-relayer";
export {
  ShareGate,
  MAX_REDACT_DEPTH,
  redactEvent,
  type ShareGatePolicy,
  type ShareGateVerdict,
  type ShareGateReceipt,
  type ShareGateOutcome,
  type ResolveFn,
} from "./share-gate";
export {
  generateThresholdApproval,
  generateThresholdApprovalForKey,
  validateAndConsumeApproval,
  validateMultiPartyApprovals,
  validateQuorumApproval,
  byzantineQuorum,
  ThresholdApprovalError,
  MultiPartyThresholdError,
  InMemoryThresholdApprovalStore,
  THRESHOLD_TOKEN_TTL_MS,
  type ThresholdApproval,
  type ThresholdApprovalStore,
  type MultiPartyThresholdConfig,
  type QuorumConfig,
  type ApprovalVote,
} from "./threshold-approval";

