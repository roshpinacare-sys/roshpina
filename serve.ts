/**
 * serve.ts — P1: the sovereign ledger as a RUNNING service (2026-10-17).
 *
 * זו ההוכחה שהמערכת "קמה ועובדת": שרת-HTTP אמיתי על גרעין ה-ledger המוכח,
 * עם התמדה (יומן append-only + hash-chain), idempotency, ושער-חתימות K5
 * (route-auth — אותו-שער שהוכח ב-kernel-smoke סעיף 12).
 *
 * חוקי-השער (כמו C-2b):
 *   GET   /health, /state        — פתוחים (קריאה בלבד, אפס-סודות)
 *   POST  /accounts /mint /withdraw /transfer — חייבות חתימת-מפעיל Ed25519
 *          (x-roshpina-kid / -timestamp / -signature; body-bound; replay burns)
 *
 * אפס-סודות: אפס-תלות-חוץ; מפתחות-המפעיל מסופקים דרך env
 * (ROSHPINA_OPERATOR_PUBLIC_KEY*) — בלעדיהם כל-POST מסורב 503 (fail-closed).
 *
 * כמויות: מחרוזת-עשרונית בלבד ("1.23") → BigInt μ¢ מדויק. לעולם לא float.
 *
 * הרצה:  bun serve.ts            (ROSHPINA_PORT ברירת-מחדל 3170,
 *                                 ROSHPINA_DATA_DIR ברירת-מחדל ./data/ledger)
 */

import { KeyRing, computeKid } from "./kernel/passport/key-ring";
import {
  InMemoryReplayCache,
  canonicalRoutePayload,
  provisionOperatorKeys,
  requireOperatorSignature,
  sha256Hex,
} from "./src/lib/route-auth";
import {
  PersistentLedger,
  parseMicroCents,
  microCentsToString,
  JournalError,
} from "./kernel/ledger/persistent-ledger";
import { LedgerError } from "./kernel/ledger/in-memory-ledger";

const PORT = Number(process.env.ROSHPINA_PORT ?? 3170);
const DATA_DIR = process.env.ROSHPINA_DATA_DIR ?? "./data/ledger";

// ─── Boot: verify-then-serve (a tampered journal refuses to come up) ────────

const ledger = await PersistentLedger.open(DATA_DIR, { verify: "full" });
const boot = ledger.stats();
console.log(`[roshpina] ledger boot: seq=${boot.seq} accounts=${boot.accounts} fullFold=${boot.fullFold} head=${boot.head.slice(0, 12)}…`);

const ring = new KeyRing();
const provisioned = provisionOperatorKeys(ring, process.env);
if (provisioned.errors.length > 0) {
  console.warn(`[roshpina] operator key errors: ${provisioned.errors.join("; ")}`);
}
console.log(`[roshpina] operator keys provisioned: ${provisioned.registered.length} kids=[${provisioned.registered.join(",")}]`);
const replay = new InMemoryReplayCache();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

type Body = Record<string, unknown>;

function requireFields(body: Body, fields: string[]): void {
  const missing = fields.filter((f) => {
    const v = body[f];
    return typeof v !== "string" || v.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new LedgerError(`missing/empty fields: ${missing.join(", ")}`, "MISSING_FIELD");
  }
}

function parseAmount(v: unknown): bigint {
  return parseMicroCents(typeof v === "string" ? v : String(v));
}

const IDEM_KEY_RE = /^[\w.\-:]{1,128}$/;

// ─── Router ──────────────────────────────────────────────────────────────────

async function handleGet(url: URL): Promise<Response> {
  if (url.pathname === "/health") {
    const st = ledger.stats();
    return json(200, {
      ok: true,
      service: "roshpina-ledger",
      seq: st.seq,
      head: st.head,
      accounts: st.accounts,
      bootAt: st.bootAt,
      fullFold: st.fullFold,
      operatorKeys: provisioned.registered.length,
    });
  }
  if (url.pathname === "/state") {
    const tenantId = url.searchParams.get("tenantId");
    if (!tenantId) return json(400, { error: "tenantId query param required" });
    const accounts = await ledger.listAccounts(tenantId);
    const dec = (v: bigint) => microCentsToString(v);
    const solvency = await ledger.proofOfSolvency(tenantId);
    return json(200, {
      tenantId,
      accounts: accounts.map((a) => ({ ...a, balance: a.balance.toString(), balanceDecimal: dec(a.balance) })),
      solvency: { ...solvency, totalAssets: solvency.totalAssets.toString(), totalLiabilities: solvency.totalLiabilities.toString(), netEquity: solvency.netEquity.toString() },
    });
  }
  return json(404, { error: "not found" });
}

async function handlePost(pathname: string, body: Body): Promise<Response> {
  const idem = typeof body.idem === "string" ? body.idem : undefined;
  if (idem !== undefined && !IDEM_KEY_RE.test(idem)) {
    return json(400, { error: "idem key must match [\\w.\\-:]{1,128}" });
  }

  switch (pathname) {
    case "/accounts": {
      requireFields(body, ["tenantId", "ownerId", "type", "name"]);
      const acc = await ledger.createAccount(
        body.tenantId as string,
        body.ownerId as string,
        body.type as "asset" | "liability" | "equity" | "revenue" | "expense",
        body.name as string,
        idem,
      );
      return json(201, { account: { ...acc, balance: acc.balance.toString() } });
    }
    case "/mint": {
      requireFields(body, ["tenantId", "toAccountId", "amount", "memo", "initiatedBy"]);
      const tx = await ledger.guardMint(
        body.tenantId as string,
        body.toAccountId as string,
        parseAmount(body.amount),
        body.memo as string,
        body.initiatedBy as string,
        idem,
      );
      return json(201, { tx: { ...tx, amount: tx.amount.toString() } });
    }
    case "/withdraw": {
      requireFields(body, ["tenantId", "fromAccountId", "amount", "memo", "initiatedBy"]);
      const tx = await ledger.guardWithdraw(
        body.tenantId as string,
        body.fromAccountId as string,
        parseAmount(body.amount),
        body.memo as string,
        body.initiatedBy as string,
        idem,
      );
      return json(201, { tx: { ...tx, amount: tx.amount.toString() } });
    }
    case "/transfer": {
      requireFields(body, ["tenantId", "fromAccountId", "toAccountId", "amount", "memo", "initiatedBy"]);
      const tx = await ledger.transfer(
        body.tenantId as string,
        body.fromAccountId as string,
        body.toAccountId as string,
        parseAmount(body.amount),
        body.memo as string,
        body.initiatedBy as string,
        idem,
      );
      return json(201, { tx: { ...tx, amount: tx.amount.toString() } });
    }
    default:
      return json(404, { error: "not found" });
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET") return await handleGet(url);
      if (req.method === "POST") {
        // THE GATE (K5): anonymous/unknown/stale/replayed/forged → refused.
        const auth = await requireOperatorSignature(req, ring, replay);
        if (!auth.ok) {
          return json(auth.status, { error: "refused", code: auth.code, detail: auth.detail });
        }
        let body: Body;
        try {
          body = JSON.parse(auth.rawBody) as Body;
        } catch {
          return json(400, { error: "body must be JSON" });
        }
        return await handlePost(url.pathname, body);
      }
      return json(405, { error: "method not allowed" });
    } catch (e) {
      if (e instanceof LedgerError || e instanceof JournalError) {
        const status = e.code === "ACCOUNT_NOT_FOUND" ? 404 : e.code === "TENANT_VIOLATION" ? 403 : 400;
        return json(status, { error: e.message, code: e.code });
      }
      console.error("[roshpina] unhandled:", e);
      return json(500, { error: "internal", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  },
});

console.log(`[roshpina] LISTENING ${server.port}`);
export { server };
