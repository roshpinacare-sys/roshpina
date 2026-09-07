/**
 * lib/orchestrator/index.ts — barrel export for the Orchestrator spine.
 *
 * Public surface:
 *   • TfaOrchestrator — the main class (guard → execute → audit)
 *   • InMemoryAuditStore — reference AuditStore implementation
 *   • AuditError — error type thrown by the audit store
 *   • GuardEvaluator — standalone guard evaluator (for testing / composition)
 *   • allowAll, denyAll, denyFinancial, denyAutonomous, allowTypes — built-in policies
 *   • All types from types.ts
 */

export { TfaOrchestrator } from "./orchestrator.ts";
export { InMemoryAuditStore, AuditError } from "./audit.ts";
export type { AuditErrorCode } from "./audit.ts";
export {
  GuardEvaluator,
  allowAll,
  denyAll,
  denyFinancial,
  denyAutonomous,
  allowTypes,
} from "./guard.ts";
export {
  HmacSigner,
  Ed25519Signer,
  MlDsaStubSigner,
  MlDsaDeterministicProvider,
  HybridSigner,
  generateAuditKeyPair,
  SignerError,
  parseHybridSignature,
  createHybridSigner,
} from "./signer.ts";
export type { Ed25519KeyPair, SignerErrorCode } from "./signer.ts";
export { MlDsaOqsProvider, adaptPqcProvider } from "./pqc-adapter.ts";
export type { Uint8ArraySigner } from "./pqc-adapter.ts";
export {
  MlDsaCompiledProvider,
  MlDsaOqsClassProvider,
  wrapCompiledModule,
  isMlDsaCompiledModule,
  isOqsSignatureClass,
} from "./pqc-compiled-provider.ts";
export type {
  MlDsaCompiledModule,
  OqsSignatureClass,
  OqsSignatureInstance,
} from "./pqc-compiled-provider.ts";
export {
  tryLoadOqsModule,
  tryLoadWasmModule,
  tryLoadLocalProvider,
  tryLoadLocalProviderSync,
  resolveHybridMlDsaProvider,
  resolveHybridMlDsaProviderSync,
} from "./pqc-loader.ts";
export type { ResolveHybridOptions } from "./pqc-loader.ts";
export {
  MlDsaLocalProvider,
  createMlDsaLocalProvider,
  defaultLocalProvider,
} from "./pqc-local-provider.ts";
export type { MlDsaLocalProviderOptions } from "./pqc-local-provider.ts";
export type {
  ISOTimestamp,
  ActionId,
  AuditId,
  Action,
  ActionContext,
  ApprovalClass,
  GuardDecision,
  GuardPolicy,
  ActionExecutor,
  AuditOutcome,
  AuditRecord,
  AuditStore,
  AsyncAuditStore,
  OrchestrationResult,
  Orchestrator,
  Signer,
  ActionIntent,
  PrivacyLevel,
  ExecutionStatus,
  ExecutionLogEntry,
  ExecutionWorkflow,
  ExecutionStore,
  AsyncExecutionStore,
} from "./types.ts";
export {
  PRIVACY_LEVELS,
  validateActionIntent,
  canonicalActionIntent,
} from "./action-intent.ts";
export {
  InMemoryExecutionStore,
  ExecutionError,
  VALID_TRANSITIONS,
  VALID_TRANSITION_SET,
  TERMINAL_STATUSES,
  verifyRunLog,
  validateAllExecutionChains,
} from "./execution-workflow.ts";
export type { ExecutionErrorCode } from "./execution-workflow.ts";
export {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  shouldRetry,
  nextRetry,
  countFailures,
  planRetryForWorkflow,
} from "./retry-policy.ts";
export type { RetryPolicyConfig, RetryPlan } from "./retry-policy.ts";
export {
  superviseFailedWorkflow,
  DEFAULT_RETRY_LEASE_MS,
} from "./execution-supervisor.ts";
export type { SupervisorOutcome } from "./execution-supervisor.ts";
export {
  ExecutionScheduler,
  superviseFailedWorkflowAsync,
  countChainFailures,
  SCHEDULER_ACTOR,
  SCHEDULER_LEASE_MS,
} from "./execution-scheduler.ts";
export type { SchedulerOutcome, SchedulerStatus } from "./execution-scheduler.ts";
