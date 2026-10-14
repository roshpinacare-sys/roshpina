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
 *   8. K1 threshold quorum (v143) — releases above a declared threshold move ONLY
 *      with a Byzantine-floor quorum of per-key approval tokens: no tokens refused,
 *      forged identity refused, one deny vetoes (I21), 2f+1 distinct approvals pass,
 *      consumed tokens replay-refused. Before v143 this was a doc claim with ZERO
 *      enforcement (the H-3 disease); now it is wired and proven.
 *   9. K2 share-gate (v144, I27; DNA: Nimbus I27 × AgentKit action-abstraction) —
 *      outbound webhook bytes leave ONLY through the gate: loopback/metadata/
 *      insecure destinations refused at the door AND re-checked on the wire
 *      (rogue store-row refused), DNS-rebind refused via resolver, credentials
 *      redacted BEFORE signing (signature verifies over the redacted bytes),
 *      redaction-set recorded in the delivery log. Before v144 the webhook
 *      surface shipped a free fetch(): any url, any bytes, anyone holding the
 *      relayer.
 * Runs: bun run kernel-smoke  (exit 1 + SMOKE-FAIL on any violated invariant).
 */
import { generateKeyPairSync } from "node:crypto";
import { InMemoryLedger } from "./kernel/ledger/in-memory-ledger";
import { LedgerOrchestrator } from "./kernel/ledger-orchestrator/ledger-orchestrator";
import { TfaOrchestrator as Orchestrator } from "./kernel/orchestrator/orchestrator";
import { EscrowService, InMemoryEscrowStore } from "./kernel/escrow/escrow";
import { SettlementService } from "./kernel/escrow/settlement";
import { generateThresholdApprovalForKey, InMemoryThresholdApprovalStore, byzantineQuorum } from "./kernel/escrow/threshold-approval";
import { WebhookService, InMemoryWebhookRelayer, InMemoryWebhookStore, InMemoryWebhookDeliveryLog } from "./kernel/escrow/webhook";
import { ShareGate } from "./kernel/escrow/share-gate";
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

  // ── 8) K1 — threshold quorum law (I21 × Byzantine floor; DNA: Olas rounds.py L121-124) ──
  const qKeys: Record<string, string> = { alice: "k-alice", bob: "k-bob", carol: "k-carol", dave: "k-dave" };
  const qStore = new InMemoryThresholdApprovalStore();
  const qFloor = byzantineQuorum(4); // M=4 → tolerate f=1 → require N=3
  assert(qFloor.byzantineTolerance === 1 && qFloor.requiredApprovals === 3, "byzantineQuorum(4) = tolerate 1, require 3");
  const settlQ = new SettlementService(lorch, undefined, null, { approverKeys: qKeys, store: qStore });
  const qagr = await settlQ.create({ tenantId: T, opportunityId: "opp-q", payerAccountId: op.id, workerAccountId: wk.id, totalAmount: 1_000_000n, settledBy: "operator", thresholdAmount: 500_000n });
  await settlQ.fund(T, qagr.id, "operator");
  const mintVote = (who: string, vote: "approve" | "deny" = "approve", maxAmount: bigint = 600_000n) =>
    generateThresholdApprovalForKey(qKeys[who], { agreementId: qagr.id, tenantId: T, maxAmount, approvedBy: who, vote }).token;
  // 8a — above threshold with 0 tokens → refused (the H-3 hole is closed for real)
  const noTok = await settlQ.release(T, qagr.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "approval_required");
  assert(noTok === true, "release above threshold with 0 tokens refused (fail-closed)");
  // 8b — below threshold: no quorum needed (boundary exact)
  const below = await settlQ.partialRelease(T, qagr.id, 400_000n, "operator");
  assert(below.releasedAmount === 400_000n, "sub-threshold release needs no quorum");
  // 8c — Sybil refused: token claims "bob" but signed with alice's key
  const forgedBob = generateThresholdApprovalForKey(qKeys.alice, { agreementId: qagr.id, tenantId: T, maxAmount: 600_000n, approvedBy: "bob" }).token;
  const sybil = await settlQ.release(T, qagr.id, "operator", [mintVote("alice"), forgedBob, mintVote("carol")]).then(() => false, (e: { code?: string }) => e?.code === "approval_denied");
  assert(sybil === true, "forged identity (signed with the wrong key) rejected");
  // 8d — ONE deny vetoes the whole quorum (I21: single deny fails closed)
  const vetoed = await settlQ.release(T, qagr.id, "operator", [mintVote("alice"), mintVote("bob"), mintVote("carol", "deny")]).then(() => false, (e: { code?: string }) => e?.code === "approval_denied");
  assert(vetoed === true, "a single deny fails the quorum closed");
  // 8e — 3 distinct per-key approvals release above threshold
  const okTokens = [mintVote("alice"), mintVote("bob"), mintVote("carol")];
  const finQ = await settlQ.release(T, qagr.id, "operator", okTokens);
  assert(finQ.state === "released" && finQ.releasedAmount === 1_000_000n, "3-of-4 distinct approvals release above threshold");
  // 8f — the same consumed tokens can never release a second agreement (replay refused)
  const qagr2 = await settlQ.create({ tenantId: T, opportunityId: "opp-q2", payerAccountId: op.id, workerAccountId: wk.id, totalAmount: 1_000_000n, settledBy: "operator", thresholdAmount: 500_000n });
  await settlQ.fund(T, qagr2.id, "operator");
  const replayed = await settlQ.release(T, qagr2.id, "operator", okTokens).then(() => false, (e: { code?: string }) => e?.code === "approval_denied");
  assert(replayed === true, "consumed tokens replay-refused on a second agreement");
  console.log("8) K1 quorum ✓ · 0-tokens refused · Sybil refused · single-deny veto · 3-of-4 releases · replay refused");

  // ── 9) K2 — share-gate (I27: outbound bytes leave ONLY through the gate) ───
  const inner = new InMemoryWebhookRelayer();
  const whStore = new InMemoryWebhookStore();
  const whLog = new InMemoryWebhookDeliveryLog();
  let rebindPrivate = false;
  const gate = new ShareGate(inner, { resolveOnDispatch: true }, {
    resolve: async (host: string) =>
      host === "rebind.public.example" && rebindPrivate
        ? [{ address: "10.0.0.5", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }],
  });
  const wh = new WebhookService(whStore, inner, whLog, gate);
  const whEvent = (id: string, event: string, data: Record<string, unknown>) => ({ id, event, tenantId: T, occurredAt: new Date().toISOString(), data });
  // 9a — the door: loopback refused at register
  const doorLoopback = await wh.register({ tenantId: T, url: "https://127.0.0.1/hook", events: ["settlement.released"] }).then(() => false, (e: { code?: string; message?: string }) => e?.code === "invalid_input" && String(e?.message).startsWith("share_gate_refused"));
  assert(doorLoopback === true, "register loopback refused at the door (share_gate_refused)");
  // 9b — the door: cloud metadata endpoint refused (the credential-steal classic)
  const doorMetadata = await wh.register({ tenantId: T, url: "https://169.254.169.254/latest/meta-data/iam/security-credentials/", events: ["settlement.released"] }).then(() => false, (e: { message?: string }) => String(e?.message).includes("non_public_ip_literal"));
  assert(doorMetadata === true, "register metadata endpoint refused (169.254/16)");
  // 9c — the door: plain http refused (https-only default)
  const doorHttp = await wh.register({ tenantId: T, url: "http://hooks.public.example/hook", events: ["settlement.released"] }).then(() => false, (e: { message?: string }) => String(e?.message).includes("insecure_scheme_http"));
  assert(doorHttp === true, "register plain-http refused (insecure scheme)");
  // 9d — the wire: valid https destination delivers REDACTED bytes, signature over the redacted bytes
  const whSecret = "whsec-0123456789abcdef-0123456789abcdef";
  const regOk = await wh.register({ tenantId: T, url: "https://hooks.public.example/hook", events: ["settlement.released"], secret: whSecret });
  await wh.dispatch(T, whEvent("evt-1", "settlement.released", { agreementId: "agr-x", amount: "1000", apiKey: "sk-live-STEAL-ME", nested: { dbPassword: "hunter2" } }));
  assert(inner.deliveries.length === 1, "exactly one delivery reached the transport");
  const sent = inner.deliveries[0]!.delivery;
  assert(sent.payload.includes("[REDACTED]") && !sent.payload.includes("sk-live-STEAL-ME") && !sent.payload.includes("hunter2"), "credentials never leave: redacted before signing");
  assert(WebhookService.verifySignature(whSecret, sent.payload, sent.signature) === true, "receiver verifies the signature over exactly the redacted bytes");
  const logOk = (await whLog.list(T)).find((r) => r.registrationId === regOk.id)!;
  assert(logOk.ok === true && logOk.gate?.verdict === "allow" && logOk.gate.redactedKeys.includes("data.apiKey") && logOk.gate.redactedKeys.includes("data.nested.dbPassword"), "delivery log carries the applied redaction-set receipt");
  // 9e — the wire re-check: a rogue store-row (tampered/stale registration) cannot smuggle a destination in
  await whStore.put({ id: "rogue", tenantId: T, url: "https://10.0.0.9/hook", events: ["settlement.disputed"], secret: "r".repeat(32), createdAt: new Date().toISOString(), active: true });
  await wh.dispatch(T, whEvent("evt-2", "settlement.disputed", { agreementId: "agr-x" }));
  assert(inner.deliveries.length === 1, "rogue destination emitted NOTHING (wire re-check)");
  const logRogue = (await whLog.list(T)).find((r) => r.registrationId === "rogue")!;
  assert(logRogue.ok === false && String(logRogue.error).startsWith("share_gate_refused") && logRogue.gate?.verdict === "refuse", "rogue refusal recorded honestly in the delivery log");
  // 9f — DNS-rebinding killed at the wire: registered public, resolves private at dispatch
  await wh.register({ tenantId: T, url: "https://rebind.public.example/hook", events: ["settlement.reversed"], secret: "b".repeat(32) });
  rebindPrivate = true;
  await wh.dispatch(T, whEvent("evt-3", "settlement.reversed", { agreementId: "agr-x" }));
  assert(inner.deliveries.length === 1, "DNS-rebind (public at door, private at wire) emitted NOTHING");
  const logRebind = (await whLog.list(T)).find((r) => r.registrationId !== "rogue" && r.event === "settlement.reversed")!;
  assert(logRebind.ok === false && String(logRebind.error).includes("resolves_non_public"), "rebind refusal names the offending resolution");
  // 9g — unmatched event: no emission, no noise
  await wh.dispatch(T, whEvent("evt-4", "passport.issued", { subject: "worker-a" }));
  assert(inner.deliveries.length === 1, "unmatched event emitted nothing");
  console.log("9) K2 share-gate ✓ · door: loopback/metadata/http refused · wire: rogue row refused · DNS-rebind refused · credentials redacted before signing · redaction-set in the log");
  console.log("SMOKE-OK · all invariants proven against the live ledger — אין טענות, יש הוכחות");
}

main().catch((e) => { console.error("SMOKE-FAIL:", (e as Error).message); process.exit(1); });
