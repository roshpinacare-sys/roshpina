/**
 * lib/marketplace/index.ts — barrel export.
 *
 * Usage:
 *   import { InMemoryOpportunityCatalog, MARKETPLACE_ACTION_TYPES } from "../lib/marketplace/index";
 *   import type { OpportunityCatalog, OpportunityInput, MarketplaceError } from "../lib/marketplace/index";
 */
export type {
  OpportunityCatalog,
  OpportunityInput,
  MarketplaceActionType,
  MarketplaceErrorCode,
} from "./types";
export {
  MARKETPLACE_ACTION_TYPES,
  DEFAULT_CLAIM_FEE_MC,
  DEFAULT_LISTING_FEE_MC,
  MarketplaceError,
} from "./types";
export { InMemoryOpportunityCatalog } from "./catalog";
export {
  selectCheapestVendor,
  routingFeeFromSpread,
  ArbitrageError,
  type VendorQuote,
  type ArbitrageResult,
  type ArbitrageErrorCode,
} from "./cost-arbitrage";
