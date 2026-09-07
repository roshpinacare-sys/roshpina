/**
 * api-types.ts — חוזי-ה-API של רושפינה (משותפים לשרת וללקוח).
 * כסף חוצה את הגבול תמיד כ-STRING של ספרות µ¢ — לעולם לא מספר-JSON.
 * שדות display מחושבים בשרת (µ¢ ÷ 1_000_000 → "₪1,234.56").
 */

export interface MoneyView {
  /** µ¢ כמחרוזת-ספרות (BigInt בצד-השרת). */
  raw: string;
  /** תצוגה פורמטית "₪1,234.56". */
  display: string;
}

export interface AccountView {
  id: string;
  name: string;
  ownerId: string;
  type: string;
  role: "treasury" | "worker" | "client" | "platform" | "other";
  balance: MoneyView;
  balanceMc: string;
  createdAt: string;
}

export interface LedgerTxView {
  id: string;
  kind: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: MoneyView;
  memo: string;
  initiatedBy: string;
  createdAt: string;
}

export interface HealthResponse {
  ok: boolean;
  seeded: boolean;
  seededAt: string | null;
  kernel: string;
  kid: string;
  uptimeMs: number;
  counts: {
    accounts: number;
    financialOps: number;
    passports: number;
    audit: { length: number; integrity: boolean; headHash: string | null };
    transparency: { leaves: number; roots: number; headRoot: string | null };
    opportunities: number;
  };
  escrow: {
    byState: Record<string, number>;
    totalValueLocked: MoneyView;
    feesCaptured: MoneyView;
    feeCount: number;
  };
  treasuryBalance: MoneyView | null;
  arbitrage: {
    opportunitiesWithQuotes: number;
    totalSpread: MoneyView;
  };
}

export interface EscrowAgreementView {
  id: string;
  opportunityId: string;
  payerAccountId: string;
  workerAccountId: string;
  escrowAccountId: string;
  amount: MoneyView;
  state: string;
  createdAt: string;
  fundedBy: string | null;
  feeBasisPoints: number | null;
  feeAmount: MoneyView | null;
  disputeReason: string | null;
}

export interface EscrowResponse {
  agreements: EscrowAgreementView[];
  feeStats: {
    totalFeeCaptured: MoneyView;
    feeCount: number;
    byState: Record<string, number>;
  };
}

export interface EscrowActionResponse {
  ok: boolean;
  agreement?: EscrowAgreementView;
  reason?: string;
}

export interface VendorQuoteView {
  vendorId: string;
  cost: MoneyView;
}

export interface MarketplaceOpportunityView {
  id: string;
  title: string;
  description: string;
  requiredStrengths: Array<{ category: string; minScore: number }>;
  budget: MoneyView | null;
  quotes: VendorQuoteView[];
  winnerVendorId: string | null;
  runnerUpVendorId: string | null;
  spread: MoneyView | null;
  routingFee: MoneyView | null;
}

export interface MarketplaceResponse {
  opportunities: MarketplaceOpportunityView[];
  totalSpread: MoneyView;
}

export interface PassportView {
  passportId: string;
  kid: string | null;
  algorithm: string;
  issuedAt: string;
  actionType: string;
  outcome: string;
  auditId: string;
  source: string;
  ledger: { kind: string; amount: MoneyView; memo: string } | null;
}

export interface PassportsResponse {
  passports: PassportView[];
  total: number;
}

export interface PassportVerifyCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  message?: string;
}

export interface PassportVerifyResponse {
  ok: boolean;
  checks: PassportVerifyCheck[];
}

export interface AuditRecordView {
  id: string;
  actionType: string;
  source: string;
  outcome: string;
  reason: string | null;
  occurredAt: string;
  prevHash: string;
  hash: string;
  signed: boolean;
}

export interface AuditResponse {
  tenantId: string;
  records: AuditRecordView[];
  headHash: string | null;
  height: number;
  integrity: boolean;
  brokenAt: number | null;
}

export interface PotentialWorkerView {
  userId: string;
  displayName: string;
  strengths: Array<{ category: string; score: number; confidence: number; evidence: string[] }>;
  matches: Array<{
    opportunityId: string;
    title: string;
    fitScore: number;
    matchedStrengths: string[];
    missingStrengths: Array<{ category: string; gap: number }>;
    budget: MoneyView | null;
  }>;
  escrowSuggestion: {
    opportunityId: string;
    title: string;
    fitScore: number;
    budget: MoneyView;
  } | null;
}

export interface PotentialResponse {
  generatedAt: string | null;
  workers: PotentialWorkerView[];
}

export interface BridgeAnchorPayload {
  protocol: "saos:anchor/v1";
  action: "roshpina-anchor";
  tenantId: string;
  headHash: string;
  height: number;
  at: string;
}

export interface BridgeStatusResponse {
  seam: string;
  head: { tenantId: string; headHash: string; height: number } | null;
  integrity: boolean;
  pendingAnchors: number;
  lastPending: BridgeAnchorPayload | null;
  lastAnchoredAt: string | null;
}

export interface BridgeAnchorResponse {
  ok: boolean;
  payload: BridgeAnchorPayload;
  pendingAnchors: number;
}

/** תשובת-שגיאה אחידה וכנה. */
export interface ApiError {
  ok: false;
  error: string;
  reason?: string;
}
