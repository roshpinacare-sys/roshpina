/**
 * r11-evm-sweep.ts — Task 28: protective custody transfer for the R11-exposed EVM key.
 *
 * MEASURED FACT (r11-live-key-audit): the SOVEREIGN ROOT mnemonic (exposed ~4h49m in the
 * PUBLIC saos-dex repo + forever in 8 git histories via KEYS-ACCESS-2026-09-12.tar.enc)
 * still derives a LIVE EVM key holding real mainnet ETH (cashmachine). STEEM/HIVE WIFs are
 * all rotated (0/96 live) — the EVM root is the one remaining material R11 hole.
 *
 * This tool moves the exposed balance to a FRESH key BEFORE any attacker can, then seals
 * the new key in the estate vault (vault-seal.sh — AES-256-CBC pbkdf2-200k, operator
 * passphrase, local-only). Fail-closed rules:
 *   - old pk must derive exactly the registry address, else ABORT
 *   - new key is SEALED before any broadcast
 *   - a small test tx must CONFIRM on chain before the sweep tx
 *   - sweep value = balance − exact gas cost; balance never goes negative
 *   - report contains public data only (addresses, tx hashes, amounts)
 *
 * Env:
 *   R11_REGISTRY  path to the (hermetic) wallets-registry.json
 *   R11_AGENT     registry account to sweep (default: cashmachine)
 *   R11_OUT       report path (default: logs/r11-evm-sweep-report.json)
 *   SWEEP_DRY_RUN "1" → generate+seal only, no broadcast (default "1")
 *   SWEEP_RPC     (default https://ethereum-rpc.publicnode.com)
 *   SWEEP_TEST_ETH  test tx amount in ETH (default "0.005")
 *
 * Run: bun mini-services/fleet-runner/scripts/r11-evm-sweep.ts
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { keccak256 } from "js-sha3";
import { sha256 } from "@noble/hashes/sha2.js";
import * as secp from "@noble/secp256k1";

secp.hashes.sha256 = sha256;

const REGISTRY = process.env.R11_REGISTRY ?? "/tmp/r11-audit/agent/keys/wallets-registry.json";
const AGENT = process.env.R11_AGENT ?? "cashmachine";
const OUT = process.env.R11_OUT ?? "logs/r11-evm-sweep-report.json";
const DRY = (process.env.SWEEP_DRY_RUN ?? "1") === "1";
const RPC = process.env.SWEEP_RPC ?? "https://ethereum-rpc.publicnode.com";
const TEST_ETH = process.env.SWEEP_TEST_ETH ?? "0.005";
const PROJECT = "/home/z/my-project";
const CHAIN_ID = 1n;
const GAS_LIMIT = 21000n;

const log = (...a: unknown[]): void => console.log("[r11-sweep]", ...a);
const die = (msg: string): never => { console.error("[r11-sweep] ABORT:", msg); process.exit(1); };

const hexToBytes = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const toEth = (wei: bigint): string => (Number(wei) / 1e18).toFixed(6);

function rlpEncode(item: unknown): Uint8Array {
  const concat = (arrs: Uint8Array[]): Uint8Array => {
    const len = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const numBytes = (v: bigint): Uint8Array => {
    if (v === 0n) return new Uint8Array(0);
    const out: number[] = [];
    let x = v;
    while (x > 0n) { out.unshift(Number(x & 0xffn)); x >>= 8n; }
    return new Uint8Array(out);
  };
  const wrap = (b: Uint8Array, offset: number, isData: boolean): Uint8Array => {
    if (isData && b.length === 1 && b[0] < 0x80) return b;
    if (b.length < 56) return new Uint8Array([offset + b.length, ...b]);
    const lenB = numBytes(BigInt(b.length));
    return new Uint8Array([offset + 55 + lenB.length, ...lenB, ...b]);
  };
  if (Array.isArray(item)) return wrap(concat(item.map(rlpEncode)), 0xc0, false);
  if (item instanceof Uint8Array) return wrap(item, 0x80, true);
  if (typeof item === "string" && item.startsWith("0x")) {
    const s = item.slice(2);
    return wrap(s.length === 0 ? new Uint8Array(0) : hexToBytes(s), 0x80, true);
  }
  return wrap(numBytes(BigInt(item as bigint)), 0x80, true);
}

interface SweepFields { nonce: bigint; gasPrice: bigint; gas: bigint; to: string; value: bigint; chainId: bigint; }

function signLegacyTx(f: SweepFields, privHex: string): string {
  const d = BigInt("0x" + privHex);
  const n = secp.Point.CURVE().n;
  const toB = hexToBytes(f.to);
  const payload = rlpEncode([f.nonce, f.gasPrice, f.gas, toB, f.value, "0x", f.chainId, 0n, 0n]);
  const z = BigInt("0x" + keccak256(payload));
  let r = 0n, s = 0n, parity = 0;
  for (let attempt = 0; attempt < 64; attempt++) {
    const k = secp.etc.bytesToNumberBE(secp.etc.randomBytes(32));
    if (k === 0n || k >= n) continue;
    const R = secp.Point.BASE.multiply(k);
    const aff = (R as unknown as { toAffine(): { x: bigint; y: bigint } }).toAffine();
    r = aff.x % n;
    if (r === 0n) continue;
    s = (secp.etc.invert(k, n) * (z + r * d)) % n;
    parity = Number(aff.y & 1n);
    if (s > n / 2n) { s = n - s; parity = 1 - parity; }
    if (s === 0n) continue;
    break;
  }
  if (r === 0n || s === 0n) die("signing failed after 64 attempts");
  const v = 35n + 2n * f.chainId + BigInt(parity);
  const raw = rlpEncode([f.nonce, f.gasPrice, f.gas, toB, f.value, "0x", v, r, s]);
  return "0x" + bytesToHex(raw);
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
const getBalance = (a: string) => rpc<string>("eth_getBalance", [a, "latest"]).then((x) => BigInt(x));
const getNonce = (a: string) => rpc<string>("eth_getTransactionCount", [a, "latest"]).then((x) => BigInt(x));
const getGas = () => rpc<string>("eth_gasPrice", []).then((x) => BigInt(x));

async function waitReceipt(txHash: string, what: string): Promise<{ status: string; blockNumber: string } | null> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const rec = await rpc<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [txHash]);
      if (rec) { log(`${what} mined @ block ${parseInt(rec.blockNumber, 16)} status=${rec.status}`); return rec; }
    } catch { /* transient — keep polling */ }
  }
  return null;
}

// ── 1. load + verify old key ─────────────────────────────────────────────────
const reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
  accounts: Array<{ agent: string; evm: { address: string; pk: string } }>;
};
const entry = reg.accounts.find((a) => a.agent === AGENT);
if (!entry) die(`agent ${AGENT} not in registry`);
const oldAddr = entry.evm.address.toLowerCase();
const oldPk = entry.evm.pk.replace(/^0x/, "");
if (oldPk.length !== 64) die(`registry pk is ${oldPk.length} hex chars — not a 32-byte private key`);

const derivedPub = secp.getPublicKey(hexToBytes(oldPk), false);
const derivedAddr = "0x" + keccak256(derivedPub.slice(1)).slice(-40);
if (derivedAddr.toLowerCase() !== oldAddr) die(`pk↔address MISMATCH: derived ${derivedAddr} vs registry ${oldAddr}`);
log(`old key verified: ${AGENT} ${oldAddr} derives exactly from registry pk (0.3674 ETH exposed live key)`);

// ── 2. fresh key ─────────────────────────────────────────────────────────────
const newPriv = secp.etc.randomBytes(32);
const newPubUn = secp.getPublicKey(newPriv, false);
const newAddr = "0x" + keccak256(newPubUn.slice(1)).slice(-40);
log(`new custody address: ${newAddr}`);
// self-check: derive back from stored hex
const backAddr = "0x" + keccak256(secp.getPublicKey(hexToBytes(bytesToHex(newPriv)), false).slice(1)).slice(-40);
if (backAddr !== newAddr) die("new key self-derivation mismatch");
log("new key self-derivation roundtrip: OK");

// ── 3. seal BEFORE any broadcast ─────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sealName = `r11-sweep-key-${stamp}`;
const tmpSecret = `/tmp/${sealName}.tmp.json`;
mkdirSync(`${PROJECT}/vault-sealed`, { recursive: true });
writeFileSync(tmpSecret, JSON.stringify({
  purpose: "R11 protective sweep — new EVM custody key (exposed root rotation, Task 28)",
  address: newAddr,
  privHex: bytesToHex(newPriv),
  createdAt: new Date().toISOString(),
  sealedBy: "agent-4 r11-evm-sweep",
}, null, 2) + "\n");
const { execSync } = await import("child_process");
const sealOut = execSync(`bash mini-services/fleet-runner/scripts/vault-seal.sh ${tmpSecret} ${sealName}`, { cwd: PROJECT, encoding: "utf8" });
unlinkSync(tmpSecret);
log(sealOut.trim());
if (!existsSync(`${PROJECT}/vault-sealed/${sealName}.enc`)) die("seal output missing — refusing to broadcast");
log("custody SEALED before broadcast (fail-closed order upheld)");

if (DRY) {
  log(`DRY RUN complete — new address ${newAddr}, sealed as ${sealName}.enc; no broadcast performed`);
  const report = { generatedAt: new Date().toISOString(), dryRun: true, agent: AGENT, oldAddress: oldAddr, newAddress: newAddr, sealName, note: "dry run — generate+seal only" };
  mkdirSync("logs", { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  process.exit(0);
}

// ── 4. test tx (must confirm before sweep) ───────────────────────────────────
const [bal0, nonce0, gas0] = await Promise.all([getBalance(oldAddr), getNonce(oldAddr), getGas()]);
log(`on-chain: balance=${toEth(bal0)} ETH nonce=${nonce0} gasPrice=${gas0} wei`);
const gasPrice = gas0 * 4n; // headroom; still trivial cost at 21000 gas
const testWei = BigInt(Math.round(parseFloat(TEST_ETH) * 1e18));
if (bal0 < testWei + GAS_LIMIT * gasPrice) die("insufficient balance for test tx");

const testTx = signLegacyTx({ nonce: nonce0, gasPrice, gas: GAS_LIMIT, to: newAddr, value: testWei, chainId: CHAIN_ID }, oldPk);
const testHash = await rpc<string>("eth_sendRawTransaction", [testTx]);
log(`test tx broadcast: ${testHash}`);
const testRec = await waitReceipt(testHash, "test tx");
if (!testRec || testRec.status !== "0x1") die("test tx NOT confirmed — fail-closed: no sweep performed");
const newBalAfterTest = await getBalance(newAddr);
if (newBalAfterTest < testWei) die(`test arrival UNVERIFIED: new addr balance ${toEth(newBalAfterTest)}`);
log(`test arrival verified: ${toEth(newBalAfterTest)} ETH on new address`);

// ── 5. sweep ─────────────────────────────────────────────────────────────────
const bal1 = await getBalance(oldAddr);
const nonce1 = await getNonce(oldAddr);
const sweepValue = bal1 - GAS_LIMIT * gasPrice;
if (sweepValue <= 0n) die("nothing left to sweep");
log(`sweeping ${toEth(sweepValue)} ETH (balance ${toEth(bal1)} − gas ${toEth(GAS_LIMIT * gasPrice)})`);
const sweepTx = signLegacyTx({ nonce: nonce1, gasPrice, gas: GAS_LIMIT, to: newAddr, value: sweepValue, chainId: CHAIN_ID }, oldPk);
const sweepHash = await rpc<string>("eth_sendRawTransaction", [sweepTx]);
log(`sweep tx broadcast: ${sweepHash}`);
const sweepRec = await waitReceipt(sweepHash, "sweep tx");
if (!sweepRec || sweepRec.status !== "0x1") die("sweep tx not confirmed in time — CHECK CHAIN STATE MANUALLY (test tx already succeeded; custody is at the new sealed address)");
const finalOld = await getBalance(oldAddr);
const finalNew = await getBalance(newAddr);
log(`FINAL: old=${toEth(finalOld)} new=${toEth(finalNew)} ETH`);

// ── 6. report (public data only) ─────────────────────────────────────────────
mkdirSync("logs", { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  dryRun: false,
  agent: AGENT,
  oldAddress: oldAddr,
  newAddress: newAddr,
  sealName,
  testTx: { hash: testHash, valueEth: TEST_ETH, status: testRec.status },
  sweepTx: { hash: sweepHash, valueWei: sweepValue.toString(), valueEth: toEth(sweepValue), status: sweepRec.status },
  final: { oldWei: finalOld.toString(), newWei: finalNew.toString() },
  gasPriceWei: gasPrice.toString(),
  note: "R11 protective custody transfer: exposed-root balance moved to fresh sealed key before any attacker sweep. New key sealed via vault-seal.sh (operator passphrase, local-only).",
}, null, 1) + "\n");
log(`report → ${OUT}`);
log("NEXT: trigger estate-vault job to push the sealed custody out of this sandbox immediately");
