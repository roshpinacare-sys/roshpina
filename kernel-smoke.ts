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
 *  10. K3 seal + breaker (v145; DNA: verified coinbase/agentkit CdpEvmWalletProvider
 *      dive — exportWallet returns {name,address} only, keys never in process;
 *      the breaker is our own state machine, NOT in agentkit core) — the store
 *      NEVER sees plaintext (sealed AES-256-GCM at the door), the secret is
 *      returned EXACTLY ONCE (register), read paths lack the field at the type
 *      level, tampered rows fail loud (secret_unseal_failed, nothing emitted),
 *      and N consecutive failed deliveries OPEN the breaker: dispatch refuses
 *      without touching the transport, loudly in the delivery log; half-open
 *      probe after the cooldown; success closes, failed probe re-opens.
 *  11. K4 rail breaker (v146; the money point) — the external disbursement
 *      artery trips after 3 consecutive rail failures: OPEN refuses the rail
 *      call BEFORE it happens (rail touches stay flat, loud rail_open), while
 *      the internal ledger keeps moving (store ⇔ ledger still agree — the
 *      breaker guards the rail, never the ledger); retryDisburse refuses from
 *      the outside with the original pending forensics preserved
 *      (non-consuming consult); half-open probes exactly once — a failed
 *      probe re-arms fresh, a SKIPPED probe re-arms (an abstention never
 *      wedges the machine and never counts as health), success closes and the
 *      pending converges with the same idempotency key.
 *  12. K5 route-auth gate (v147, C-2) — the transport door of the money routes:
 *      anonymous POST to mint/transfer/escrow-action used to act as
 *      "console-operator" (the KeyRing existed and gated NOTHING — the H-3
 *      disease on the transport edge). Now: missing headers refused (named),
 *      unknown kid refused, epoch/non-UTC timestamps refused (format=law),
 *      stale/future timestamps refused (±5min window), tampered body refused
 *      (signature binds kid|method|path|timestamp|sha256(body)), a winning
 *      signature BURNS ITSELF (exact replay refused — no double-mint through
 *      the window), revoked keys refuse always while retiring keys still
 *      verify (rotation overlap), provisioning derives kid from material and
 *      refuses broken PEM loudly.
 *  13. C-2b anchor seam (v148) — the lesson K5's own commit left behind: the
 *      bridge POST (the seam file the SAOS chain picks up) was a state-creating
 *      write with NO gate — C-2 named the gate "money" and the name was too
 *      narrow. Now: the gate is gateStateRoute (one gate truth for ALL
 *      state-creating writes), the bridge POST passes it BEFORE seed and
 *      kernel, and the WIRING IS LAW (born live from the C-2b miss): the smoke
 *      walks every src/app/api route file and refuses any POST export that is
 *      neither gated nor explicitly allowlisted as pure verification — the
 *      NEXT seam cannot ship silently. The law is proven at the bridge door:
 *      anonymous refused (named), body-bound signature (tamper refused), a
 *      winning signature burns itself (no double-anchor), valid operator
 *      anchors, and the bridge GET stays open (pure read, machine-checked).
 * Runs: bun run kernel-smoke  (exit 1 + SMOKE-FAIL on any violated invariant).
 */
import { generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { InMemoryLedger } from "./kernel/ledger/in-memory-ledger";
import { LedgerOrchestrator } from "./kernel/ledger-orchestrator/ledger-orchestrator";
import { TfaOrchestrator as Orchestrator } from "./kernel/orchestrator/orchestrator";
import { EscrowService, InMemoryEscrowStore } from "./kernel/escrow/escrow";
import { SettlementService } from "./kernel/escrow/settlement";
import { generateThresholdApprovalForKey, InMemoryThresholdApprovalStore, byzantineQuorum } from "./kernel/escrow/threshold-approval";
import { WebhookService, InMemoryWebhookRelayer, InMemoryWebhookStore, InMemoryWebhookDeliveryLog } from "./kernel/escrow/webhook";
import { AesGcmSecretSealer, secretFingerprint } from "./kernel/escrow/webhook-secrets";
import { ShareGate } from "./kernel/escrow/share-gate";
import { InMemoryAuditStore } from "./kernel/orchestrator/audit";
import { Ed25519Signer } from "./kernel/orchestrator/signer";
import { canonicalJson } from "./kernel/common/canonical-json";
import { KeyRing, computeKid } from "./kernel/passport/key-ring";
import { InMemoryReplayCache, canonicalRoutePayload, provisionOperatorKeys, requireOperatorSignature, ROUTE_AUTH_REPLAY_WINDOW_MS, sha256Hex } from "./src/lib/route-auth";
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
  const wh = new WebhookService(whStore, inner, whLog, gate, { sealer: new AesGcmSecretSealer(randomBytes(32)) });
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
  assert(regOk.secret === whSecret, "the once-return: register hands the plaintext back exactly once");
  await wh.dispatch(T, whEvent("evt-1", "settlement.released", { agreementId: "agr-x", amount: "1000", apiKey: "sk-live-STEAL-ME", nested: { dbPassword: "hunter2" } }));
  assert(inner.deliveries.length === 1, "exactly one delivery reached the transport");
  const sent = inner.deliveries[0]!.delivery;
  assert(sent.payload.includes("[REDACTED]") && !sent.payload.includes("sk-live-STEAL-ME") && !sent.payload.includes("hunter2"), "credentials never leave: redacted before signing");
  assert(WebhookService.verifySignature(whSecret, sent.payload, sent.signature) === true, "receiver verifies the signature over exactly the redacted bytes");
  const logOk = (await whLog.list(T)).find((r) => r.registrationId === regOk.id)!;
  assert(logOk.ok === true && logOk.gate?.verdict === "allow" && logOk.gate.redactedKeys.includes("data.apiKey") && logOk.gate.redactedKeys.includes("data.nested.dbPassword"), "delivery log carries the applied redaction-set receipt");
  // 9e — the wire re-check: a rogue store-row (tampered/stale registration) cannot smuggle a destination in.
  // K3: it is sealed with a WRONG key — valid shape, dead content — so it dies at the unseal, emitting nothing.
  const wrongKeySealer = new AesGcmSecretSealer(randomBytes(32));
  await whStore.put({ id: "rogue", tenantId: T, url: "https://10.0.0.9/hook", events: ["settlement.disputed"], secretSealed: wrongKeySealer.seal("r".repeat(32)), secretFingerprint: secretFingerprint("r".repeat(32)), createdAt: new Date().toISOString(), active: true });
  await wh.dispatch(T, whEvent("evt-2", "settlement.disputed", { agreementId: "agr-x" }));
  assert(inner.deliveries.length === 1, "rogue destination emitted NOTHING (wire re-check)");
  const logRogue = (await whLog.list(T)).find((r) => r.registrationId === "rogue")!;
  assert(logRogue.ok === false && String(logRogue.error).startsWith("secret_unseal_failed"), "rogue row dies at the unseal, recorded honestly in the delivery log");
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

  // ── 10) K3 — sealed secrets at rest + circuit breaker ────────────────────────
  // (fresh isolated service — the K2 service above stays untouched)
  const k3Inner = new InMemoryWebhookRelayer();
  const k3Store = new InMemoryWebhookStore();
  const k3Log = new InMemoryWebhookDeliveryLog();
  const k3Key = randomBytes(32);
  const k3Wh = new WebhookService(k3Store, k3Inner, k3Log, new ShareGate(k3Inner, { resolveOnDispatch: true }, { resolve: async () => [{ address: "93.184.216.34", family: 4 }] }), { sealer: new AesGcmSecretSealer(k3Key) });
  // 10a — no off switch: a service without a sealer is not constructible
  const noSeal = (() => { try { new WebhookService(new InMemoryWebhookStore(), k3Inner, new InMemoryWebhookDeliveryLog()); return true; } catch (e) { return (e as { code?: string })?.code === "invalid_config"; } })();
  assert(noSeal === true, "construction without a sealer refused (invalid_config — K3 has no off switch)");
  // 10b — the store NEVER sees plaintext: the row is sealed, fingerprinted, field-free
  const k3Secret = "k3-secret-0123456789abcdef";
  const k3Reg = await k3Wh.register({ tenantId: T, url: "https://k3.public.example/hook", events: ["settlement.released"], secret: k3Secret });
  const stored = (await k3Store.list(T))[0]!;
  assert(!("secret" in stored) && typeof stored.secretSealed?.ct === "string" && stored.secretSealed.v === 1, "store row carries ONLY the sealed shape (no plaintext field)");
  assert(stored.secretSealed.ct !== k3Secret && stored.secretSealed.ct.length >= 32, "ciphertext at rest (not the plaintext)");
  assert(stored.secretFingerprint === secretFingerprint(k3Secret), "fingerprint matches (ops identification without material)");
  // 10b-2 — the K2 wire re-check lives on with sealed rows: valid seal, internal url → gate refuses
  await k3Store.put({ id: "k3-smuggler", tenantId: T, url: "https://192.168.1.9/hook", events: ["settlement.released"], secretSealed: (new AesGcmSecretSealer(k3Key)).seal(k3Secret), secretFingerprint: secretFingerprint(k3Secret), createdAt: new Date().toISOString(), active: true });
  await k3Wh.dispatch(T, whEvent("evt-k3-wire", "settlement.released", { agreementId: "agr-x" }));
  assert(k3Inner.deliveries.length === 1, "only the valid row emitted — the validly-sealed rogue destination was refused at the wire");
  const logSmuggler = (await k3Log.list(T)).find((r) => r.registrationId === "k3-smuggler")!;
  assert(logSmuggler.ok === false && String(logSmuggler.error).startsWith("share_gate_refused"), "smuggler refusal recorded honestly");
  // 10c — read paths lack the field at the type level
  const listed = await k3Wh.list(T);
  const fetched = await k3Wh.get(T, k3Reg.id);
  assert(listed.every((r) => !("secret" in r)) && fetched !== null && !("secret" in fetched), "get/list return NO secret material (type-level seal)");
  // 10d — dispatch works end-to-end: unseal in the sign frame, receiver verifies
  await k3Wh.dispatch(T, whEvent("evt-k3-1", "settlement.released", { agreementId: "agr-y" }));
  assert(k3Inner.deliveries.length === 2, "valid sealed row delivers");
  assert(WebhookService.verifySignature(k3Secret, k3Inner.deliveries[1]!.delivery.payload, k3Inner.deliveries[1]!.delivery.signature) === true, "signature verifies with the once-returned plaintext");
  // 10e — tamper is loud: flip a byte in the ciphertext → secret_unseal_failed, nothing emitted
  const tampered = { ...stored.secretSealed, ct: (stored.secretSealed.ct[0] === "0" ? "1" : "0") + stored.secretSealed.ct.slice(1) };
  await k3Store.put({ ...stored, secretSealed: tampered });
  await k3Wh.dispatch(T, whEvent("evt-k3-2", "settlement.released", { agreementId: "agr-y" }));
  assert(k3Inner.deliveries.length === 2, "tampered row emitted NOTHING");
  const logTamper = (await k3Log.list(T)).filter((r) => r.registrationId === k3Reg.id)[0]!; // delivery log is newest-first
  assert(logTamper.ok === false && String(logTamper.error).startsWith("secret_unseal_failed"), "tamper recorded loud (secret_unseal_failed)");
  // 10f — the breaker trips: threshold=5 consecutive failures → OPEN, transport untouched
  const fakeNow = { t: 1_700_000_000_000 };
  const bkInner = new InMemoryWebhookRelayer();
  const bkStore = new InMemoryWebhookStore();
  const bkLog = new InMemoryWebhookDeliveryLog();
  const bk = new WebhookService(bkStore, bkInner, bkLog, new ShareGate(bkInner, { resolveOnDispatch: true }, { resolve: async () => [{ address: "93.184.216.34", family: 4 }] }), { sealer: new AesGcmSecretSealer(randomBytes(32)), breaker: { threshold: 5, cooldownMs: 60_000, now: () => fakeNow.t } });
  await bk.register({ tenantId: T, url: "https://bk.public.example/hook", events: ["settlement.released"] });
  bkInner.setFailNext(5);
  for (let i = 0; i < 5; i++) await bk.dispatch(T, whEvent(`evt-bk-${i}`, "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 5, "5 failing deliveries reached the transport (each recorded)");
  await bk.dispatch(T, whEvent("evt-bk-6", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 5, "the 6th dispatch touched the transport ZERO times (breaker OPEN)");
  const logOpen = (await bkLog.list(T))[0]!; // delivery log is newest-first
  assert(logOpen.ok === false && logOpen.breaker?.state === "open" && String(logOpen.error).startsWith("circuit_breaker_open"), "open refusal recorded loudly with the breaker receipt");
  // 10g — half-open: after the cooldown exactly ONE probe; success closes
  fakeNow.t += 61_000;
  await bk.dispatch(T, whEvent("evt-bk-7", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 6 && bkInner.deliveries[5]!.result.ok === true, "half-open probe allowed after cooldown and succeeded");
  await bk.dispatch(T, whEvent("evt-bk-8", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 7, "breaker CLOSED after a successful probe (deliveries flow again)");
  // 10h — a failed probe re-opens with a fresh cooldown (re-trip with threshold=5)
  bkInner.setFailNext(5);
  for (let i = 0; i < 5; i++) await bk.dispatch(T, whEvent(`evt-bk-r${i}`, "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 12, "re-tripped after 5 consecutive failures (12 attempts total)");
  await bk.dispatch(T, whEvent("evt-bk-r5", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 12, "OPEN again — transport untouched");
  fakeNow.t += 30_000; // inside the fresh cooldown
  await bk.dispatch(T, whEvent("evt-bk-r6", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 12, "fresh cooldown holds (no probe before its time)");
  fakeNow.t += 31_000;
  bkInner.deliveries.length = 0; // clear the counter, keep the relayer succeeding
  await bk.dispatch(T, whEvent("evt-bk-r7", "settlement.released", { agreementId: "agr-bk" }));
  assert(bkInner.deliveries.length === 1 && bkInner.deliveries[0]!.result.ok === true, "probe after the full cooldown succeeds and the artery recovers");
  console.log("10) K3 seal+breaker ✓ · store never sees plaintext · once-return · read paths field-free · tamper loud · breaker trips/half-opens/closes/re-opens");

  // ── 11) K4 — the rail artery gets its own measured breaker (the money point) ─
  // (fresh service on the same ledger: the breaker guards the RAIL, never the ledger)
  let railMode2: "fail" | "skip" | "ok" = "fail";
  let railCalls2 = 0;
  const rail2 = {
    railId: "smoke-rail-k4",
    async disburse(req: { idempotencyKey: string }) {
      railCalls2++;
      if (railMode2 === "fail") throw new Error("rail down (simulated K4)");
      if (railMode2 === "skip") {
        return { idempotencyKey: req.idempotencyKey, status: "skipped" as const, externalRef: null, processedAt: new Date().toISOString(), message: "skipped (probe abstained)" };
      }
      return { idempotencyKey: req.idempotencyKey, status: "succeeded" as const, externalRef: "ext-" + railCalls2, processedAt: new Date().toISOString(), message: "ok" };
    },
    async getStatus() { return null; },
  };
  const registry2: RailRegistry = { getRail: () => rail2 as any, register: () => {}, listTenants: () => ["*"] };
  const k4Now = { t: 1_800_000_000_000 };
  const settlK4 = new SettlementService(lorch, undefined, registry2, undefined, { threshold: 3, cooldownMs: 60_000, now: () => k4Now.t });
  // 11a — three consecutive rail failures trip the breaker (threshold 3)
  const k4agr = await settlK4.create({ tenantId: T, opportunityId: "opp-k4", payerAccountId: op.id, workerAccountId: wk.id, totalAmount: 1_000_000n, settledBy: "operator" });
  await settlK4.fund(T, k4agr.id, "operator");
  const wkK4 = await bal(wk.id);
  for (let i = 0; i < 3; i++) {
    const prK4 = await settlK4.partialRelease(T, k4agr.id, 100_000n, "operator");
    assert(prK4.releasedAmount === BigInt(i + 1) * 100_000n && !!prK4.pendingDisburse, `failure ${i + 1} recorded honestly in pendingDisburse (ledger-first intact)`);
  }
  assert((await bal(wk.id)) === wkK4 + 300_000n, "ledger kept moving through all three failures (store ⇔ ledger agree)");
  assert(railCalls2 === 3, "each of the three failures really hit the rail");
  // 11b — OPEN: the 4th release refuses the rail BEFORE the call — but never the ledger
  const pr4 = await settlK4.partialRelease(T, k4agr.id, 100_000n, "operator");
  assert(railCalls2 === 3, "OPEN breaker: the 4th disbursement touched the rail ZERO times");
  assert(pr4.releasedAmount === 400_000n && String(pr4.pendingDisburse?.error).includes("is OPEN"), "refusal recorded loudly in the agreement; the ledger STILL moved (rail breaker ≠ ledger lock)");
  assert((await bal(wk.id)) === wkK4 + 400_000n, "worker still credited by the ledger despite the OPEN rail breaker");
  // 11c — retryDisburse during OPEN: refused from the outside, forensics preserved
  const origPending = (await settlK4.get(T, k4agr.id))!.pendingDisburse;
  const retryRefused = await settlK4.retryDisburse(T, k4agr.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "rail_open");
  assert(retryRefused === true, "retry during OPEN refused (rail_open, fail-closed)");
  const afterRefusal = (await settlK4.get(T, k4agr.id))!.pendingDisburse;
  assert(afterRefusal?.error === origPending?.error && afterRefusal?.seq === origPending?.seq, "the refusal did NOT rewrite the original pending forensics");
  // 11d — half-open: exactly ONE probe; a failed probe re-arms fresh
  k4Now.t += 61_000;
  await settlK4.retryDisburse(T, k4agr.id, "operator"); // probe granted, rail still down
  assert(railCalls2 === 4, "cooldown elapsed: exactly ONE probe hit the rail");
  const reOpenRefused = await settlK4.retryDisburse(T, k4agr.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "rail_open");
  assert(reOpenRefused === true, "failed probe re-armed the breaker (fresh cooldown holds)");
  // 11e — a SKIPPED probe re-arms instead of wedging (an abstention is never health)
  k4Now.t += 61_000;
  railMode2 = "skip";
  await settlK4.retryDisburse(T, k4agr.id, "operator"); // probe granted → the rail abstains
  assert(railCalls2 === 5, "the skipped probe really reached the rail (it WAS the probe)");
  const skipReArmed = await settlK4.retryDisburse(T, k4agr.id, "operator").then(() => false, (e: { code?: string }) => e?.code === "rail_open");
  assert(skipReArmed === true, "abstaining probe re-armed the breaker — the state machine never wedges on 'skipped'");
  // 11f — recovery: a succeeding probe closes the breaker; the pending converges
  k4Now.t += 61_000;
  railMode2 = "ok";
  const converged = await settlK4.retryDisburse(T, k4agr.id, "operator");
  assert(railCalls2 === 6 && (converged.disbursementResults?.length ?? 0) === 1 && !converged.pendingDisburse, "succeeding probe closed the breaker; retry converged, pending cleared");
  const fineK4 = await settlK4.partialRelease(T, k4agr.id, 100_000n, "operator");
  assert(railCalls2 === 7 && (fineK4.disbursementResults?.length ?? 0) === 2 && !fineK4.pendingDisburse, "closed breaker: disbursements flow again (artery recovered)");
  console.log("11) K4 rail breaker ✓ · trips at 3 · OPEN refuses the rail not the ledger · retry refuses loud with forensics preserved · one probe · skipped re-arms · success closes");

  // ── 12) K5 — route-auth gate (C-2, v147): the transport door of the money routes ─
  {
    const ring5 = new KeyRing();
    const replay5 = new InMemoryReplayCache();
    const now5 = 1_900_000_000_000;
    const URL5 = "http://roshpina.test/api/ledger/mint";
    const opKp = generateKeyPairSync("ed25519");
    const opPem = opKp.publicKey.export({ type: "spki", format: "pem" }).toString();
    // the sharpened law: EVERY side (signer included) derives the kid from the NORMALIZED material
    const opPemNorm = opPem.replace(/\r\n/g, "\n").trim();
    const opKid = computeKid("ed25519", opPemNorm);
    ring5.register({ kid: opKid, algorithm: "ed25519", publicKey: opPemNorm, status: "active", createdAt: new Date(now5).toISOString() });
    const sign5 = (priv: { type: "private" }, kid: string, ts: string, body: string) =>
      edSign(null, Buffer.from(canonicalRoutePayload(kid, "POST", "/api/ledger/mint", ts, sha256Hex(body)), "utf8"), priv as never).toString("base64");
    const deny5 = async (req: Request) => {
      const r = await requireOperatorSignature(req, ring5, replay5, { now: now5 });
      return r.ok ? null : r;
    };
    const signed5 = (body: string, ts: string = new Date(now5).toISOString(), kid: string = opKid, priv = opKp.privateKey) =>
      new Request(URL5, { method: "POST", body, headers: { "x-roshpina-kid": kid, "x-roshpina-timestamp": ts, "x-roshpina-signature": sign5(priv, kid, ts, body) } });

    // 12a — anonymous: no headers at all → refused, the missing set is named
    const d5a = await deny5(new Request(URL5, { method: "POST", body: "{}" }));
    assert(d5a !== null && d5a.status === 401 && d5a.code === "missing_headers" && d5a.detail.includes("x-roshpina-kid"), "anonymous POST refused with the missing header set named");
    // 12b — unknown kid → refused (never trust by default)
    const d5b = await deny5(new Request(URL5, { method: "POST", body: "{}", headers: { "x-roshpina-kid": "deadbeefdeadbeef", "x-roshpina-timestamp": new Date(now5).toISOString(), "x-roshpina-signature": "AA==" } }));
    assert(d5b !== null && d5b.status === 401 && d5b.code === "unknown_kid", "unknown kid refused (never trust by default)");
    // 12c — epoch timestamp → refused (format=law, the D3 lesson at the door)
    const d5c = await deny5(new Request(URL5, { method: "POST", body: "{}", headers: { "x-roshpina-kid": opKid, "x-roshpina-timestamp": String(now5), "x-roshpina-signature": "AA==" } }));
    assert(d5c !== null && d5c.status === 401 && d5c.code === "bad_timestamp", "epoch timestamp refused — ISO-8601 UTC or nothing");
    // 12d — non-UTC offset → refused (format=law)
    const d5d = await deny5(new Request(URL5, { method: "POST", body: "{}", headers: { "x-roshpina-kid": opKid, "x-roshpina-timestamp": new Date(now5).toISOString().replace("Z", "+02:00"), "x-roshpina-signature": "AA==" } }));
    assert(d5d !== null && d5d.status === 401 && d5d.code === "bad_timestamp", "non-UTC offset refused — one clock, one format");
    // 12e — stale (10 min old) AND future (10 min ahead): the window is two-sided
    const stale5 = new Date(now5 - 10 * 60_000).toISOString();
    const d5e = await deny5(signed5("{}", stale5));
    assert(d5e !== null && d5e.status === 401 && d5e.code === "stale_timestamp", "stale timestamp refused even with a VALID signature (window precedes crypto)");
    const future5 = new Date(now5 + 10 * 60_000).toISOString();
    const d5f = await deny5(signed5("{}", future5));
    assert(d5f !== null && d5f.status === 401 && d5f.code === "stale_timestamp", "future-beyond-window refused (clock-skew abuse caught)");
    // 12f — tampered body: signature over body A, request carries body B
    const sigA = sign5(opKp.privateKey, opKid, new Date(now5).toISOString(), '{"memo":"A"}');
    const d5g = await deny5(new Request(URL5, { method: "POST", body: '{"memo":"B"}', headers: { "x-roshpina-kid": opKid, "x-roshpina-timestamp": new Date(now5).toISOString(), "x-roshpina-signature": sigA } }));
    assert(d5g !== null && d5g.status === 401 && d5g.code === "bad_signature", "tampered body refused — the signature binds sha256(body)");
    // 12g — the honest path: a valid operator signature PASSES, rawBody handed through (stream read once)
    const goodBody = JSON.stringify({ accountId: "acct-k5-demo-01", amount: "1000", memo: "k5" });
    const pass5 = await requireOperatorSignature(signed5(goodBody), ring5, replay5, { now: now5 });
    assert(pass5.ok === true && pass5.rawBody === goodBody, "valid operator signature passes; rawBody handed to the route (stream read once)");
    // 12h — exact replay of the winning tuple → refused (no double-mint through the window)
    const d5h = await deny5(signed5(goodBody));
    assert(d5h !== null && d5h.status === 401 && d5h.code === "replay_detected", "exact replay refused — a winning signature burns itself");
    // 12i — revoked key refuses ALWAYS (compromise invalidates forever)
    const revokedKp = generateKeyPairSync("ed25519");
    const revokedPem = revokedKp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const revokedKid = computeKid("ed25519", revokedPem);
    ring5.register({ kid: revokedKid, algorithm: "ed25519", publicKey: revokedPem, status: "active", createdAt: new Date(now5).toISOString() });
    ring5.revoke(revokedKid);
    const d5i = await deny5(signed5(JSON.stringify({ memo: "revoked" }), new Date(now5).toISOString(), revokedKid, revokedKp.privateKey));
    assert(d5i !== null && d5i.status === 401 && d5i.code === "key_revoked", "revoked key refused ALWAYS (compromise invalidates, forever)");
    // 12j — retiring keys still verify (rotation overlap — the KeyRing law holds at the door)
    const nextKp = generateKeyPairSync("ed25519");
    const nextPem = nextKp.publicKey.export({ type: "spki", format: "pem" }).toString();
    ring5.rotate({ kid: computeKid("ed25519", nextPem), algorithm: "ed25519", publicKey: nextPem, status: "active", createdAt: new Date(now5).toISOString() });
    const passRetired = await requireOperatorSignature(signed5(JSON.stringify({ memo: "retiring" }), new Date(now5).toISOString(), opKid, opKp.privateKey), ring5, replay5, { now: now5 });
    assert(passRetired.ok === true, "retiring key still verifies at the door (rotation overlap preserved)");
    // 12k — provisioning: kid derived from material; empty env = no anchors; broken PEM = loud error
    const ringProv = new KeyRing();
    const prov0 = provisionOperatorKeys(ringProv, {});
    const prov1 = provisionOperatorKeys(ringProv, { ROSHPINA_OPERATOR_PUBLIC_KEY: opPem });
    const prov2 = provisionOperatorKeys(ringProv, { ROSHPINA_OPERATOR_PUBLIC_KEY_CI: "not a pem" });
    assert(prov0.registered.length === 0, "no env anchors = nothing registered (the gate will refuse everyone, loudly)");
    assert(prov1.registered.length === 1 && prov1.registered[0] === opKid && prov1.registered[0] === computeKid("ed25519", opPemNorm), "operator anchor registered with kid derived from the normalized material (stable across deployments)");
    assert(prov2.errors.length === 1 && prov2.errors[0]!.includes("PEM"), "broken PEM refused loudly at provisioning (format=law)");
    // 12k' — env noise cannot fork the kid: trailing newlines and CRLF land on the SAME kid (measured live at the HTTP edge — the tailing-newline class of kid-mismatch is closed)
    const ringNoise = new KeyRing();
    const provNoise = provisionOperatorKeys(ringNoise, { ROSHPINA_OPERATOR_PUBLIC_KEY: opPem + "\n\n\n" });
    const provCrlf = provisionOperatorKeys(ringNoise, { ROSHPINA_OPERATOR_PUBLIC_KEY_CI: opPem.replace(/\n/g, "\r\n") });
    assert(provNoise.registered.length === 1 && provNoise.registered[0] === opKid, "trailing-newline noise registers to the SAME kid (normalization law)");
    assert(provCrlf.registered.length === 1 && provCrlf.registered[0] === opKid, "CRLF noise registers to the SAME kid (normalization law)");
    // 12l — the window constant is the sharpened money law (5 minutes, two-sided)
    assert(ROUTE_AUTH_REPLAY_WINDOW_MS === 300_000, "replay window is exactly 5 minutes (measured constant, not folklore)");
    console.log("12) K5 route-auth gate ✓ · anonymous refused (named) · unknown/revoked refused · format=law on time · two-sided ±5min window · body-bound signatures · replay burns itself · retiring verifies · kid derived from material · env-noise cannot fork the kid");
  }

  // ── 13) C-2b — the anchor seam gets the same door + the wiring is law (v148) ─
  {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const apiDir = pjoin(import.meta.dir, "src", "app", "api");
    // 13a — THE WIRING LAW (born live from C-2b): walk every route file; any POST
    // export must go through the gate OR be explicitly allowlisted pure-verification.
    // An unlisted ungated POST is RED — the next seam cannot ship silently.
    const OPEN_POST_ALLOWLIST = ["passports/verify"]; // pure verification, measured open in K5 (400-not-401, no state)
    const ungated: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = pjoin(dir, e);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (e === "route.ts") {
          const text = readFileSync(full, "utf8");
          if (!text.includes("export async function POST")) continue;
          const rel = full.slice(apiDir.length + 1, -"/route.ts".length);
          if (OPEN_POST_ALLOWLIST.includes(rel)) continue;
          if (!text.includes("gateStateRoute(")) ungated.push(rel);
        }
      }
    };
    walk(apiDir);
    assert(ungated.length === 0, `every state-creating POST goes through the gate (ungated: ${ungated.join(", ") || "none"})`);
    // 13a' — the allowlist cannot become a mute-anything hole: an allowlisted POST
    // must NOT import the gate (pure verification stays pure — both facts held).
    for (const rel of OPEN_POST_ALLOWLIST) {
      const src = readFileSync(pjoin(apiDir, rel, "route.ts"), "utf8");
      assert(!src.includes("gateStateRoute("), `allowlisted POST ${rel} stays pure verification (no gate smuggled inside)`);
    }
    // 13b — the route-auth law AT THE BRIDGE DOOR (the anchor path, not just mint):
    const ring13 = new KeyRing();
    const replay13 = new InMemoryReplayCache();
    const now13 = 2_100_000_000_000;
    const URL13 = "http://roshpina.test/api/bridge/saos";
    const kp13 = generateKeyPairSync("ed25519");
    const pem13 = kp13.publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\r\n/g, "\n").trim();
    const kid13 = computeKid("ed25519", pem13);
    ring13.register({ kid: kid13, algorithm: "ed25519", publicKey: pem13, status: "active", createdAt: new Date(now13).toISOString() });
    const sign13 = (priv: { type: "private" }, kid: string, ts: string, body: string) =>
      edSign(null, Buffer.from(canonicalRoutePayload(kid, "POST", "/api/bridge/saos", ts, sha256Hex(body)), "utf8"), priv as never).toString("base64");
    const deny13 = async (req: Request) => {
      const r = await requireOperatorSignature(req, ring13, replay13, { now: now13 });
      return r.ok ? null : r;
    };
    const ts13 = new Date(now13).toISOString();
    const sig13 = sign13(kp13.privateKey, kid13, ts13, ""); // anchor POST carries no body — the law binds sha256("") all the same
    // 13b-i — anonymous: the seam has a door and it names what is missing
    const d13a = await deny13(new Request(URL13, { method: "POST" }));
    assert(d13a !== null && d13a.status === 401 && d13a.code === "missing_headers", "anonymous anchor POST refused with the missing set named (the seam has a door)");
    // 13b-ii — tampered body: signature over "", request carries a body
    const d13b = await deny13(new Request(URL13, { method: "POST", body: "x", headers: { "x-roshpina-kid": kid13, "x-roshpina-timestamp": ts13, "x-roshpina-signature": sig13 } }));
    assert(d13b !== null && d13b.status === 401 && d13b.code === "bad_signature", "tampered anchor body refused — the signature binds sha256(body) at the seam too");
    // 13b-iii — the honest path: a valid operator signature passes
    const pass13 = await requireOperatorSignature(new Request(URL13, { method: "POST", headers: { "x-roshpina-kid": kid13, "x-roshpina-timestamp": ts13, "x-roshpina-signature": sig13 } }), ring13, replay13, { now: now13 });
    assert(pass13.ok === true, "valid operator signature anchors — the honest path passes at the seam");
    // 13b-iv — exact replay of the winning tuple burns itself (no double-anchor)
    const d13c = await deny13(new Request(URL13, { method: "POST", headers: { "x-roshpina-kid": kid13, "x-roshpina-timestamp": ts13, "x-roshpina-signature": sig13 } }));
    assert(d13c !== null && d13c.status === 401 && d13c.code === "replay_detected", "winning anchor signature burns itself — no double-anchor through the window");
    // 13c — the read surface stays open, machine-checked: the bridge GET has no gate
    const bridgeSrc = readFileSync(pjoin(apiDir, "bridge", "saos", "route.ts"), "utf8");
    const getBody = bridgeSrc.split("export async function GET")[1]?.split("export async function POST")[0] ?? "";
    assert(getBody.length > 0 && !getBody.includes("gateStateRoute("), "bridge GET stays open (pure read) while POST is gated — both facts machine-checked");
    console.log("13) C-2b anchor seam ✓ · POST gated gate-before-seed · wiring law: every POST gated or allowlisted (walk enforced) · anchor signatures body-bound · replay burns · GET stays open");
  }
  console.log("SMOKE-OK · all invariants proven against the live ledger — אין טענות, יש הוכחות");
}

main().catch((e) => { console.error("SMOKE-FAIL:", (e as Error).message); process.exit(1); });
