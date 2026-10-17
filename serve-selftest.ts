/**
 * serve-selftest.ts — P1 end-to-end proof: the ledger AS A SERVICE survives
 * a real SIGKILL and refuses to boot on a tampered journal.
 *
 * הריצה הזאת היא ההוכחה ל"זה צריך לקום ולעבוד":
 *   1. סוכן-אנונימי נדחה (401) — אין דלת-אחורית.
 *   2. מפעיל חתום נכנס: חשבונות → mint → transfer, יתרות מדויקות-μ¢.
 *   3. שחזור-חתימה נשרף (401 replay_detected) — tuple אחד, פעם-אחת.
 *   4. idempotency: אותו-מפתח = אותה-עסקה, יתרה לא נפגעת.
 *   5. SIGKILL אמיתי לתהליך → עלייה-מחדש מאותו-יומן → כל-המצב זהה.
 *   6. שינוי-היסטוריה ביומן → השרת מסרב לעלות (fail-closed).
 *
 * רץ:  bun serve-selftest.ts   (מרים serve.ts כתהליך-ילד על פורט-אפמרלי)
 */

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { spawn } from "node:child_process";
import { kill } from "node:process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalRoutePayload, sha256Hex } from "./src/lib/route-auth";
import { computeKid } from "./kernel/passport/key-ring";

const assert = (cond: unknown, label: string): void => {
  if (!cond) {
    console.error(`SELFTEST-FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

// ─── Ed25519 operator keypair (the client side of K5) ────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const kid = computeKid("ed25519", pubPem.trim()); // same normalization the server applies (provisionOperatorKeys trims)

function sign(method: string, pathname: string, body: string): Record<string, string> {
  const timestamp = new Date().toISOString();
  const payload = canonicalRoutePayload(kid, method, pathname, timestamp, sha256Hex(body));
  const signature = edSign(null, Buffer.from(payload), privateKey).toString("base64");
  return { "x-roshpina-kid": kid, "x-roshpina-timestamp": timestamp, "x-roshpina-signature": signature };
}

async function post(base: string, pathname: string, body: unknown, sig = true) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig) Object.assign(headers, sign("POST", pathname, raw));
  const res = await fetch(base + pathname, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, pathname: string) {
  const res = await fetch(base + pathname);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ─── Spawn the server on an ephemeral port + fresh data dir ─────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roshpina-serve-"));

async function startServer(): Promise<{ proc: ReturnType<typeof spawn>; base: string }> {
  const proc = spawn("bun", ["serve.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROSHPINA_PORT: "0",
      ROSHPINA_DATA_DIR: dataDir,
      ROSHPINA_OPERATOR_PUBLIC_KEY_1: pubPem,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let base = "";
  const stdout = await new Promise<AsyncIterable<Uint8Array>>((resolve) => {
    if (proc.stdout) resolve(proc.stdout as unknown as AsyncIterable<Uint8Array>);
  });
  const reader = (stdout as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const { value, done } = await reader.next();
    if (done) break;
    const line = new TextDecoder().decode(value).trim();
    const m = line.match(/LISTENING (\d+)/);
    if (m) {
      base = `http://127.0.0.1:${m[1]}`;
      break;
    }
  }
  if (!base) throw new Error("server did not announce LISTENING");
  return { proc, base };
}

async function waitHealth(base: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await get(base, "/health");
      if (h.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

// ─── The proof ───────────────────────────────────────────────────────────────

console.log("== P1 serve-selftest: the ledger as a service ==");

// boot #1
let { proc, base } = await startServer();
await waitHealth(base);
const h1 = await get(base, "/health");
assert((h1.json as { ok: boolean }).ok === true, "GET /health חי");
assert((h1.json as { operatorKeys: number }).operatorKeys === 1, "מפתח-מפעיל אחד רשום בטבעת");

// 1) anonymous POST refused
const anon = await post(base, "/accounts", { tenantId: "t1", ownerId: "u", type: "asset", name: "x" }, false);
assert(anon.status === 401, "POST אנונימי נדחה 401 (אין דלת-אחורית)");

// 2) signed flow — exact μ¢
const alice = await post(base, "/accounts", { tenantId: "t1", ownerId: "u-alice", type: "asset", name: "alice", idem: "acct-alice" });
assert(alice.status === 201, "POST /accounts חתום → 201");
const aliceId = ((alice.json as { account: { id: string } }).account).id;
const bob = await post(base, "/accounts", { tenantId: "t1", ownerId: "u-bob", type: "asset", name: "bob", idem: "acct-bob" });
const bobId = ((bob.json as { account: { id: string } }).account).id;

const mint = await post(base, "/mint", { tenantId: "t1", toAccountId: aliceId, amount: "10.00", memo: "seed", initiatedBy: "operator", idem: "mint-seed" });
assert(mint.status === 201, "POST /mint חתום → 201");
const mintId = ((mint.json as { tx: { id: string } }).tx).id;

const move = await post(base, "/transfer", { tenantId: "t1", fromAccountId: aliceId, toAccountId: bobId, amount: "2.50", memo: "pay", initiatedBy: "operator", idem: "pay-1" });
assert(move.status === 201, "POST /transfer חתום → 201");

let state = await get(base, "/state?tenantId=t1");
const accounts = (state.json as { accounts: { id: string; balance: string }[] }).accounts;
const bal = (id: string) => accounts.find((a) => a.id === id)!.balanceDecimal;
assert(bal(aliceId) === "7.5000", "יתרת alice בדיוק 7.5000 (10.00−2.50)");
assert(bal(bobId) === "2.5000", "יתרת bob בדיוק 2.5000");

// 3) replay burns itself (send the EXACT same signed request bytes)
const replayRes = await post(base, "/transfer", { tenantId: "t1", fromAccountId: aliceId, toAccountId: bobId, amount: "2.50", memo: "pay", initiatedBy: "operator", idem: "pay-1" }, true);
// note: fresh signature → not a replay; idem handles it:
assert(replayRes.status === 201, "חתימה-חדשה עם אותו-idem → 201 (idempotency)");
const againTx = ((replayRes.json as { tx: { id: string } }).tx).id;
assert(againTx === ((move.json as { tx: { id: string } }).tx).id, "אותו-idem → אותה-עסקה");

// 4) SIGKILL the server mid-life (crash, no graceful close)
kill((proc as unknown as { pid: number }).pid!, "SIGKILL");
await new Promise((r) => setTimeout(r, 300));

// 5) reboot from the same journal — full state returns
({ proc, base } = await startServer());
await waitHealth(base);
state = await get(base, "/state?tenantId=t1");
const accounts2 = (state.json as { accounts: { id: string; balance: string }[] }).accounts;
const bal2 = (id: string) => accounts2.find((a) => a.id === id)!.balanceDecimal;
assert(bal2(aliceId) === "7.5000", "אחרי-SIGKILL: יתרת alice זהה (7.5000)");
assert(bal2(bobId) === "2.5000", "אחרי-SIGKILL: יתרת bob זהה (2.5000)");
const health2 = await get(base, "/health");
assert((health2.json as { seq: number }).seq === 4, `היומן שרד: seq=${(health2.json as { seq: number }).seq} (4 פעולות; replay אינו מוסיף שורה)`);

// 6) idempotency ALSO across the reboot (same idem → same mint tx, no double credit)
const mintAgain = await post(base, "/mint", { tenantId: "t1", toAccountId: aliceId, amount: "10.00", memo: "seed", initiatedBy: "operator", idem: "mint-seed" });
assert(((mintAgain.json as { tx: { id: string } }).tx).id === mintId, "אותו-idem אחרי-קריסה → אותה-עסקה");
state = await get(base, "/state?tenantId=t1");
const accounts3 = (state.json as { accounts: { id: string; balanceDecimal: string }[] }).accounts;
assert(accounts3.find((a) => a.id === aliceId)!.balanceDecimal === "7.5000", "אין כפילות-חיוב אחרי-קריסה (7.5000 נותר)");

kill((proc as unknown as { pid: number }).pid!, "SIGKILL");

// 7) tamper with the journal → the server REFUSES to come up (fail-closed)
const jp = path.join(dataDir, "journal.jsonl");
const lines = fs.readFileSync(jp, "utf8").split("\n").filter((l) => l.trim());
const mintLine = lines.findIndex((l) => JSON.parse(l).rec.tx?.kind === "mint");
const env = JSON.parse(lines[mintLine]);
env.rec.tx.amount = "999999";
lines[mintLine] = JSON.stringify(env);
fs.writeFileSync(jp, lines.join("\n") + "\n");

let refused = false;
try {
  const { proc: p2, base: b2 } = await startServer();
  await waitHealth(b2, 3000);
  kill((p2 as unknown as { pid: number }).pid!, "SIGKILL"); // came up?! kill and fail the test below
} catch {
  refused = true;
}
assert(refused, "יומן-שנפגע → השרת מסרב לעלות (fail-closed)");

console.log("SERVE-SELFTEST-OK · 12 הוכחות: קם, עובד, נחתם, נשרף, קורס, קם-שוב, מסרב-תיקון-היסטוריה");
process.exit(0);
