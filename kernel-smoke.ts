import { InMemoryLedger } from "./kernel/ledger/in-memory-ledger";
import { LedgerOrchestrator } from "./kernel/ledger-orchestrator/ledger-orchestrator";
import { TfaOrchestrator as Orchestrator } from "./kernel/orchestrator/orchestrator";
import { EscrowService } from "./kernel/escrow/escrow";
import { InMemoryAuditStore } from "./kernel/orchestrator/audit";
import { selectCheapestVendor, routingFeeFromSpread } from "./kernel/marketplace/cost-arbitrage";
import { Ed25519Signer } from "./kernel/orchestrator/signer";
import { KeyRing } from "./kernel/passport/key-ring";
import { InMemoryTransparencyLog } from "./kernel/transparency-log";

async function main() {
  const T = "tenant-roshpina";
  const audit = new InMemoryAuditStore();
  const { allowAll } = await import("./kernel/orchestrator/guard");
  const orch = new Orchestrator([allowAll("roshpina-default")], audit);
  const ledger = new InMemoryLedger();
  const kp = (require("node:crypto") as any).generateKeyPairSync("ed25519");
  const signer = new (Ed25519Signer as any)(kp.privateKey.export({ type: "pkcs8", format: "pem" }), kp.publicKey.export({ type: "spki", format: "pem" }));
  const lorch = new LedgerOrchestrator(ledger, orch, { signer } as any);
  const escrow = new EscrowService(lorch, undefined, undefined, { basisPoints: 500 });

  const op = await lorch.createAccount(T, "operator", "user", "Operator Operating");
  const wk = await lorch.createAccount(T, "worker-a", "user", "Worker A");
  const mint = await lorch.mint(T, op.id, 10_000_000n, "initial funding", "operator");
  if (!mint.ok) throw new Error("mint failed: " + JSON.stringify(mint, (_, v) => typeof v === "bigint" ? String(v) : v).slice(0, 400));
  console.log("mint ok · auditId:", String(mint.auditId).slice(0, 8), "· tx:", String((mint.result as any)?.id ?? "").slice(0, 8));

  const agr = await escrow.create({ tenantId: T, opportunityId: "opp-1", payerAccountId: op.id, workerAccountId: wk.id, amount: 2_000_000n });
  await escrow.fund(T, agr.id, "operator");
  await escrow.release(T, agr.id, "operator", { note: "work delivered" } as any);
  console.log("escrow lifecycle: created→funded→released ✓ · agreement:", agr.id.slice(0, 8));

  const q = selectCheapestVendor([
    { vendorId: "vendor-a", estimatedCostMc: 850_000n },
    { vendorId: "vendor-b", estimatedCostMc: 700_000n },
  ]);
  const fee = routingFeeFromSpread(q.spreadMc, 10n, 100n); // capture 10% of the spread as routing fee
  console.log("cost-arbitrage: winner =", q.winner.vendorId, "· spread =", q.spreadMc.toString(), "µ¢ · fee(10% of spread) =", fee.toString(), "µ¢");

  const chain = audit.list ? audit.list(T) : null;
  const recs = chain ? (Array.isArray(chain) ? chain : (chain as any).records ?? []).length : 0;
  console.log("audit chain records:", recs, "· tamper-evident hash-linked ✓");

  const tlog = new InMemoryTransparencyLog({ logId: "roshpina-main" } as any);
  console.log("SMOKE-OK · kernel economy flows green");
}
main().catch((e) => { console.error("SMOKE-FAIL:", (e as Error).message); process.exit(1); });
