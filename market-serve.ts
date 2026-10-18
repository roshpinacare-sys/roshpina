/**
 * market-serve.ts — P2: the sovereign agent economy as a RUNNING service.
 *
 * הארכיטקטורה-החדשה (הנחיית-מפעיל): כלכלה-סגורה לסוכנים-ריבוניים —
 * הסוכנים הם הלקוחות, המשתמשים והמפעילים. אין-תלות בלקוחות-חוץ.
 *
 *   GET  /health                — חיות + מצב-ספרים
 *   GET  /market/book           — ספר-הזמנות החי (פתוח)
 *   GET  /economy/report        — שימור-כסף + P&L אמיתי לכל-סוכן (פתוח)
 *   POST /agents                — מפעיל בלבד: רישום-סוכן + הקצאה ראשונית
 *   POST /market/order          — סוכן-חתום: הצבת-זמנה (limit/postOnly/ioc)
 *   POST /market/cancel         — סוכן-חתום: ביטול-זמנה משלו בלבד
 *   GET  /agent/me              — סוכן-חתום: יתרות + זמנות-פרישה-שלו
 *
 * זיהוי: כל-סוכן מחזיק Ed25519 משלו (kid→agentId נגזר משמות-ה-env:
 * ROSHPINA_AGENT_KEY_<agentId>). חתימה על-כל-פעולה — אין-קיצורי-דרך.
 *
 * הרצה: bun market-serve.ts
 *   ROSHPINA_PORT (0=אפמרלי) · ROSHPINA_DATA_DIR (חובה)
 *   ROSHPINA_OPERATOR_PUBLIC_KEY_1 (PEM) · ROSHPINA_AGENT_KEY_<id>=PEM
 */

import { KeyRing, computeKid } from "./kernel/passport/key-ring";
import {
  InMemoryReplayCache,
  provisionOperatorKeys,
  requireOperatorSignature,
} from "./src/lib/route-auth";
import { MarketEngine, MarketError } from "./kernel/market/engine";
import { BookError } from "./kernel/market/book";
import { LedgerError } from "./kernel/ledger/in-memory-ledger";
import { parseMicroCents, microCentsToString } from "./kernel/ledger/persistent-ledger";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.ROSHPINA_PORT ?? 3180);
const DATA_DIR = process.env.ROSHPINA_DATA_DIR;
if (!DATA_DIR) {
  console.error("[market] ROSHPINA_DATA_DIR is required");
  process.exit(1);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

const engine = await MarketEngine.open(DATA_DIR);
const bootStats = engine.stats();
console.log(`[market] engine boot: trades=${bootStats.settled} bids=${bootStats.book.bids} asks=${bootStats.book.asks}`);

const ring = new KeyRing();
const opProvision = provisionOperatorKeys(ring, process.env);
console.log(`[market] operator keys: ${opProvision.registered.length} errors=${opProvision.errors.length}`);

// kid → agentId — the agents are first-class principals of this economy
const agentByKid = new Map<string, string>();
for (const [name, pem] of Object.entries(process.env)) {
  if (!name.startsWith("ROSHPINA_AGENT_KEY_") || !pem) continue;
  const agentId = name.slice("ROSHPINA_AGENT_KEY_".length).toLowerCase();
  const kid = computeKid("ed25519", pem.replace(/\r\n/g, "\n").trim());
  agentByKid.set(kid, agentId);
  ring.register({ kid, algorithm: "ed25519", publicKey: pem.replace(/\r\n/g, "\n").trim(), status: "active", createdAt: new Date().toISOString() });
}
console.log(`[market] agent principals: ${agentByKid.size} → [${[...agentByKid.values()].join(", ")}]`);

// ── Self-licensing persistence — principals.json (survives restart; restored on boot) ──
// The operator licenses a new member by signing POST /agents WITH the member's public
// key. The key becomes a live principal of the economy and is persisted so the
// identity survives restarts — an identity that dies with the process is not sovereign.
const PRINCIPALS_FILE = join(DATA_DIR, "principals.json");
type PrincipalRec = { agentId: string; kid: string; publicPem: string; registeredAt: string };
const PRINCIPALS_CAP = 64;

const normalizePem = (p: string): string => p.replace(/\r\n/g, "\n").trim();

function loadPrincipals(): PrincipalRec[] {
  try {
    const parsed = JSON.parse(readFileSync(PRINCIPALS_FILE, "utf8")) as { agents?: PrincipalRec[] };
    return Array.isArray(parsed.agents) ? parsed.agents.slice(0, PRINCIPALS_CAP) : [];
  } catch {
    return []; // missing or corrupt → honest empty start (no fabrications)
  }
}

function savePrincipals(list: PrincipalRec[]): void {
  const capped = list.slice(-PRINCIPALS_CAP);
  const tmp = `${PRINCIPALS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ agents: capped }, null, 2));
  renameSync(tmp, PRINCIPALS_FILE); // atomic — no torn state
}

/** Register a member's public key as a live principal. Fail-closed on bad PEM. */
function registerAgentPrincipal(agentId: string, publicPem: string): { kid: string } {
  const pem = normalizePem(publicPem);
  if (!pem.includes("BEGIN PUBLIC KEY") || !pem.includes("END PUBLIC KEY") || pem.length > 4096) {
    throw new MarketError("publicPem must be a PEM public key (≤4096 chars)", "BAD_PEM");
  }
  const kid = computeKid("ed25519", pem);
  if (agentByKid.get(kid) === agentId) return { kid }; // idempotent re-license
  ring.register({ kid, algorithm: "ed25519", publicKey: pem, status: "active", createdAt: new Date().toISOString() });
  agentByKid.set(kid, agentId);
  return { kid };
}

let restoredPrincipals = 0;
for (const p of loadPrincipals()) {
  try {
    registerAgentPrincipal(p.agentId, p.publicPem);
    restoredPrincipals++;
  } catch (e) {
    console.error(`[market] principal ${p.agentId} restore skipped: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
}
if (restoredPrincipals > 0) console.log(`[market] principals restored from disk: ${restoredPrincipals}`);

const replay = new InMemoryReplayCache();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

/** Fail-closed BigInt parsing for request bodies — garbage in, 400 out (never a 500). */
function toBigInt(v: unknown, code: string): bigint {
  try {
    const b = BigInt(String(v));
    return b;
  } catch {
    throw new MarketError(`expected an integer, got: ${String(v).slice(0, 40)}`, code);
  }
}

function requireEpoch(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 64) throw new MarketError("epoch is required (non-empty, ≤64 chars)", "BAD_EPOCH");
  return s;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function report(): Promise<Response> {
  const cons = await engine.conservation();
  const st = engine.stats();
  const agents = await engine.economyReport();
  const book = { ...st.book, bestBid: st.book.bestBid?.toString() ?? null, bestAsk: st.book.bestAsk?.toString() ?? null };
  return json(200, { conservation: cons, book, settledTrades: st.settled, agents, treasury: await engine.treasury(), epochOps: engine.epochReport(50) });
}

async function handlePost(pathname: string, body: Record<string, unknown>, principal: { kind: "operator" } | { kind: "agent"; agentId: string }): Promise<Response> {
  if (pathname === "/agents") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator registers agents", code: "OPERATOR_ONLY" });
    const agentId = String(body.agentId ?? "");
    const usds = String(body.usds ?? "0");
    const saos = String(body.saos ?? "0");
    const pair = await engine.registerAgent(agentId);
    await engine.allocate(agentId, usds, saos);
    // Self-licensing: WITH the member's publicPem the key becomes a live principal
    // (signed actions from this key are the agent's own) — persisted to principals.json.
    let principalKid: string | null = null;
    const publicPem = typeof body.publicPem === "string" ? body.publicPem : "";
    if (publicPem) {
      const { kid } = registerAgentPrincipal(agentId, publicPem);
      principalKid = kid;
      const list = loadPrincipals().filter((p) => p.agentId !== agentId);
      list.push({ agentId, kid, publicPem: normalizePem(publicPem), registeredAt: new Date().toISOString() });
      savePrincipals(list);
    }
    return json(201, { agentId, accounts: pair, allocated: { usds, saos }, principal: principalKid ?? "env-only" });
  }
  if (pathname === "/market/order") {
    if (principal.kind !== "agent") return json(403, { error: "only agents place orders", code: "AGENT_ONLY" });
    const side = body.side === "bid" ? "bid" : body.side === "ask" ? "ask" : null;
    if (!side) return json(400, { error: "side must be bid|ask" });
    const orderId = typeof body.orderId === "string" && body.orderId ? body.orderId : `o-${principal.agentId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await engine.placeOrder({
      agentId: principal.agentId,
      orderId,
      side,
      price: BigInt(String(body.price)),
      amount: BigInt(String(body.amount)),
      type: (body.type as "limit" | "postOnly" | "ioc") ?? "limit",
    });
    return json(201, {
      orderId,
      fills: res.fills.map((f) => ({ tradeId: f.tradeId, price: f.price.toString(), amount: f.amount.toString(), notional: f.notional.toString(), remainder: f.remainder.toString(), makerId: f.makerId })),
      resting: res.order.locked > 0n,
    });
  }
  if (pathname === "/market/cancel") {
    if (principal.kind !== "agent") return json(403, { error: "only agents cancel orders", code: "AGENT_ONLY" });
    const res = await engine.cancelOrder(principal.agentId, String(body.orderId ?? ""));
    return json(200, { canceled: String(body.orderId), released: res.released });
  }
  if (pathname === "/economy/stake") {
    if (principal.kind !== "agent") return json(403, { error: "only agents stake", code: "AGENT_ONLY" });
    const stakeId = typeof body.stakeId === "string" && body.stakeId ? body.stakeId : `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await engine.stake(principal.agentId, toBigInt(body.amount, "BAD_AMOUNT"), stakeId);
    return json(201, { agentId: principal.agentId, stakeId, staked: res.staked });
  }
  if (pathname === "/economy/unstake") {
    if (principal.kind !== "agent") return json(403, { error: "only agents unstake", code: "AGENT_ONLY" });
    const stakeId = typeof body.stakeId === "string" && body.stakeId ? body.stakeId : `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await engine.unstake(principal.agentId, toBigInt(body.amount, "BAD_AMOUNT"), stakeId);
    return json(200, { agentId: principal.agentId, stakeId, staked: res.staked });
  }
  if (pathname === "/economy/payroll") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator runs payroll", code: "OPERATOR_ONLY" });
    const res = await engine.payroll(requireEpoch(body.epoch), toBigInt(body.wage, "BAD_AMOUNT"));
    return json(201, { epoch: String(body.epoch), ...res });
  }
  if (pathname === "/economy/tax") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator levies taxes", code: "OPERATOR_ONLY" });
    const res = await engine.tax(requireEpoch(body.epoch), toBigInt(body.rateBps, "BAD_RATE"));
    return json(201, { epoch: String(body.epoch), ...res });
  }
  if (pathname === "/economy/rewards") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator distributes rewards", code: "OPERATOR_ONLY" });
    const res = await engine.rewards(requireEpoch(body.epoch), toBigInt(body.rateBps, "BAD_RATE"));
    return json(201, { epoch: String(body.epoch), ...res });
  }
  if (pathname === "/economy/correct") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator corrects", code: "OPERATOR_ONLY" });
    const ledger = body.ledger === "saos" ? "saos" : body.ledger === "usds" ? "usds" : null;
    if (!ledger) return json(400, { error: "ledger must be usds|saos" });
    const accountName = typeof body.accountName === "string" ? body.accountName : "";
    if (!/^[\w.\-:]{1,128}$/.test(accountName)) return json(400, { error: "accountName must match [\\w.\\-:]{1,128}" });
    const correctionId = typeof body.correctionId === "string" && body.correctionId ? body.correctionId : `c-${Date.now()}`;
    const res = await engine.correct(ledger, accountName, correctionId);
    return json(200, { correctionId, ledger, accountName, ...res });
  }
  return json(404, { error: "not found" });
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET") {
        if (url.pathname === "/health") {
          const st = engine.stats();
          return json(200, { ok: true, service: "roshpina-sovereign-market", trades: st.settled, bids: st.book.bids, asks: st.book.asks, phantomsSkipped: st.phantomsSkipped, bootedAt: engine.bootedAt, escrowOrphanQuote: engine.escrowOrphanQuote.toString(), escrowOrphanBase: engine.escrowOrphanBase.toString() });
        }
        if (url.pathname === "/market/book") return json(200, engine.bookSnapshot());
        if (url.pathname === "/economy/report") return await report();
        if (url.pathname === "/agent/me") {
          const auth = await requireOperatorSignature(req, ring, replay);
          if (!auth.ok) return json(auth.status, { error: "refused", code: auth.code, detail: auth.detail });
          const kid = req.headers.get("x-roshpina-kid") ?? "";
          const resolved = agentByKid.get(kid);
          if (!resolved) return json(403, { error: "this key is not an agent principal", code: "NOT_AGENT" });
          const snap = engine.bookSnapshot();
          return json(200, {
            agentId: resolved,
            ...(await engine.balances(resolved)),
            ownOrders: snap.bids.concat(snap.asks).filter((o) => o.agentId === resolved),
          });
        }
        return json(404, { error: "not found" });
      }
      if (req.method === "POST") {
        const auth = await requireOperatorSignature(req, ring, replay);
        if (!auth.ok) return json(auth.status, { error: "refused", code: auth.code, detail: auth.detail });
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(auth.rawBody) as Record<string, unknown>;
        } catch {
          return json(400, { error: "body must be JSON" });
        }
        const kid = req.headers.get("x-roshpina-kid") ?? "";
        const principal = agentByKid.has(kid) ? ({ kind: "agent", agentId: agentByKid.get(kid)! } as const) : ({ kind: "operator" } as const);
        return await handlePost(url.pathname, body, principal);
      }
      return json(405, { error: "method not allowed" });
    } catch (e) {
      if (e instanceof BookError || e instanceof MarketError || e instanceof LedgerError) {
        const status = e.code === "ORDER_NOT_FOUND" ? 404 : e.code === "NOT_OWNER" || e.code === "OPERATOR_ONLY" || e.code === "AGENT_ONLY" ? 403 : 400;
        return json(status, { error: e.message, code: e.code });
      }
      console.error("[market] unhandled:", e);
      return json(500, { error: "internal", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  },
});

console.log(`[market] LISTENING ${server.port}`);

// Disk watchdog: external actors delete data files in this sandbox. The kernel
// heals on the next append, but a deletion during an append-gap used to go
// unnoticed until boot. Verify every 10s — heal + snapshot within seconds.
setInterval(() => {
  try {
    if (engine.diskMaintenance()) console.warn("[market] disk watchdog: journal vanished — healed + snapshot regenerated");
  } catch (e) {
    console.error("[market] disk watchdog failed:", String((e as Error)?.message ?? e).slice(0, 120));
  }
}, 10_000).unref();

export { server, engine, microCentsToString, parseMicroCents };
