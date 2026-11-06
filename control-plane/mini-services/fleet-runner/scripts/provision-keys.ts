/**
 * provision-keys.ts — one-time local dev keys for the LIVE economy node (3033).
 *
 * חדים-לגמרי: מפתחות-פיתוח-מקומיים חדשים, נוצרים כאן ונשארים כאן.
 * לא-נוגע בשום-כספת, בשום-PAT, בשום-סוד-קיים של הצי — בדיוק כהנחיית-המפעיל.
 * השרת מקבל רק מפתחות-ציבוריים (env ב-boot); הפרטיים נשארים בדיסק המקומי.
 *
 * רץ: bun scripts/provision-keys.ts   (idempotent — יוצר רק אם חסר)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { generateKeyPairSync } from "node:crypto";
import { sha256Hex } from "/home/z/repos/roshpina/src/lib/route-auth";

const KEYS_DIR = join(import.meta.dir, "..", "data", "keys");
mkdirSync(KEYS_DIR, { recursive: true });

const IDS = ["operator", "alpha", "bravo", "gamma", "delta"] as const;

function kidOf(publicPem: string): string {
  return sha256Hex(publicPem.trim()).slice(0, 16); // same normalization as the server
}

function generate(id: string): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(join(KEYS_DIR, `${id}.pub.pem`), publicPem);
  writeFileSync(join(KEYS_DIR, `${id}.priv.pem`), privatePem);
}

const manifest: Record<string, string> = {};
for (const id of IDS) {
  const pubPath = join(KEYS_DIR, `${id}.pub.pem`);
  const privPath = join(KEYS_DIR, `${id}.priv.pem`);
  if (!existsSync(pubPath) || !existsSync(privPath)) {
    generate(id);
    console.log(`generated  ${id}  (fresh local dev key)`);
  } else {
    console.log(`existing   ${id}  (left untouched — idempotent)`);
  }
  manifest[id] = kidOf(readFileSync(pubPath, "utf8"));
}

writeFileSync(join(KEYS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("kids:", JSON.stringify(manifest));
console.log(`keys dir: ${KEYS_DIR}  (dev-only; *.pem is gitignored)`);
