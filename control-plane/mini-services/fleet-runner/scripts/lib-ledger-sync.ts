/**
 * lib-ledger-sync.ts — pure settlement math for ledger-sync (imported by the
 * live script AND by the golden probe; zero I/O, zero side effects).
 *
 * THE UNIT LAW (live defect 2026-10-21, measured from journal + /state):
 *   the market node's /economy/report returns balances as RAW micro-cent
 *   integer strings (e.g. "49995100" = 4,999.5100 USDS at 10,000 µ¢/USDS).
 *   parseMicroCents() is built for DECIMAL USDS strings ("4999.5100") and
 *   silently accepts a bare integer too — treating "49995100" as 49,995,100
 *   USDS = ×10,000 inflation. The bug hid for eras because BOTH sides of the
 *   delta equation were inflated identically; the fresh zero-mirrors of the
 *   mm desks unmasked it (settled +49,995,100 USDS mirrors from a 4,999.5944
 *   µ¢ truth; feeDelta +14,431 USDS bounced on a 13,897 USDS pool).
 *   parseMarketMicroCents() parses the market side in TRUE µ¢ — the book then
 *   converges down to the live economy exactly (the designed end state).
 *
 * THE FLOOR LAW (settlement must never crash-loop):
 *   a settle is capped at the source account's available balance; the
 *   residual stays an honest, loudly-logged drift for the next round —
 *   settlement timing, never a lie (sync law 4), never a bounce.
 */

export interface MarketReport {
  conservation: { quote: { holds: boolean; minted: string; inEscrow: string; fees: string }; base: { holds: boolean; minted: string; inEscrow: string } };
  settledTrades: number;
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string; saos: string; saosLocked: string; fills: number }[];
}

export interface LedgerAccount { id: string; ownerId: string; type: string; name: string; balance: string; balanceDecimal: string }

export interface Delta { owner: string; cur: "usds" | "saos"; delta: bigint; fromPool: boolean }

/** Parse a market-node balance/amount field into true micro-cents.
 *  Raw integer form ("146371") is the native wire format: µ¢ as-is.
 *  Decimal form ("14.6371") is accepted defensively and scaled ×10⁴. */
export function parseMarketMicroCents(s: string): bigint {
  if (typeof s === "string" && /^\d+$/.test(s)) return BigInt(s);
  if (typeof s === "string" && /^\d+(\.\d{1,4})?$/.test(s)) {
    const [int, frac = ""] = s.split(".");
    const frac4 = (frac + "0000").slice(0, 4);
    return BigInt(int) * 10000n + BigInt(frac4);
  }
  throw new Error(`market amount must be a raw µ¢ integer or a ≤4-fraction decimal (got ${JSON.stringify(s)})`);
}

/** The book's claim model: an agent's TOTAL market claim = free + order-escrow
 *  + staked (stake lives on the market engine; the mirror represents it all).
 *  All inputs are market wire fields (raw µ¢) — parsed at true scale. */
export function agentMarketTotal(a: MarketReport["agents"][number], cur: "usds" | "saos"): bigint {
  return cur === "usds"
    ? parseMarketMicroCents(a.usds) + parseMarketMicroCents(a.usdsLocked) + parseMarketMicroCents(a.usdsStaked ?? "0")
    : parseMarketMicroCents(a.saos) + parseMarketMicroCents(a.saosLocked);
}

/** Δ between the live market truth and the book's mirrors — the ONLY thing
 *  settlement is allowed to move. Never accumulated locally: recomputed
 *  against fresh truths every round. */
export function computeDeltas(market: MarketReport, byOwner: Map<string, LedgerAccount>): Delta[] {
  const deltas: Delta[] = [];
  for (const a of market.agents) {
    for (const cur of ["usds", "saos"] as const) {
      const marketTotal = agentMarketTotal(a, cur);
      const mirror = BigInt(byOwner.get(`agent:${a.agentId}:${cur}`)?.balance ?? "0");
      const delta = marketTotal - mirror;
      if (delta !== 0n) deltas.push({ owner: `agent:${a.agentId}:${cur}`, cur, delta, fromPool: delta > 0n });
    }
  }
  const feeDelta = parseMarketMicroCents(market.conservation.quote.fees) - BigInt(byOwner.get("fees:usds")?.balance ?? "0");
  if (feeDelta > 0n) deltas.push({ owner: "fees:usds", cur: "usds", delta: feeDelta, fromPool: true });
  if (feeDelta < 0n) deltas.push({ owner: "fees:usds", cur: "usds", delta: feeDelta, fromPool: false }); // treasury paid out — settle down honestly
  return deltas;
}

export interface SettlePlan {
  owner: string; cur: "usds" | "saos";
  delta: bigint; // signed original delta (audit trail for memos/idem keys)
  fromOwnerId: string; toOwnerId: string;
  requested: bigint; amount: bigint; capped: boolean;
}

/** Order negatives first (they refill the pool so positives can never bounce),
 *  then cap every settle at the source's available balance (floor law).
 *  `balances` is mutated: the caller starts it from the round's fresh /state
 *  and the plan reflects mints the caller applies between rounds. Skipped
 *  deltas (source empty) come back as residual drift — honest, loud, retried
 *  next round against fresh truth. */
export function planSettlements(
  deltas: Delta[],
  byOwner: Map<string, LedgerAccount>,
  balances: Map<string, bigint>,
): { plans: SettlePlan[]; skipped: Delta[] } {
  const plans: SettlePlan[] = [];
  const skipped: Delta[] = [];
  const ordered = [...deltas].sort((a, b) => (a.delta < 0n ? -1 : b.delta < 0n ? 1 : 0));
  for (const d of ordered) {
    const fromOwner = d.fromPool ? `pool:${d.cur}` : d.owner;
    const toOwner = d.fromPool ? d.owner : `pool:${d.cur}`;
    const from = byOwner.get(fromOwner);
    const to = byOwner.get(toOwner);
    if (!from?.id || !to?.id) throw new Error(`accounts missing for ${d.owner} (${d.cur})`);
    const requested = d.delta < 0n ? -d.delta : d.delta;
    const available = balances.get(from.id) ?? 0n;
    if (available <= 0n) { skipped.push(d); continue; }
    const amount = requested <= available ? requested : available;
    const capped = amount < requested;
    balances.set(from.id, (balances.get(from.id) ?? 0n) - amount);
    balances.set(to.id, (balances.get(to.id) ?? 0n) + amount);
    plans.push({ owner: d.owner, cur: d.cur, delta: d.delta, fromOwnerId: from.id, toOwnerId: to.id, requested, amount, capped });
  }
  return { plans, skipped };
}
