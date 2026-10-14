/**
 * lib/escrow/webhook-crypto.ts — the single source of webhook HMAC truth (K2, v144).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The signature helpers used to live as statics on WebhookService (webhook.ts).
 * K2's share-gate (share-gate.ts) must sign the REDACTED payload with the SAME
 * algorithm — but share-gate cannot import webhook.ts (webhook.ts imports the
 * gate; a value-cycle would be born). Extracting the two pure functions here
 * keeps exactly ONE HMAC implementation: WebhookService.signPayload delegates
 * to it, the gate uses it directly. Two implementations of the same HMAC would
 * be a sharpening sin — one truth, two call sites.
 *
 * Contract (unchanged since Settlement #3):
 *   signature = "sha256=" + base64(HMAC-SHA256(secret, payload))
 *   verification is timing-safe (length checked first, then timingSafeEqual).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sign a payload string with the registration secret using HMAC-SHA256.
 * Returns: "sha256=<base64>"
 */
export function signPayload(secret: string, payload: string): string {
  const mac = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payload, "utf8")
    .digest("base64");
  return `sha256=${mac}`;
}

/**
 * Verify a signature produced by signPayload (timing-safe).
 */
export function verifySignature(secret: string, payload: string, signature: string): boolean {
  try {
    const expected = Buffer.from(signPayload(secret, payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
