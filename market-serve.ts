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

const replay = new InMemoryReplayCache();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

// ─── Handlers ────────────────────────────────────────────────────────────────

async function report(): Promise<Response> {
  const cons = await engine.conservation();
  const st = engine.stats();
  const agents = await engine.economyReport();
  const book = { ...st.book, bestBid: st.book.bestBid?.toString() ?? null, bestAsk: st.book.bestAsk?.toString() ?? null };
  return json(200, { conservation: cons, book, settledTrades: st.settled, agents });
}

async function handlePost(pathname: string, body: Record<string, unknown>, principal: { kind: "operator" } | { kind: "agent"; agentId: string }): Promise<Response> {
  if (pathname === "/agents") {
    if (principal.kind !== "operator") return json(403, { error: "only the operator registers agents", code: "OPERATOR_ONLY" });
    const agentId = String(body.agentId ?? "");
    const usds = String(body.usds ?? "0");
    const saos = String(body.saos ?? "0");
    const pair = await engine.registerAgent(agentId);
    await engine.allocate(agentId, usds, saos);
    return json(201, { agentId, accounts: pair, allocated: { usds, saos } });
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
          return json(200, { ok: true, service: "roshpina-sovereign-market", trades: st.settled, bids: st.book.bids, asks: st.book.asks, bootedAt: engine.bootedAt });
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
export { server, engine, microCentsToString, parseMicroCents };
