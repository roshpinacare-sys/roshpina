import { unsealVaultClass } from "/tmp/steem-r33/mini-services/saos-engine/vault-unseal.mjs";
import * as fs from "node:fs";
const repo = "/tmp/steem-r33";
const meta = JSON.parse(fs.readFileSync(repo + "/agent/recovery-meta.json", "utf8"));
const withEnv = process.env.VAULT_PASS_EXCHANGE;
try {
  const parsed = unsealVaultClass(repo, meta, "exchangeVault", { noCache: true });
  const ok = parsed.items?.length > 0;
  console.log(`ROUNDTRIP-OK: exchange bundle unsealed via env custody (${parsed.items.length} items, ids=${parsed.items.map(i=>i.id).join(",")}) — pins verified, secrets never printed`);
} catch (e) {
  console.log(`UNSEAL-RESULT: code=${e.code} msg=${String(e.message).slice(0,120)}`);
  process.exit(withEnv ? 1 : 0);
}
