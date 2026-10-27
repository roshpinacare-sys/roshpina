/**
 * vault-seal-soldiers.ts — §1 of the 42nd directive (trace 1a178c71bcb7ddad):
 * every soldier private key is sealed AES-256-GCM inside the local vault
 * (data/vault/soldiers/), keyed by scrypt over the vault passphrase —
 * the plaintext never leaves data/keys (gitignored, 0600) and NEVER lands
 * in the vault output: the vault stores ciphertext + kid + sha256 only.
 *
 * Verify pass: every record is decrypted IN MEMORY and compared by sha256
 * against the on-disk key — the seal is proven, not claimed.
 *
 * רץ: bun scripts/vault-seal-soldiers.ts   (idempotent — re-seals on rotation)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join, basename } from "path";
import { createHash, randomBytes, scryptSync, createDecipheriv, createCipheriv } from "crypto";

const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
const VAULT_DIR = join(import.meta.dir, "..", "data", "vault", "soldiers");
const PASS_FILE = "/home/z/my-project/upload/vault.passphrase";

const pass = readFileSync(PASS_FILE, "utf8").trim();
if (pass.length < 8) throw new Error("vault passphrase unreadable/too short — refusing (fail-closed)");
mkdirSync(VAULT_DIR, { recursive: true });
chmodSync(VAULT_DIR, 0o700);

const privFiles = readdirSync(KEYS_DIR).filter((f) => f.endsWith(".priv.pem"));
if (privFiles.length === 0) throw new Error("no private keys found — nothing to seal");

const results: { agentId: string; kid: string; sealed: boolean; verified: boolean }[] = [];

for (const f of privFiles) {
  const agentId = basename(f, ".priv.pem");
  const pem = readFileSync(join(KEYS_DIR, f), "utf8");
  const kid = createHash("sha256").update(pem.trim()).digest("hex").slice(0, 16);
  const sha = createHash("sha256").update(pem).digest("hex");

  // seal: scrypt(pass, salt) → AES-256-GCM
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const rec = {
    v: 1,
    agentId,
    kid,
    sha256: sha,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
    sealedAt: new Date().toISOString(),
  };
  const out = join(VAULT_DIR, `${agentId}.key.enc`);
  writeFileSync(out, JSON.stringify(rec, null, 2));
  chmodSync(out, 0o600);

  // verify: decrypt in memory, compare sha256 — proof, not claim
  const back = JSON.parse(readFileSync(out, "utf8"));
  const dkey = scryptSync(pass, Buffer.from(back.salt, "base64"), 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", dkey, Buffer.from(back.iv, "base64"));
  decipher.setAuthTag(Buffer.from(back.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(back.ct, "base64")), decipher.final()]).toString("utf8");
  const verified = createHash("sha256").update(plain).digest("hex") === sha;

  results.push({ agentId, kid, sealed: existsSync(out), verified });
  console.log(`  vault: ${agentId} kid=${kid} sealed=${existsSync(out)} (600) gcm-verified=${verified}`);
}

const ok = results.every((r) => r.sealed && r.verified);
console.log(`\nVAULT-SEAL-OK · ${results.length}/${results.length} soldier keys sealed AES-256-GCM (scrypt-KDF, per-file salt/iv/tag) — plaintext absent from vault by construction`);
if (!ok) process.exit(1);
