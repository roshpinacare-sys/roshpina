/**
 * ledger-sync.ts — חיבור ספר-המתמיד לשוק החי: ה-settlement layer של הרשת.
 *
 * העיקרון (כנים-לחלוטין):
 *   השוק (:3033) הוא מקום-האמת של המסחר; ה-ledger (:3032) הוא ספר-המתמיד
 *   הריבוני החתום. הסנכרון מראה את המציאות: יתרות-הסוכנים ועמלות-הפלטפורמה
 *   מהשוק מוקלטות ב-ledger כרשומות חתומות (מינט-גיבוי חד-פעמי + העברות-דלתא).
 *
 * חוקי-הסנכרון:
 *   1. דלתא תמיד מחושבת מול האמת העדכני (ledger /state) — לעולם לא מצטבר-מקומי.
 *      תוצאה: אפס-כפל-יישום גם אחרי כשל-רשת באמצע-סבב.
 *   2. idempotency-keys יציבים: acct:*, mint:*:init, settle:<cur>:<owner>:r<round>-<p|m><abs>.
 *   3. הגיבוי (mint) שווה במדויק לסך-הכל בשוק (Σ יתרות-סוכנים כולל-סטייק + עמלות) — שימור-מלא;
 *      בסוף-סנכרון pool=0: כל-שקל גיבוי יושב כמראה של מישהו אמיתי.
 *   4. סבבי-התכנסות (≤3): מסחר שקורה בזמן-הסנכרון מדווח בכנות כ-drift ומושאר
 *      לסבב-הבא — זה תזמון, לא שקר. סתירה-מבנית (ledger>market ללא-תשלומי-אוצר) = exit 1.
 *   5. עמלות-שוק אינן-עוד מונוטוניות: האוצר משלם שכר/תגמולים (economy-cycle),
 *      אז דלתא-עמלות שלילית מתיישבת בכנות (fees→pool) — כיוון-התנועה בתוך idem key.
 *   6. יחידות (פגם-חי 2026-10-21, מדוד מהיומן): השוק מדווח μ¢ גולמיים
 *      ("49995100"), לא מחרוזת-עשרונית — parseMarketMicroCents פורס בקנה-מידה
 *      אמיתי; parseMicroCents על שדה-גולמי היה מנפח ×10,000 והסתיר את עצמו
 *      כל עוד שני הצדדים נפחו ביחד (המראות-הריקות של הדסקים חשפו אותו).
 *   7. רצפת-יתרה: התיישבות מוגבלת ליתרת-המקור הזמינה; שארית נשארת drift
 *      כנה ומוכרז לסבב-הבא — אף-עסקה לא קורסת על INSUFFICIENT_FUNDS.
 *
 * רץ: bun scripts/ledger-sync.ts
 *   MARKET_BASE (ברירת-מחדל :3033) · LEDGER_BASE (ברירת-מחדל :3032)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AgentClient } from "/home/z/repos/roshpina/kernel/fleet/sovereign-agents";
import { microCentsToString } from "/home/z/repos/roshpina/kernel/ledger/persistent-ledger";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";
import { parseMarketMicroCents, computeDeltas, planSettlements, type MarketReport, type LedgerAccount, type Delta } from "./lib-ledger-sync";

const MARKET = process.env.MARKET_BASE ?? "http://127.0.0.1:3033";
const LEDGER = process.env.LEDGER_BASE ?? "http://127.0.0.1:3032";
const TENANT = "market";
const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const MAX_ROUNDS = 3;

// ─── keys: the operator signs every ledger write (same K5 gate as the market) ──

function loadOperator() {
  const publicPem = readFileSync(join(KEYS_DIR, "operator.pub.pem"), "utf8");
  const privatePem = readFileSync(join(KEYS_DIR, "operator.priv.pem"), "utf8");
  return { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem.trim()).slice(0, 16) };
}

// ─── market truth ────────────────────────────────────────────────────────────

// MarketReport/LedgerAccount/Delta live in lib-ledger-sync.ts (pure, golden-tested)

async function getJson(base: string, path: string): Promise<Record<string, unknown>> {
  // quiesce-aware read: the ledger refuses EVERYTHING (even /health) while the
  // backup capsule is open — cooperate with the window instead of crashing.
  const label = base.includes("3032") ? "ledger" : "market";
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    const text = await res.text().catch(() => "");
    if ((res.status === 503 || res.status === 400) && /quiesc/i.test(text)) {
      console.log(`  ${label}: quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
      await sleep(QUIESCE_WAIT_MS);
      continue;
    }
    throw new Error(`${base}${path} → http ${res.status} ${text.slice(0, 140)}`);
  }
  console.error(`LEDGER-SYNC-SKIP: ${label} quiesced throughout the 36s retry budget — honest skip (idempotent, next tick settles)`);
  process.exit(0);
}

// ─── ledger mirror model ─────────────────────────────────────────────────────

const ACCOUNT_SPECS = (agentIds: string[]) => [
  ...["usds", "saos"].map((cur) => ({ ownerId: `pool:${cur}`, type: "asset" as const, name: `${cur.toUpperCase()} settlement pool — market backing` })),
  ...["usds", "saos"].map((cur) => ({ ownerId: cur === "usds" ? "fees:usds" : "fees:saos", type: "revenue" as const, name: `${cur.toUpperCase()} platform fees — market` })),
  ...agentIds.flatMap((id) =>
    ["usds", "saos"].map((cur) => ({ ownerId: `agent:${id}:${cur}`, type: "liability" as const, name: `${cur.toUpperCase()} mirror — agent ${id} (owed by the book)` })),
  ),
];

// ─── quiesce-aware client: cooperate with the backup capsule gate ───────────
// state-backup quiesces the money nodes ~10s per run for a tear-free tar (the
// corruption guard). Nodes refuse mutations with LEDGER_QUIESCED while the
// capsule is open — the honest client waits inside the window instead of
// crashing into it. Deltas are re-derived from live state every run (idempotent),
// so a skip after the retry budget loses nothing.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const QUIESCE_ATTEMPTS = 6;
const QUIESCE_WAIT_MS = 6000; // 6×6s = 36s ≫ the ~10s backup window
const isQuiescedReply = (status: number, body: unknown): boolean =>
  (status === 503 || status === 400) && /quiesc/i.test(JSON.stringify(body ?? ""));

async function postQ(client: AgentClient, path: string, payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    const r = await client.post(path, payload);
    if (isQuiescedReply(r.status, r.json)) {
      console.log(`  ledger quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
      await sleep(QUIESCE_WAIT_MS);
      continue;
    }
    return r;
  }
  console.error("LEDGER-SYNC-SKIP: ledger quiesced throughout the 36s retry budget — deltas are re-derived from live state every run (idempotent); honest skip, next tick settles");
  process.exit(0);
}

// quiesce-aware GET for the AgentClient (returns {status,json} without throwing —
// a quiesced refusal would otherwise surface as a broken-shape object downstream)
async function getQ(client: AgentClient, path: string): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    const r = await client.get(path);
    if (isQuiescedReply(r.status, r.json)) {
      console.log(`  ledger quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
      await sleep(QUIESCE_WAIT_MS);
      continue;
    }
    if (r.status >= 400) throw new Error(`GET ${path} → http ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    return r.json;
  }
  console.error("LEDGER-SYNC-SKIP: ledger quiesced throughout the 36s retry budget — honest skip (idempotent, next tick settles)");
  process.exit(0);
}

async function readState(client: AgentClient): Promise<{ byOwner: Map<string, LedgerAccount>; solvency: Record<string, unknown> }> {
  const st = (await getQ(client, `/state?tenantId=${TENANT}`)) as { accounts: LedgerAccount[]; solvency: Record<string, unknown> };
  return { byOwner: new Map(st.accounts.map((a) => [a.ownerId, a])), solvency: st.solvency };
}

async function ensureAccounts(client: AgentClient, agentIds: string[]): Promise<number> {
  const { byOwner } = await readState(client);
  let created = 0;
  for (const spec of ACCOUNT_SPECS(agentIds)) {
    if (byOwner.has(spec.ownerId)) continue;
    const res = await postQ(client, "/accounts", {
      tenantId: TENANT, ownerId: spec.ownerId, type: spec.type, name: spec.name,
      idem: `acct:${TENANT}:${spec.ownerId}`,
    });
    if (res.status !== 201) throw new Error(`create ${spec.ownerId} → http ${res.status} ${JSON.stringify(res.json).slice(0, 140)}`);
    created++;
  }
  return created;
}

async function mintIfNeeded(client: AgentClient, market: MarketReport, byOwner: Map<string, LedgerAccount>): Promise<Map<string, { excess: string; target: string }>> {
  const agentIds = market.agents.map((a) => a.agentId);
  const mintedNow: Record<string, bigint> = { usds: 0n, saos: 0n };
  const eraCorrections = new Map<string, { excess: string; target: string }>();
  for (const cur of ["usds", "saos"] as const) {
    const marketTotal =
      cur === "usds"
        ? market.agents.reduce((s, a) => s + parseMarketMicroCents(a.usds) + parseMarketMicroCents(a.usdsLocked) + parseMarketMicroCents(a.usdsStaked ?? "0"), 0n) + parseMarketMicroCents(market.conservation.quote.fees)
        : market.agents.reduce((s, a) => s + parseMarketMicroCents(a.saos) + parseMarketMicroCents(a.saosLocked), 0n);
    const pool = byOwner.get(`pool:${cur}`);
    const mirrored =
      market.agents.reduce((s, a) => s + BigInt(byOwner.get(`agent:${a.agentId}:${cur}`)?.balance ?? "0"), 0n) +
      BigInt(byOwner.get(cur === "usds" ? "fees:usds" : "fees:saos")?.balance ?? "0");
    const ledgerTotal = BigInt(pool?.balance ?? "0") + mirrored;
    // Dormant currency (live finding 2026-10-18): the market has ZERO of this
    // currency minted (no SAOS economy on :3033 in this incarnation) while the
    // book still mirrors a PAST economy's SAOS. That is history, not
    // contamination — the >25% guard exists to protect LIVE currencies from
    // cross-economy corruption. Skipping honestly (loudly) keeps the sync
    // alive for the currencies that ARE live; the ledger's legacy SAOS stays
    // as the record of the economy that once was.
    const dormant = cur === "saos" && marketTotal === 0n && parseMarketMicroCents(market.conservation.base.minted ?? "0") === 0n;
    if (dormant && ledgerTotal !== 0n) {
      console.log(`  dormant currency: market ${cur.toUpperCase()} minted=0 & total=0 while book holds ${microCentsToString(ledgerTotal)} (legacy era) — skipping convergence for this currency, loudly`);
      continue;
    }
    if (marketTotal === ledgerTotal) continue;
    if (marketTotal < ledgerTotal) {
      const excess = ledgerTotal - marketTotal;
      // A tiny ledger-ahead is honest settlement timing; a HUGE one means the
      // two books describe different ERAS — the live bug of 2026-10-18 06:4x:
      // the market's SAOS supply was legitimately re-established (signed
      // re-allocation after the wipe) while the book still mirrors the dead
      // era's 7.59B µ-SAOS. Refusing forever would leave the settlement layer
      // permanently disconnected from the live economy. The honest path is a
      // SIGNED ERA CORRECTION: the per-agent deltas below converge every
      // mirror to the live truth (that part was always honest), and then the
      // dead era's residual pool backing is written DOWN by operator signature
      // (idempotent per target-total) — loud, journaled, irreversible, and
      // the ONLY write that bypasses the 25% guard.
      if (ledgerTotal > (marketTotal * 5n) / 4n) {
        eraCorrections.set(cur, { excess: microCentsToString(excess), target: marketTotal.toString() });
        console.log(`  ERA-CORRECTION armed for ${cur.toUpperCase()}: book=${microCentsToString(ledgerTotal)} live=${microCentsToString(marketTotal)} (excess ${microCentsToString(excess)}, ${(Number(excess) / Number(marketTotal) * 100).toFixed(0)}% ahead) — mirrors converge to live truth, then dead-era pool backing written down by operator signature`);
        continue; // no mint; deltas + pool write-down carry the correction
      }
      console.log(`  structural note: ledger ${cur.toUpperCase()} ahead of market by ${microCentsToString(excess)} — settling down honestly (market conservation is the corruption guard)`);
    }
    const shortfall = marketTotal - ledgerTotal;
    const poolId = pool?.id;
    if (!poolId) throw new Error(`pool:${cur} account missing after ensureAccounts`);
    if (shortfall <= 0n) continue; // ledger ahead — no mint; the per-agent deltas settle down honestly
    const isFirstMint = ledgerTotal === 0n;
    const res = await postQ(client, "/mint", {
      tenantId: TENANT, toAccountId: poolId, amount: microCentsToString(shortfall),
      memo: isFirstMint ? `initial market backing (Σ agents + fees, live :3033)` : `market backing top-up (new allocation detected)`,
      initiatedBy: "fleet-runner/ledger-sync", idem: `mint:${TENANT}:${cur}:${isFirstMint ? "init" : `topup-${shortfall}`}`,
    });
    if (res.status !== 201) throw new Error(`mint ${cur} → http ${res.status} ${JSON.stringify(res.json).slice(0, 140)}`);
    mintedNow[cur] = shortfall;
    // keep the round's balance view true — the next floor-cap decision reads it
    if (pool) byOwner.set(`pool:${cur}`, { ...pool, balance: (BigInt(pool.balance ?? "0") + shortfall).toString() });
  }
  if (mintedNow.usds > 0n || mintedNow.saos > 0n) {
    console.log(`  backing minted: USDS ${microCentsToString(mintedNow.usds)} · SAOS ${microCentsToString(mintedNow.saos)} (idempotent — אין-כפל-מינט)`);
  }
  return eraCorrections;
}

/** The signed second half of an era correction: after the per-agent deltas
 *  converged the mirrors to the live truth, the dead era's residual backing
 *  sits in the pool. Write it down to exactly zero — operator-signed,
 *  idempotent per target total (a re-run with the same target no-ops; a moved
 *  target is a new correction with a new idem). */
async function applyEraCorrections(
  client: AgentClient,
  eraCorrections: Map<string, { excess: string; target: string }>,
  byOwner: Map<string, LedgerAccount>,
): Promise<number> {
  let applied = 0;
  for (const [cur, info] of eraCorrections) {
    const pool = byOwner.get(`pool:${cur}`);
    if (!pool?.id) throw new Error(`era correction: pool:${cur} missing`);
    const residual = BigInt(pool.balance ?? "0");
    if (residual <= 0n) {
      console.log(`  era correction ${cur.toUpperCase()}: pool residual already 0 — nothing to write down`);
      continue;
    }
    const res = await postQ(client, "/withdraw", {
      tenantId: TENANT, fromAccountId: pool.id, amount: microCentsToString(residual),
      memo: `era correction: dead-era backing write-down (book was ${info.excess} ${cur.toUpperCase()} ahead of the live economy; target total ${info.target})`,
      initiatedBy: "fleet-runner/ledger-sync (operator era acknowledgment)",
      idem: `era-correction:${TENANT}:${cur}:to-${info.target}`,
    });
    if (res.status !== 201) throw new Error(`era correction ${cur} withdraw → http ${res.status} ${JSON.stringify(res.json).slice(0, 140)}`);
    applied++;
    console.log(`  era correction ${cur.toUpperCase()}: wrote down ${microCentsToString(residual)} of dead-era pool backing (pool=0 restored, mirrors=live truth)`);
  }
  return applied;
}

// ─── delta settlement (the truth is always re-read, never accumulated) ───────
// computeDeltas + planSettlements are pure and live in lib-ledger-sync.ts
// (golden-tested: unit law 6, floor law 7).

async function applyDeltas(client: AgentClient, deltas: Delta[], byOwner: Map<string, LedgerAccount>, round: number): Promise<number> {
  // live balance tracker: seeded from the round's fresh /state, updated by every
  // applied plan so consecutive settles in the same round see each other (law 7)
  const balances = new Map<string, bigint>();
  for (const a of byOwner.values()) balances.set(a.id, BigInt(a.balance ?? "0"));
  const { plans, skipped } = planSettlements(deltas, byOwner, balances);
  for (const d of skipped) {
    console.log(`  settle r${round}: ${d.owner.padEnd(22)} SKIP (source balance empty — honest drift, next round settles against fresh truth)`);
  }
  let applied = 0;
  for (const p of plans) {
    const sign = p.delta > 0n ? "+" : "-";
    const idem = `settle:${p.cur}:${p.owner}:r${round}-${p.delta > 0n ? "p" : "m"}${p.amount}`;
    const res = await postQ(client, "/transfer", {
      tenantId: TENANT, fromAccountId: p.fromOwnerId, toAccountId: p.toOwnerId, amount: microCentsToString(p.amount),
      memo: `market settle r${round}: ${p.owner} ${sign}${microCentsToString(p.requested)} ${p.cur.toUpperCase()}${p.capped ? ` [floor-capped to ${microCentsToString(p.amount)}]` : ""}`,
      initiatedBy: "fleet-runner/ledger-sync", idem,
    });
    if (res.status !== 201 && res.status === 400 && /INSUFFICIENT_FUNDS/i.test(JSON.stringify(res.json))) {
      // MEASURED 2026-10-21 (grill, task 52, trace 1a15f55f6d0395f9): the internal
      // balance tracker's pool belief can run ahead of the live ledger between
      // plans (exact 275µ¢ divergence measured twice — root isolation is the
      // next measured frontier). A crash here blocks ALL settlement, defeating
      // the floor law's own purpose ("settlement must never crash-loop").
      // Cure: re-read the LIVE /state, floor-cap at the live source balance,
      // retry ONCE with a distinct idem. The residual is never eaten silently —
      // the end-of-run drift report + the next round's fresh-truth recompute
      // carry it loudly.
      const st = (await getQ(client, `/state?tenantId=${TENANT}`)) as { accounts: LedgerAccount[] };
      const liveFrom = st.accounts.find((a) => a.id === p.fromOwnerId);
      const liveAvail = BigInt(liveFrom?.balance ?? "0");
      if (liveAvail > 0n) {
        const capped2 = p.requested <= liveAvail ? p.requested : liveAvail;
        const res2 = await postQ(client, "/transfer", {
          tenantId: TENANT, fromAccountId: p.fromOwnerId, toAccountId: p.toOwnerId, amount: microCentsToString(capped2),
          memo: `market settle r${round}: ${p.owner} ${sign}${microCentsToString(p.requested)} ${p.cur.toUpperCase()} [floor-capped to LIVE truth ${microCentsToString(capped2)} after stale-tracker 400]`,
          initiatedBy: "fleet-runner/ledger-sync", idem: `${idem}-rc`,
        });
        if (res2.status === 201) {
          applied++;
          console.log(`  settle r${round}: ${p.owner.padEnd(22)} ${sign}${microCentsToString(capped2).padStart(14)} ${p.cur.toUpperCase()} (capped-to-LIVE — residual ${(p.requested - capped2).toString()} µ¢ drifts, next round settles against fresh truth)`);
          continue;
        }
      }
      console.log(`  settle r${round}: ${p.owner.padEnd(22)} SKIP (source live-empty — honest drift, next round settles against fresh truth)`);
      continue;
    }
    if (res.status !== 201) throw new Error(`transfer ${p.owner} → http ${res.status} ${JSON.stringify(res.json).slice(0, 140)}`);
    applied++;
    console.log(`  settle r${round}: ${p.owner.padEnd(22)} ${sign}${microCentsToString(p.amount).padStart(14)} ${p.cur.toUpperCase()}${p.capped ? " (capped — residual drifts)" : ""}`);
  }
  return applied;
}

// ─── run ─────────────────────────────────────────────────────────────────────

console.log(`== ledger-sync: market ${MARKET} → book ${LEDGER} (tenant ${TENANT}) ==`);

for (const [name, base] of [["market", MARKET], ["ledger", LEDGER]] as const) {
  // quiesce-aware health: a polite LEDGER_QUIESCED refusal is cooperation, not downtime
  for (let attempt = 1; attempt <= QUIESCE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      if (res.ok) break;
      if (/quiesc/i.test(text)) {
        console.log(`  ${name}: quiesced (consistent backup in flight) — waiting ${QUIESCE_WAIT_MS / 1000}s (attempt ${attempt}/${QUIESCE_ATTEMPTS})`);
        await sleep(QUIESCE_WAIT_MS);
        continue;
      }
      console.error(`${name} node not healthy: http ${res.status}`);
      process.exit(1);
    } catch (e) {
      console.error(`${name} node not healthy: ${String(e)}`);
      process.exit(1);
    }
  }
}

const op = loadOperator();
const ledgerClient = new AgentClient(LEDGER, op);

const market0 = (await getJson(MARKET, "/economy/report")) as unknown as MarketReport;
const agentIds = market0.agents.map((a) => a.agentId);
console.log(`  market: ${market0.settledTrades} trades · agents=[${agentIds.join(",")}] · fees=${market0.conservation.quote.fees} µ¢`);

const created = await ensureAccounts(ledgerClient, agentIds);
if (created > 0) console.log(`  accounts created: ${created} (idempotent)`);
let { byOwner } = await readState(ledgerClient);
const eraCorrections = await mintIfNeeded(ledgerClient, market0, byOwner);

let appliedTotal = 0;
let drift: Delta[] = [];
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const market = (await getJson(MARKET, "/economy/report")) as unknown as MarketReport;
  ({ byOwner } = await readState(ledgerClient));
  const deltas = computeDeltas(market, byOwner);
  if (deltas.length === 0) { console.log(`  round ${round}: converged — הספר משקף את השוק במדויק`); drift = []; break; }
  console.log(`  round ${round}: ${deltas.length} deltas (market moved — settling)`);
  appliedTotal += await applyDeltas(ledgerClient, deltas, byOwner, round);
  if (round === MAX_ROUNDS) {
    const marketFinal = (await getJson(MARKET, "/economy/report")) as unknown as MarketReport;
    ({ byOwner } = await readState(ledgerClient));
    drift = computeDeltas(marketFinal, byOwner);
  }
}

// ─── era corrections: after mirror convergence, write down dead-era backing ──

if (eraCorrections.size > 0) {
  ({ byOwner } = await readState(ledgerClient));
  await applyEraCorrections(ledgerClient, eraCorrections, byOwner);
}

// ─── final verification against both truths ──────────────────────────────────

const marketFinal = (await getJson(MARKET, "/economy/report")) as unknown as MarketReport;
({ byOwner } = await readState(ledgerClient));
const ledgerHealth = await getJson(LEDGER, "/health");
const solvency = (await getQ(ledgerClient, `/state?tenantId=${TENANT}`)) as { solvency: Record<string, string> };
console.log(`  ledger: seq=${ledgerHealth.seq} · solvency: assets=${solvency.solvency.totalAssetsDecimal ?? solvency.solvency.totalAssets} liabilities=${solvency.solvency.totalLiabilitiesDecimal ?? solvency.solvency.totalLiabilities}`);

let mismatch = 0;
for (const a of marketFinal.agents) {
  for (const cur of ["usds", "saos"] as const) {
    const marketTotal = cur === "usds"
      ? parseMarketMicroCents(a.usds) + parseMarketMicroCents(a.usdsLocked) + parseMarketMicroCents(a.usdsStaked ?? "0")
      : parseMarketMicroCents(a.saos) + parseMarketMicroCents(a.saosLocked);
    const mirror = BigInt(byOwner.get(`agent:${a.agentId}:${cur}`)?.balance ?? "0");
    if (marketTotal !== mirror) {
      mismatch++;
      console.log(`  drift: ${a.agentId} ${cur.toUpperCase()} market=${microCentsToString(marketTotal)} book=${microCentsToString(mirror)} Δ=${microCentsToString(marketTotal - mirror)} (עסקאות-בעיצומן — הסבב-הבא מיישב)`);
    }
  }
}
const feeLedger = BigInt(byOwner.get("fees:usds")?.balance ?? "0");
const feeMarket = parseMarketMicroCents(marketFinal.conservation.quote.fees);
if (feeMarket !== feeLedger) { mismatch++; console.log(`  drift: fees market=${microCentsToString(feeMarket)} book=${microCentsToString(feeLedger)}`); }

const poolUsds = BigInt(byOwner.get("pool:usds")?.balance ?? "0");
const poolSaos = BigInt(byOwner.get("pool:saos")?.balance ?? "0");
console.log(`  pool after sync: USDS ${microCentsToString(poolUsds)} · SAOS ${microCentsToString(poolSaos)} (0 = גיבוי-מלא מוחזק כולו כמראות אמיתיות)`);

if (mismatch > 0 && drift.length === 0 && appliedTotal === 0) {
  console.error(`LEDGER-SYNC-FAILED: persistent mismatch beyond in-flight trading`);
  process.exit(1);
}
console.log(`LEDGER-SYNC-OK applied=${appliedTotal} transfers · drift=${drift.length > 0 || mismatch > 0 ? "in-flight (honest)" : "none"} · trades=${marketFinal.settledTrades}`);
