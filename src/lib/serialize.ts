/**
 * serialize.ts — המרות-סריאליזציה ל-API: BigInt µ¢ → מחרוזות + תצוגות.
 * הכלל: כסף עובר את גבול-ה-API כמחרוזת-ספרות, לעולם לא מספר-JSON.
 */

import { formatNis } from "./format";
import type { MoneyView, EscrowAgreementView } from "./api-types";
import type { EscrowAgreement } from "@kernel/escrow/types";
import type { Account } from "@kernel/ledger/types";
import { getKernel } from "./kernel";

/** µ¢ → תצוגת-כסף (גולמי + פורמט ₪). */
export function money(mc: bigint): MoneyView {
  return { raw: mc.toString(), display: formatNis(mc) };
}

/** תפקיד-חשבון לתצוגה (לפי רישום-הזריעה + חשבון-עמלות-הפלטפורמה). */
export function accountRole(account: Account): "treasury" | "worker" | "client" | "platform" | "other" {
  const k = getKernel();
  if (account.id === k.registry.treasuryId) return "treasury";
  if (Object.values(k.registry.workerIds).includes(account.id)) return "worker";
  if (Object.values(k.registry.clientIds).includes(account.id)) return "client";
  if (account.ownerId === "platform") return "platform";
  return "other";
}

export function serializeAccount(account: Account) {
  return {
    id: account.id,
    name: account.name,
    ownerId: account.ownerId,
    type: account.type,
    role: accountRole(account),
    balance: money(account.balance),
    balanceMc: account.balance.toString(),
    createdAt: account.createdAt,
  };
}

export function serializeAgreement(a: EscrowAgreement): EscrowAgreementView {
  return {
    id: a.id,
    opportunityId: a.opportunityId,
    payerAccountId: a.payerAccountId,
    workerAccountId: a.workerAccountId,
    escrowAccountId: a.escrowAccountId,
    amount: money(a.amount),
    state: a.state,
    createdAt: a.createdAt,
    fundedBy: a.fundedBy ?? null,
    feeBasisPoints: a.feeBasisPoints ?? null,
    feeAmount: a.feeAmount !== undefined ? money(a.feeAmount) : null,
    disputeReason: a.disputeReason ?? null,
  };
}
