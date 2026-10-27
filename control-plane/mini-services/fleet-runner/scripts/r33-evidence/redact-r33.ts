/**
 * R33 step 2: redact inline `pass` values from agent/recovery-meta.json.
 * Custody moves to Actions secret VAULT_PASSES_R33 (created in step 1 — verified).
 * Never prints secret values; asserts absence before finishing (fail-closed).
 */
const META = "agent/recovery-meta.json";
const raw = await Bun.file(META).text();
const meta = JSON.parse(raw);

const vaults = ["integrationsVault", "exchangeVault", "walletsVault"];
const now = new Date().toISOString();
let removed = 0;
for (const v of vaults) {
  const node = meta[v];
  if (!node || typeof node.pass !== "string") {
    console.log(`${v}: no inline pass — skipping`);
    continue;
  }
  const len = node.pass.length;
  delete node.pass;
  node.passRef = `actions:VAULT_PASSES_R33 on steem (JSON field ${v})`;
  node.passCustody =
    `R11-containment ${now}: inline pass removed (was ${len} chars beside archive — the R11 pattern). ` +
    `Recovery: Actions secret VAULT_PASSES_R33 on steem (write-only; requires Actions/admin read on this repo). ` +
    `R-VAULTPASS-1 law restored: pass does not travel with the archive.`;
  removed++;
  console.log(`${v}: inline pass removed (len ${len}) → passRef + passCustody updated`);
}
if (removed !== 3) throw new Error(`FAIL: expected 3 redactions, did ${removed} — aborting (fail-closed)`);

// hard assertion: no remaining "pass" VALUES anywhere in the serialized tree
const out = JSON.stringify(meta, null, 2) + "\n";
const scan = (o: unknown, path: string): string[] => {
  if (o && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      k === "pass" ? [`LEAK at ${path}/${k}`] : scan(v, `${path}/${k}`)
    );
  }
  return [];
};
const leaks = scan(meta, "$");
if (leaks.length) throw new Error(`FAIL: ${leaks.join(", ")} — aborting`);
await Bun.write(META, out);
console.log("assertion OK: no `pass` key remains anywhere in the tree");
console.log("R33-REDACT-OK (file not yet committed)");
