/**
 * R33 containment step 1: create Actions secret VAULT_PASSES_R33 on steem.
 * Reads the CURRENT agent/recovery-meta.json from the API, extracts the three
 * inline `pass` values, and seals them into a NEW additive Actions secret via
 * libsodium sealed-box. Zero secret values in any output, ever (fail-closed).
 */
import blakejs from "blakejs";
import nacl from "tweetnacl";

const TOKEN = Bun.env.GH_TOKEN ?? "";
const OWNER = "roshpinacare-sys";
const REPO = "steem";
const SECRET_NAME = "VAULT_PASSES_R33";
const META_PATH = "agent/recovery-meta.json";

const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" };

async function j(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { headers: H, ...init });
  const t = await r.text();
  if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));

// 1) fetch current meta (in-memory only)
const metaResp = await j(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${META_PATH}`);
const meta = JSON.parse(Buffer.from(metaResp.content, "base64").toString("utf8"));
const vaults = ["integrationsVault", "exchangeVault", "walletsVault"];
const payload: Record<string, string> = {};
for (const v of vaults) {
  const p = meta[v]?.pass;
  if (typeof p !== "string" || p.length < 8) throw new Error(`FAIL: ${v}.pass missing/short — aborting (fail-closed)`);
  payload[v] = p;
}
console.log(`meta read OK: 3 pass values extracted (lengths ${vaults.map((v) => payload[v].length).join("/")}) — not printed`);

// 2) repo public key
const pk = await j(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
const recipient = b64(pk.key);
console.log(`public key fetched: key_id=${pk.key_id}`);

// 3) sealed box: epk || box(msg, nonce=blake2b24(epk||rpk), rpk, esk)
const esk = nacl.box.keyPair();
const nonce = blakejs.blake2b(new Uint8Array([...esk.publicKey, ...recipient]), undefined, 24);
const msg = new TextEncoder().encode(JSON.stringify({ ...payload, createdAt: new Date().toISOString(), purpose: "R11-containment Task 33 — passes moved out of recovery-meta.json (R-VAULTPASS-1 law restored)" }));
const boxed = nacl.box(msg, nonce, recipient, esk.secretKey);
const sealed = new Uint8Array([...esk.publicKey, ...boxed]);
const encrypted_value = Buffer.from(sealed).toString("base64");

// 4) PUT secret (additive new name — never touches existing STEEM_VAULT_PASSES)
await j(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/${SECRET_NAME}`, {
  method: "PUT",
  body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
});
console.log(`secret ${SECRET_NAME} created on ${OWNER}/${REPO}`);

// 5) verify presence by name (values are unreadable by design — write-only)
const list = await j(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets?per_page=100`);
const names = (list.secrets ?? []).map((s: any) => s.name);
if (!names.includes(SECRET_NAME)) throw new Error("FAIL: secret not present after PUT — aborting");
console.log(`verified in secrets list (names only): ${names.join(", ")}`);
console.log("R33-SEAL-OK");
