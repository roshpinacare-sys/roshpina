/**
 * fixedfloat-seal.ts — heal the FixedFloat vault file after a sandbox wipe.
 *
 * The operator's credential source (upload/fffixedflot.txt) is a chat paste:
 *   fixedfloat
 *   [ts] Head Corner: Api key
 *   [ts] Head Corner: <KEY>
 *   [ts] Head Corner: Api secret
 *   [ts] Head Corner: <SECRET>
 * The runner expects data/vault/fixedfloat.env in FIXEDFLOAT_API_KEY=/SECRET= form.
 * Values are NEVER printed — only shapes/lengths. Fail-closed on any surprise.
 * רץ: bun scripts/fixedfloat-seal.ts
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";

const RUNNER = import.meta.dir; // scripts/ — runner root is one above
const SRC = "/home/z/my-project/upload/fffixedflot.txt";
const DST = join(RUNNER, "..", "data", "vault", "fixedfloat.env");

if (existsSync(DST)) {
  const cur = readFileSync(DST, "utf8");
  if (cur.includes("FIXEDFLOAT_API_KEY=") && cur.includes("FIXEDFLOAT_API_SECRET=")) {
    console.log("fixedfloat-seal: vault file already sealed — no-op");
    process.exit(0);
  }
}

if (!existsSync(SRC)) {
  console.error("fixedfloat-seal: source paste missing — FAIL-CLOSED (no fabrication)");
  process.exit(1);
}

const parts = readFileSync(SRC, "utf8")
  .split("\n")
  .map((l) => l.replace(/^\s*\[\d{2}\/\d{2}\/\d{4} [^\]]*\]\s*[^:]*:\s*/, "").trim())
  .filter(Boolean);
// parts: [title, "Api key", KEY, "Api secret", SECRET]
const key = parts[2] ?? "";
const secret = parts[4] ?? "";
if (!key || !secret || key === "Api key" || secret === "Api secret" || /[^A-Za-z0-9]/.test(key + secret)) {
  console.error(`fixedfloat-seal: unexpected paste shape (key len ${key.length}, secret len ${secret.length}) — FAIL-CLOSED`);
  process.exit(1);
}

const vaultDir = join(RUNNER, "..", "data", "vault");
if (!existsSync(vaultDir)) process.exit(1); // never mkdir vault from a heal script — provisioned by boot law
writeFileSync(DST, `FIXEDFLOAT_API_KEY=${key}\nFIXEDFLOAT_API_SECRET=${secret}\n`);
chmodSync(DST, 0o600);
console.log(`fixedfloat-seal: sealed OK (600) — key len ${key.length}, secret len ${secret.length}, values never printed`);
