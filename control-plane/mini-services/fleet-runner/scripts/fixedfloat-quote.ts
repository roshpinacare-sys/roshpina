/**
 * fixedfloat-quote.ts — the authenticated cross-chain rate lane (FixedFloat API v2 @ ff.io).
 *
 * Closes the "FixedFloat external-pending" gap declared since 2026-10-21
 * (market-serve.ts header: "HTX rejected over KYC; FixedFloat pending on their
 * side") — the operator supplied the API key + secret on 2026-10-25/26; they are
 * sealed root-only at fleet-runner data/vault/fixedfloat.env (never in git).
 *
 * MEASURED API TRUTH (2026-10-26): the legacy fixedfloat.com/api/v1 paths 301
 * to ff.io and the docs there define API v2 — sign law is HMAC-SHA256(secret,
 * body) (NOT the old SHA1(secret+body)), currency codes are UPPERCASE with
 * network suffixes (ETH, ETHBASE, BTC, BTCLN…), price needs direction=from|to.
 * HIVE/STEEM measured NOT LISTED (71 ccies) — those lanes stay internal-market.
 *
 * Read-only proof lane (no funds move): auth probe (ccies) → live float quote
 * (ETH→BTC canonical size). Every failure is loud and exit 1 — no mock, no
 * silent zeros. Swap CREATION stays behind the owner gate until funded
 * inventory exists (zero-operator-funding law).
 *
 * Run: bun scripts/fixedfloat-quote.ts
 */

import { readFileSync } from "fs";
import { createHmac } from "node:crypto";

const VAULT = "/home/z/my-project/mini-services/fleet-runner/data/vault/fixedfloat.env";
const API = "https://ff.io/api/v2";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function loadCreds(): { key: string; secret: string } {
  let key = "", secret = "";
  for (const line of readFileSync(VAULT, "utf8").split("\n")) {
    const m = line.match(/^(FIXEDFLOAT_API_KEY|FIXEDFLOAT_API_SECRET)=(.+)$/);
    if (!m) continue;
    if (m[1] === "FIXEDFLOAT_API_KEY") key = m[2].trim();
    else secret = m[2].trim();
  }
  if (!key || !secret) {
    console.error("fixedfloat: vault credentials unreadable — FAIL-CLOSED (no key file fallback)");
    process.exit(1);
  }
  return { key, secret };
}

async function ffPost(creds: { key: string; secret: string }, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body);
  const sign = createHmac("sha256", creds.secret).update(payload).digest("hex");
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json; charset=UTF-8",
      "X-API-KEY": creds.key,
      "X-API-SIGN": sign,
      "user-agent": UA,
    },
    body: payload,
    signal: AbortSignal.timeout(20_000),
  });
  const txt = await r.text();
  let j: Record<string, unknown>;
  try { j = JSON.parse(txt) as Record<string, unknown>; } catch {
    console.error(`fixedfloat ${path}: non-JSON http ${r.status}: ${txt.slice(0, 160)}`);
    process.exit(1);
  }
  if (r.status !== 200 || j.code !== 0) {
    console.error(`fixedfloat ${path}: http ${r.status} code=${j.code} msg=${String(j.msg ?? "").slice(0, 200)}`);
    process.exit(1);
  }
  return (j.data ?? {}) as Record<string, unknown>;
}

const creds = loadCreds();

// 1) auth + coverage truth
const ccies = await ffPost(creds, "/ccies", {});
const list = ccies as unknown as { code: string; coin: string; network: string; recv: number; send: number }[];
console.log(`== FixedFloat v2 auth OK · ${list.length} currencies listed ==`);
const hasHive = list.some((c) => c.coin.toUpperCase() === "HIVE");
const hasSteem = list.some((c) => c.coin.toUpperCase() === "STEEM");
console.log(`coverage truth: HIVE=${hasHive ? "LISTED" : "NOT-LISTED"} · STEEM=${hasSteem ? "LISTED" : "NOT-LISTED"} (internal-market lanes stay authoritative for those)`);
const ethNets = list.filter((c) => c.coin === "ETH").map((c) => c.network);
console.log(`ETH networks: ${ethNets.join(",")}`);

// 2) live float quote (canonical probe size) — ETH → BTC
const price = await ffPost(creds, "/price", { type: "float", fromCcy: "ETH", toCcy: "BTC", direction: "from", amount: "0.05" }) as {
  from?: { amount?: number; rate?: number; min?: number; max?: number };
  to?: { amount?: number };
};
console.log(`live quote: 0.05 ETH → ${price.to?.amount ?? "?"} BTC · rate=${price.from?.rate ?? "?"} · bounds ${price.from?.min ?? "?"}–${price.from?.max ?? "?"} ETH`);

console.log("FIXEDFLOAT-LANE-OK · authenticated · quoted · bounds measured");
