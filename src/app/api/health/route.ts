/**
 * GET /api/health — פעימות-חיים של הקרנל (קריאה-בלבד, ללא-מוטציות).
 * מדווח: זריעה, kid (ציבורי), ספירות, שלמות-שרשרת-ביקורת, ראש-מרקל, עמלות-שנלכדו.
 */

import { NextResponse } from "next/server";
import { getKernel, TENANT } from "@/lib/kernel";
import { money } from "@/lib/serialize";
import { formatNis } from "@/lib/format";
import { selectCheapestVendor } from "@kernel/marketplace/cost-arbitrage";
import type { HealthResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FINANCIAL_ACTION_TYPES = new Set(["ledger.mint", "ledger.withdraw", "ledger.transfer"]);

export async function GET() {
  const k = getKernel();
  const T = TENANT;

  const accounts = await k.ledger.listAccounts(T);
  const chain = k.audit.getChain(T);
  const integrity = k.audit.verifyChain(T);
  const agreements = await k.escrowStore.list(T);
  const opportunities = await k.catalog.list(T);
  const head = chain.length > 0 ? chain[chain.length - 1] : null;
  const root = await k.transparency.currentRoot(T);
  const leaves = await k.transparency.leafCount(T);
  const roots = await k.transparency.getRoots(T);

  const byState: Record<string, number> = {};
  let tvl = 0n;
  let fees = 0n;
  let feeCount = 0;
  for (const a of agreements) {
    byState[a.state] = (byState[a.state] ?? 0) + 1;
    if (a.state === "funded" || a.state === "disputed") tvl += a.amount;
    if (a.feeAmount !== undefined) {
      fees += a.feeAmount;
      feeCount++;
    }
  }

  let arbitrageCount = 0;
  let totalSpread = 0n;
  for (const opp of opportunities) {
    const quotes = k.vendorQuotes.get(opp.id) ?? [];
    if (quotes.length >= 2) {
      // הפער הקרנלי: מנצח מול-המתחרה-הבא (תקרת-דמי-הניתוב) — אותו-פרימיטיב של השוק.
      try {
        const arb = selectCheapestVendor(quotes);
        totalSpread += arb.spreadMc;
        arbitrageCount++;
      } catch {
        // fail-closed: ציטוטים פגומים לא יפילו את-הפעימה.
      }
    }
  }

  const treasury = k.registry.treasuryId
    ? accounts.find((a) => a.id === k.registry.treasuryId) ?? null
    : null;

  const body: HealthResponse = {
    ok: true,
    seeded: k.seedState.seeded,
    seededAt: k.seedState.seededAt,
    kernel: "TFA Sovereign Trust-as-a-Service",
    kid: k.signer.kid,
    uptimeMs: Date.now() - k.bootedAt,
    counts: {
      accounts: accounts.length,
      financialOps: chain.filter((r) => FINANCIAL_ACTION_TYPES.has(r.actionType)).length,
      passports: k.passports.length,
      audit: { length: chain.length, integrity, headHash: head?.hash ?? null },
      transparency: { leaves, roots: roots.length, headRoot: root?.root ?? null },
      opportunities: opportunities.length,
    },
    escrow: {
      byState,
      totalValueLocked: money(tvl),
      feesCaptured: money(fees),
      feeCount,
    },
    treasuryBalance: treasury ? { raw: treasury.balance.toString(), display: formatNis(treasury.balance) } : null,
    arbitrage: {
      opportunitiesWithQuotes: arbitrageCount,
      totalSpread: money(totalSpread),
    },
  };

  return NextResponse.json(body);
}
