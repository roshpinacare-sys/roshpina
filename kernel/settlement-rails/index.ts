/**
 * lib/settlement-rails/index.ts — SettlementRail barrel export.
 */

export type {
  MicroCents,
  DisbursementRequest,
  DisbursementResult,
  DisbursementStatus,
  SettlementRail,
  RailRegistry,
  SettlementRailErrorCode,
} from "./types";

export { SettlementRailError } from "./types";

export {
  ManualSettlementRail,
  InMemoryRailRegistry,
  type ManualRailConfig,
  type ManualDisbursementRecord,
} from "./manual-rail";
