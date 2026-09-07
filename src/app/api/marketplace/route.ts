/**
 * GET /api/marketplace — הזדמנויות + ארביטראז'-עלויות (קריאה-בלבד).
 * על כל-הזדמנות: selectCheapestVendor על ציטוטי-הספק השמורים → מנצח, spread,
 * ודמי-ניתוב אפשריים (10% מה-spread — קרן-הרווח של ידיעת-המחיר).
 */

import { NextResponse } from "next/server";
import { getKernel, TENANT } from "@/lib/kernel";
import { money } from "@/lib/serialize";
import { selectCheapestVendor, routingFeeFromSpread } from "@kernel/marketplace/cost-arbitrage";
import type { MarketplaceResponse, MarketplaceOpportunityView } from "@/lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTING_FEE_NUMERATOR = 10n; // 10% מה-spread
const ROUTING_FEE_DENOMINATOR = 100n;

export async function GET() {
  const k = getKernel();
  const opportunities = await k.catalog.list(TENANT);
  opportunities.sort((a, b) => a.id.localeCompare(b.id));

  let totalSpread = 0n;
  const views: MarketplaceOpportunityView[] = [];

  for (const opp of opportunities) {
    const quotes = k.vendorQuotes.get(opp.id) ?? [];
    let winnerVendorId: string | null = null;
    let runnerUpVendorId: string | null = null;
    let spread: MarketplaceOpportunityView["spread"] = null;
    let routingFee: MarketplaceOpportunityView["routingFee"] = null;

    if (quotes.length >= 2) {
      try {
        const arb = selectCheapestVendor(quotes);
        winnerVendorId = arb.winner.vendorId;
        runnerUpVendorId = arb.runnerUp?.vendorId ?? null;
        spread = money(arb.spreadMc);
        routingFee = money(routingFeeFromSpread(arb.spreadMc, ROUTING_FEE_NUMERATOR, ROUTING_FEE_DENOMINATOR));
        totalSpread += arb.spreadMc;
      } catch {
        // fail-closed: ציטוטים פגומים לא יפילו את-הראוט — ההזדמנות תוצג ללא-ארביטראז'.
      }
    }

    views.push({
      id: opp.id,
      title: opp.title,
      description: opp.description,
      requiredStrengths: opp.requiredStrengths.map((r) => ({ category: r.category, minScore: r.minScore })),
      budget: opp.budget !== undefined ? money(opp.budget) : null,
      quotes: quotes.map((q) => ({ vendorId: q.vendorId, cost: money(q.estimatedCostMc) })),
      winnerVendorId,
      runnerUpVendorId,
      spread,
      routingFee,
    });
  }

  const body: MarketplaceResponse = {
    opportunities: views,
    totalSpread: money(totalSpread),
  };
  return NextResponse.json(body);
}
