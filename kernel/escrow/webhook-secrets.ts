/**
 * lib/escrow/webhook-secrets.ts — the single seal-truth for webhook secrets at rest (K3, v145).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The webhook HMAC secret used to sit PLAINTEXT inside the WebhookStore — every
 * get/list caller (an admin UI, a log dump, a future route layer) held the
 * signing key and could forge deliveries forever. K3 seals the secret at the
 * store boundary: the store only ever sees ciphertext; plaintext exists exactly
 * twice — once at the door (register returns it to the caller ONCE, like a CDP
 * API secret) and once inside the signing frame (dispatch unseals just-in-time).
 *
 * DNA (verified, not assumed): coinbase/agentkit CdpEvmWalletProvider —
 * `exportWallet()` returns { name, address } ONLY (the interface lacks the key),
 * and signing delegates to the CDP server (raw tx out, signature back) — the
 * key never exists in the agent process. We cannot run server-side MPC inside
 * the kernel, so the honest equivalent is: key material at rest is always
 * ciphertext; plaintext only in the sign frame; read paths lack the field at
 * the type level. לא להעתיק — לחדד.
 *
 * Law:
 *   • ONE seal implementation (two sealers of the same shape = the sharpening
 *     sin K2 killed for HMAC).
 *   • AES-256-GCM, 12-byte random nonce per record, auth tag appended to ct.
 *   • 32-byte key REQUIRED — wrong length is an invalid_config error, never a
 *     silent fallback.
 *   • Tamper is loud: unseal throws on any bit-flip (GCM auth), never returns
 *     a guess.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** A secret sealed at rest. The store holds ONLY this shape — never plaintext. */
export interface SealedSecret {
  v: 1;
  alg: "aes-256-gcm";
  /** 12-byte random nonce, hex. */
  nonce: string;
  /** ciphertext with the 16-byte GCM auth tag appended, hex. */
  ct: string;
}

/** The one interface for sealing/unsealing secret material. */
export interface SecretSealer {
  seal(plain: string): SealedSecret;
  unseal(sealed: SealedSecret): string;
}

export class SecretSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretSealError";
  }
}

/**
 * AesGcmSecretSealer — THE sealer. Key arrives from the deployment channel
 * (the same trust level as CDP's own env credentials — verified receipt:
 * cdpEvmWalletProvider.ts L88-97 reads CDP_API_KEY_ID/SECRET/WALLET_SECRET
 * from process.env). The kernel never persists or derives it.
 */
export class AesGcmSecretSealer implements SecretSealer {
  private readonly key: Buffer;

  constructor(key: Buffer | Uint8Array) {
    const k = Buffer.isBuffer(key) ? key : Buffer.from(key);
    if (k.length !== 32) {
      throw new SecretSealError(`sealer key must be exactly 32 bytes (got ${k.length}) — K3 never falls back`);
    }
    this.key = k;
  }

  seal(plain: string): SealedSecret {
    if (typeof plain !== "string" || plain.length === 0) {
      throw new SecretSealError("refusing to seal an empty secret");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { v: 1, alg: "aes-256-gcm", nonce: nonce.toString("hex"), ct: ct.toString("hex") };
  }

  unseal(sealed: SealedSecret): string {
    if (!sealed || sealed.v !== 1 || sealed.alg !== "aes-256-gcm" || typeof sealed.nonce !== "string" || typeof sealed.ct !== "string") {
      throw new SecretSealError("sealed secret has an unknown shape (not ours to open)");
    }
    let raw: Buffer;
    try {
      const nonce = Buffer.from(sealed.nonce, "hex");
      const data = Buffer.from(sealed.ct, "hex");
      if (nonce.length !== 12 || data.length <= 16) throw new Error("bad lengths");
      const ct = data.subarray(0, data.length - 16);
      const tag = data.subarray(data.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAuthTag(tag);
      raw = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new SecretSealError("unseal failed — tampered, truncated, or wrong key (fail loud, never guess)");
    }
    const plain = raw.toString("utf8");
    if (!plain) throw new SecretSealError("unsealed to an empty secret — refusing");
    return plain;
  }
}

/**
 * A short, non-reversible fingerprint for ops identification WITHOUT revealing
 * material: any read path may show this; no read path may show the secret.
 */
export function secretFingerprint(plain: string): string {
  return "sha256:" + createHash("sha256").update(plain, "utf8").digest("hex").slice(0, 16);
}
