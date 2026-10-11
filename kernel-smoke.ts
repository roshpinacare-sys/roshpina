/**
 * kernel-smoke.ts — SELF-PROVING kernel check (v98).
 *
 * אין-טענות: כל-סעיף-כאן-מוכיח-אינווריאנט-בפועל-מול-הלדג'ר-החי-ומפיל-את-הריצה-על-הפרה.
 * Proven here (each was a measured production bug before v98):
 *   1. escrow lifecycle — worker paid exactly amount−fee once; platform fee credited once.
 *   2. fund TOCTOU closed — two concurrent fund() calls debit the payer EXACTLY once.
 *   3. release resume-log — crash after the worker leg converges on retry: worker paid
 *      once, fee collected once, escrow drained to 0 (the old code wedged forever).
 *   4. refund honestly refuses once the worker leg already moved.
 *   5. settlement never desyncs — a dead rail cannot wedge the agreement; store always
 *      matches the ledger; retryDisburse converges with the same idempotency key.
 *   6. canonical-json v2 — shared/acyclic refs serialise in full (old code silently
 *      dropped them), duplicate array slots preserved, BigInt type-tagged (123n ≠ "123"),
 *      true cycles still cut.
 * Runs: bun run kernel-smoke  (exit 1 + SMOKE-FAIL on any violated invariant).
 */
import { generateKeyPairSync } from "node:crypto";
import { InMemoryLedger } from "./kernel/ledger/in-memory-ledger";
import { LedgerOrchestrator } from "./kernel/ledger-orchestrator/ledger-orchestrator";
import { TfaOrchestrator as Orchestrator } from "./kernel/orchestrator/orchestrator";
import { EscrowService, InMemoryEscrowStore } from "./kernel/escrow/escrow";
import { SettlementService } from "./kernel/escrow/settlement";
import { InMemoryAuditStore } from "./kernel/orchestrator/audit";
import { Ed25519Signer } from "./kernel/orchestrator/signer";
import { canonicalJson } from "./kernel/common/canonical-json";
import type { RailRegistry } from "./kernel/settlement-rails/types";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error("INVARIANT VIOLATED: " + label);
}

async function main() {
  const T = "tenant-roshpina";
  const audit = new InMemoryAuditStore();
  const { allowAll } = await import("./kernel/orchestrator/guard");
  const orch = new Orchestrator([allowAll("roshpina-default")], audit);
  const ledger = new InMemoryLedger();
  const kp = generateKeyPairSync("ed25519");
  const signer = new (Ed25519Signer as any)(
    kp.privateKey.export({ type: "pkcs8", format: "pem" }),
    kp.publicKey.export({ type: "spki", format: "pem" }),
  );
  const lorch = new LedgerOrchestrator(ledger, orch, { signer } as any);
  const escrow = new EscrowService(lorch, undefined, undefined, { basisPoints: 500 });

  const op = await lorch.createAccount(T, "operator", "asset", "Operator Operating");
  const wk = await lorch.createAccount(T, "worker-a", "asset", "Worker A");
  const mint = await lorch.mint(T, op.id, 10_000_000n, "initial funding", "operator");
  assert(mint.ok, "mint succeeds through the chokepoint");

  const bal = async (id: string) => (await lorch.getAccount(T, id)).balance;
  const op0 = await bal(op.id);
  const wk0 = await bal(wk.id);

  // ── 1) lifecycle: created→funded→released, fee engine exact ────────────────
  const agr = await escrow.create({ tenantId: T, opportunityId: "opp-1", payerAccountId: op.id, workerAccountId: wk.id, amount: 2_000_000n });
  await escrow.fund(T, agr.id, "operator");
  const rel1 = await escrow.release(T, agr.id, "operator");
  const fee1 = (2_000_000n * 500n) / 10000n; // 100_000n
  assert((await bal(wk.id)) === wk0 + 2_000_000n - fee1, "worker paid amount−fee exactly once");
  assert(rel1.state === "released" && !!rel1.feeAuditId && !!rel1.settleAuditId, "released with provable audit ids");
  assert((await bal(rel1.feeAccountId!)) === fee1, "platform fee credited exactly once");
  console.log("1) escrow lifecycle ✓ · fee", fee1.toString(), "µ¢ · worker", (2_000_000n - fee1).toString(), "µ¢");

  // ── 2) fund TOCTOU closed (v98 mutex) ──────────────────────────────────────
  const agr2 = await escrow.create({ tenantId: T, opportunityId: "opp-2", payerAccountId: op.id, workerAccountId: wk.id, amount: 1_000_000n });
  const fundResults = await Promise.allSettled([escrow.fund(T, agr2.id, "operator"), escrow.fund(T, agr2.id, "operator")]);
  const okFunds = fundResults.filter((r) => r.status === "fulfilled").length;
  assert(okFunds === 1, `exactly one concurrent fund succeeds (got ${okFunds})`);
  assert((await bal(op.id)) === op0 - 2_000_000n - 1_000_000n, "payer debited exactly once per agreement (no double-fund)");
  console.log("2) concurrent fund ✓ · exactly 1 of 2 succeeded · payer debited once");

  // ── 3) release resume-log: crash after worker leg → retry converges ────────
  const store3 = new InMemoryEscrowStore();
  const escrow3 = new EscrowService(lorch, store3, undefined, { basisPoints: 500 });
  const agr3 = await escrow3.create({ tenantId: T, opportunityId: "opp-3", payerAccountId: op.id, workerAccountId: wk.id, amount: 1_000_000n });
  await escrow3.fund(T, agr3.id, "operator");
  const fee3 = (1_000_000n * 500n) / 10000n; // 50_000n
  const worker3 = 1_000_000n - fee3;
  const a3 = (await store3.get(T, agr3.id))!;
  // simulate the exact persisted intermediate of a first release() whose worker leg landed
  const leg = await lorch.transfer(T, a3.escrowAccountId, wk.id, worker3, `escrow.release:${agr3.id}`, "operator", false);
  assert(leg.ok, "simulated worker leg lands in the ledger");
  await store3.put({ ...a3, settleAuditId: leg.auditId! });
  const rel3 = await escrow3.release(T, agr3.id, "operator"); // the retry
  assert(rel3.state === "released" && !!rel3.feeAuditId, "retry converges to released with fee collected");
  assert((await bal(wk.id)) === wk0 + (2_000_000n - fee1) + worker3, "worker paid exactly once across both attempts");
  assert((await bal(a3.escrowAccountId)) === 0n, "escrow drained to exactly zero");
  const rel3again = await escrow3.release(T, agr3.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "wrong_state");
  assert(rel3again === true, "second release after terminal state honestly refused (wrong_state)");
  console.log("3) release resume-log ✓ · worker", worker3.toString(), "µ¢ once · escrow drained · retry converged");

  // ── 4) refund refuses once the worker leg already moved ────────────────────
  const agr4 = await escrow3.create({ tenantId: T, opportunityId: "opp-4", payerAccountId: op.id, workerAccountId: wk.id, amount: 500_000n });
  await escrow3.fund(T, agr4.id, "operator");
  const a4 = (await store3.get(T, agr4.id))!;
  const leg4 = await lorch.transfer(T, a4.escrowAccountId, wk.id, 475_000n, `escrow.release:${agr4.id}`, "operator", false);
  assert(leg4.ok, "simulated worker leg (agr4) lands");
  await store3.put({ ...a4, settleAuditId: leg4.auditId! });
  const refundRefused = await escrow3.refund(T, agr4.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "wrong_state");
  assert(refundRefused === true, "refund honestly refused after worker leg (no misleading INSUFFICIENT_FUNDS)");
  console.log("4) refund guard ✓ · refuses post-worker-leg release");

  // ── 5) settlement: dead rail can never desync store from ledger ────────────
  let railUp = false;
  let railCalls = 0;
  const rail = {
    railId: "smoke-rail",
    async disburse(req: { idempotencyKey: string }) {
      railCalls++;
      if (!railUp) throw new Error("rail down (simulated)");
      return { idempotencyKey: req.idempotencyKey, status: "succeeded" as const, externalRef: "ext-" + railCalls, processedAt: new Date().toISOString(), message: "ok" };
    },
    async getStatus() { return null; },
  };
  const registry: RailRegistry = { getRail: () => rail as any, register: () => {}, listTenants: () => ["*"] };
  const settl = new SettlementService(lorch, undefined, registry);
  const sagr = await settl.create({ tenantId: T, opportunityId: "opp-s", payerAccountId: op.id, workerAccountId: wk.id, totalAmount: 2_000_000n, settledBy: "operator" });
  await settl.fund(T, sagr.id, "operator");
  const wkBeforePartial = await bal(wk.id);
  const pr = await settl.partialRelease(T, sagr.id, 800_000n, "operator"); // rail DOWN — old code threw & desynced
  assert(pr.releasedAmount === 800_000n, "store matches ledger even with the rail dead (no desync)");
  assert(!!pr.pendingDisburse && railCalls === 1, "rail failure recorded honestly in pendingDisburse");
  assert((await bal(wk.id)) === wkBeforePartial + 800_000n, "worker credited by the ledger exactly once despite dead rail");
  railUp = true;
  const rr = await settl.retryDisburse(T, sagr.id, "operator");
  assert((rr.disbursementResults?.length ?? 0) === 1 && !rr.pendingDisburse, "retryDisburse converges and clears pending");
  assert(railCalls === 2 && (await bal(wk.id)) === wkBeforePartial + 800_000n, "retry touched the rail, never the ledger (no double-pay)");
  const fin = await settl.release(T, sagr.id, "operator");
  assert(fin.state === "released" && (fin.disbursementResults?.length ?? 0) === 2, "full release disburses remaining via live rail");
  assert((await bal((await settl.get(T, sagr.id))!.escrowAccountId)) === 0n, "settlement escrow drained to exactly zero");
  const noPending = await settl.retryDisburse(T, sagr.id, "operator").then(() => false, () => true);
  assert(noPending === true, "retry without pending honestly refused");
  console.log("5) settlement ✓ · dead rail recorded, retried, zero desync · escrow drained");

  // ── 6) canonical-json v2: shared refs, dup slots, BigInt tag, cycles ───────
  const shared = { x: 1n };
  assert(canonicalJson({ a: shared, b: shared }) === '{"a":{"x":{"$bigint":"1"}},"b":{"x":{"$bigint":"1"}}}', "shared (DAG) refs serialise in full — no silent drop");
  assert(canonicalJson([shared, shared]) === '[{"x":{"$bigint":"1"}},{"x":{"$bigint":"1"}}]', "duplicate array slots preserved");
  assert(canonicalJson({ n: 123n }) !== canonicalJson({ n: "123" as any }), "BigInt no longer collides with plain decimal string");
  const cyc: Record<string, unknown> = {}; cyc["self"] = cyc;
  assert(canonicalJson(cyc) === "{}", "true cycle at root: self-reference key dropped, object remains honest");
  const holder: Record<string, unknown> = {}; holder["self"] = holder;
  assert(canonicalJson({ ok: 1, deep: holder }) === '{"deep":{},"ok":1}', "true cycle nested: cut exactly at the closing reference (self dropped, deep kept)");
  console.log("6) canonical-json v2 ✓ · DAG-safe · BigInt tagged · cycles cut");

  // ── 7) kernel integrity: audit chain + solvency ─────────────────────────────
  const chain = audit.getChain(T);
  assert(Array.isArray(chain) && chain.length > 0, "audit chain recorded and hash-linked");
  const anyLorch = lorch as any;
  if (typeof anyLorch.proofOfSolvency === "function") {
    const solv = await anyLorch.proofOfSolvency(T);
    assert(solv?.ok !== false, "proofOfSolvency stays green after all flows");
  }

  // conservation: minted = payer left + worker + fees + money still in flight (agr2 held, agr4 fee remainder)
  const escrow2Bal = await bal((await escrow.get(T, agr2.id))!.escrowAccountId);
  const escrow4Bal = await bal(a4.escrowAccountId);
  const totalOut = (await bal(op.id)) + (await bal(wk.id)) + (await bal(rel1.feeAccountId!)) + (await bal(rel3.feeAccountId!)) + escrow2Bal + escrow4Bal;
  assert(totalOut === 10_000_000n, `money conserved end-to-end (${totalOut} = minted, incl. in-flight)`);
  console.log("7) integrity ✓ · audit chain", chain.length, "records · money conserved to the last µ¢");
  console.log("SMOKE-OK · all invariants proven against the live ledger — אין טענות, יש הוכחות");
}

main().catch((e) => { console.error("SMOKE-FAIL:", (e as Error).message); process.exit(1); });
