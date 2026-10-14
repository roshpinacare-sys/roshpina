/**
 * lib/escrow/threshold-approval.ts — Threshold approval for large settlement releases.
 *
 * Purpose: when a settlement has a thresholdAmount and the pending release exceeds it,
 * a ThresholdApproval token must be obtained and presented at release time. This
 * implements the Safe-style pattern: N-of-M authority approval before large value moves.
 *
 * In v142: 1-of-1 authority approval — the settlement authority pre-authorises
 * a specific release amount for a specific agreement via a signed HMAC token. The token is
 * single-use (nonce tracked) and short-lived (TTL configurable).
 *
 * K1 sharpening (v143, "threshold-approval wakes up") — three laws, wired at
 * SettlementService.release/partialRelease and proven in kernel-smoke case 8:
 *   1. VOTE CHANNEL (I21: single deny fails closed) — tokens carry vote:
 *      "approve" | "deny". One valid deny from a distinct identity vetoes the
 *      release; nothing is consumed on denial.
 *   2. IDENTITY FROM KEY, NOT FROM BODY (I21: identity from the channel, never
 *      the request) — generateThresholdApprovalForKey signs with a PER-APPROVER
 *      key. validateQuorumApproval verifies each token against the trusted
 *      keyring: a forged approvedBy with the wrong key fails the signature.
 *      A shared-secret holder can no longer mint votes “as” other identities
 *      (the old single-secret multi-party path was a cosmetic Sybil guard).
 *   3. BYZANTINE FLOOR (DNA from valory-xyz/open-autonomy
 *      transaction_settlement_abci/rounds.py — malicious_threshold = nb//3):
 *      byzantineQuorum(M) tolerates f = ⌊(M−1)/3⌋ faulty members and requires
 *      N = 2f+1 distinct approvals. requiredApprovals below the floor is an
 *      invalid_config — a quorum cannot be weakened into existence.
 *   NOTE: tokens minted before K1 (no vote field) fail signature verification
 *   by design. The module had zero live callers, so nothing breaks.
 *
 * Design:
 *   1. Authority calls generateApproval(agreementId, tenantId, maxAmount, approvedBy, signer)
 *      → returns a ThresholdApproval with a signed token string.
 *   2. Caller includes the token in the release/partialRelease call.
 *   3. SettlementService calls validateAndConsumeApproval(token, store) before executing.
 *   4. Consumed tokens are added to a nonce set — replay is rejected (fail-closed).
 *
 * Extension path: replace InMemoryThresholdApprovalStore with PgThresholdApprovalStore
 * and expand to multi-party (collect N signatures, each a ThresholdApproval, before executing).
 *
 * Zero external dependencies — node:crypto HMAC only.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

// ─── TTL ─────────────────────────────────────────────────────────────────────

/** Default token TTL: 10 minutes. */
export const THRESHOLD_TOKEN_TTL_MS = 10 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalVote = "approve" | "deny";

export interface ThresholdApproval {
  id: string;
  agreementId: string;
  tenantId: string;
  maxAmount: string; // μ¢ as decimal string
  approvedBy: string;
  vote: ApprovalVote; // K1: "approve" or "deny" — a deny is a veto (I21)
  issuedAt: string;  // ISO
  expiresAt: string; // ISO
  token: string;     // HMAC-signed opaque string (base64url)
}

export class ThresholdApprovalError extends Error {
  code: "invalid_token" | "expired" | "replayed" | "amount_exceeded" | "tenant_mismatch" | "agreement_mismatch";
  constructor(
    code: "invalid_token" | "expired" | "replayed" | "amount_exceeded" | "tenant_mismatch" | "agreement_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ThresholdApprovalError";
    this.code = code;
  }
}

// ─── Nonce store ──────────────────────────────────────────────────────────────

export interface ThresholdApprovalStore {
  hasConsumed(id: string): boolean;
  consume(id: string): void;
}

export class InMemoryThresholdApprovalStore implements ThresholdApprovalStore {
  private readonly consumed = new Set<string>();
  hasConsumed(id: string): boolean { return this.consumed.has(id); }
  consume(id: string): void { this.consumed.add(id); }
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Canonical payload for signing. Deterministic — join fields with | separator. */
function makePayload(id: string, agreementId: string, tenantId: string, maxAmount: string, approvedBy: string, expiresAt: string, vote: ApprovalVote): string {
  return [id, agreementId, tenantId, maxAmount, approvedBy, expiresAt, vote].join("|");
}

/** Sign the canonical payload with the kernel secret using HMAC-SHA256. Returns base64. */
function sign(secret: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(payload, "utf8")
    .digest("base64");
}

/** Timing-safe equality for base64 strings. */
function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "base64");
    const bb = Buffer.from(b, "base64");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch { return false; }
}

/** Encode an approval object as a compact base64url token for transport. */
function encodeToken(approval: Omit<ThresholdApproval, "token">, sig: string): string {
  const obj = {
    id: approval.id,
    agreementId: approval.agreementId,
    tenantId: approval.tenantId,
    maxAmount: approval.maxAmount,
    approvedBy: approval.approvedBy,
    vote: approval.vote,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
    sig,
  };
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

/** Decode a token back to its fields + signature. Returns null on parse error. */
function decodeToken(token: string): { id: string; agreementId: string; tenantId: string; maxAmount: string; approvedBy: string; vote: ApprovalVote; issuedAt: string; expiresAt: string; sig: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      typeof obj.agreementId !== "string" ||
      typeof obj.tenantId !== "string" ||
      typeof obj.maxAmount !== "string" ||
      typeof obj.approvedBy !== "string" ||
      (obj.vote !== "approve" && obj.vote !== "deny") ||
      typeof obj.issuedAt !== "string" ||
      typeof obj.expiresAt !== "string" ||
      typeof obj.sig !== "string"
    ) return null;
    return obj as { id: string; agreementId: string; tenantId: string; maxAmount: string; approvedBy: string; vote: ApprovalVote; issuedAt: string; expiresAt: string; sig: string };
  } catch { return null; }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a threshold approval token for a specific release (shared-secret path).
 * @param secret  - The kernel HMAC secret (from the signer, never caller-controlled).
 * @param input   - Agreement + amount constraints + vote (default "approve").
 * @param ttlMs   - Token lifetime in milliseconds (default: 10 minutes).
 */
export function generateThresholdApproval(
  secret: string,
  input: {
    agreementId: string;
    tenantId: string;
    maxAmount: bigint;
    approvedBy: string;
    vote?: ApprovalVote;
  },
  ttlMs: number = THRESHOLD_TOKEN_TTL_MS,
): ThresholdApproval {
  return mintApproval(secret, input, ttlMs);
}

/**
 * K1 (I21: identity from key possession, not from the request body).
 * Generate a threshold approval signed with a PER-APPROVER key. Validation
 * against the trusted keyring proves WHO signed — a forged approvedBy with
 * the wrong key fails the signature check. This is the only path that
 * validateQuorumApproval accepts (the shared-secret path cannot distinguish
 * identities and is therefore Sybil-cosmetic for quorum purposes).
 */
export function generateThresholdApprovalForKey(
  approverKey: string,
  input: {
    agreementId: string;
    tenantId: string;
    maxAmount: bigint;
    approvedBy: string;
    vote?: ApprovalVote;
  },
  ttlMs: number = THRESHOLD_TOKEN_TTL_MS,
): ThresholdApproval {
  if (!approverKey) throw new ThresholdApprovalError("invalid_token", "approverKey required (identity comes from key possession, not the body)");
  return mintApproval(approverKey, input, ttlMs);
}

/** Shared minting core — signs the canonical payload (with vote) using the given key. */
function mintApproval(
  key: string,
  input: {
    agreementId: string;
    tenantId: string;
    maxAmount: bigint;
    approvedBy: string;
    vote?: ApprovalVote;
  },
  ttlMs: number,
): ThresholdApproval {
  if (!input.agreementId) throw new ThresholdApprovalError("invalid_token", "agreementId required");
  if (!input.tenantId) throw new ThresholdApprovalError("invalid_token", "tenantId required");
  if (typeof input.maxAmount !== "bigint" || input.maxAmount <= 0n) {
    throw new ThresholdApprovalError("invalid_token", "maxAmount must be a positive bigint (μ¢)");
  }
  if (!input.approvedBy) throw new ThresholdApprovalError("invalid_token", "approvedBy required");
  const vote: ApprovalVote = input.vote === "deny" ? "deny" : "approve";

  const id = randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const maxAmountStr = input.maxAmount.toString();

  const payload = makePayload(id, input.agreementId, input.tenantId, maxAmountStr, input.approvedBy, expiresAt, vote);
  const sig = sign(key, payload);
  const base = { id, agreementId: input.agreementId, tenantId: input.tenantId, maxAmount: maxAmountStr, approvedBy: input.approvedBy, vote, issuedAt, expiresAt } as Omit<ThresholdApproval, "token">;
  const token = encodeToken(base, sig);

  return { ...base, token };
}

/**
 * Validate and consume a threshold approval token.
 * Throws ThresholdApprovalError on any failure (fail-closed).
 *
 * @param secret        - Kernel HMAC secret.
 * @param token         - The token string from the approval.
 * @param agreementId   - Must match token's agreementId.
 * @param tenantId      - Must match token's tenantId.
 * @param releaseAmount - The amount being released; must be ≤ token's maxAmount.
 * @param store         - Nonce store; used to prevent replay.
 */
export function validateAndConsumeApproval(
  secret: string,
  token: string,
  agreementId: string,
  tenantId: string,
  releaseAmount: bigint,
  store: ThresholdApprovalStore,
): void {
  const decoded = decodeToken(token);
  if (!decoded) throw new ThresholdApprovalError("invalid_token", "approval token is malformed");

  // Tenant + agreement binding (fail-closed)
  if (decoded.tenantId !== tenantId) {
    throw new ThresholdApprovalError("tenant_mismatch", "approval token belongs to a different tenant");
  }
  if (decoded.agreementId !== agreementId) {
    throw new ThresholdApprovalError("agreement_mismatch", "approval token belongs to a different agreement");
  }

  // Expiry
  if (Date.now() > new Date(decoded.expiresAt).getTime()) {
    throw new ThresholdApprovalError("expired", "approval token has expired");
  }

  // Signature verification (K1: payload now includes the vote channel)
  const expectedPayload = makePayload(decoded.id, decoded.agreementId, decoded.tenantId, decoded.maxAmount, decoded.approvedBy, decoded.expiresAt, decoded.vote);
  const expectedSig = sign(secret, expectedPayload);
  if (!safeEqual(expectedSig, decoded.sig)) {
    throw new ThresholdApprovalError("invalid_token", "approval token signature is invalid");
  }

  // Amount check
  if (releaseAmount > BigInt(decoded.maxAmount)) {
    throw new ThresholdApprovalError(
      "amount_exceeded",
      `release amount ${releaseAmount} exceeds approved maximum ${decoded.maxAmount}`,
    );
  }

  // Replay prevention (fail-closed: consume AFTER all checks pass)
  if (store.hasConsumed(decoded.id)) {
    throw new ThresholdApprovalError("replayed", "approval token has already been used");
  }
  store.consume(decoded.id);
}

// ─── N-of-M Multi-party Threshold Approval ────────────────────────────────────
//
// Safe-style quorum: a release requires at least `requiredApprovals` (N) distinct
// signed tokens from a defined set of `authorizedApprovers` (M identities).
//
// Design:
//   1. Caller collects N ThresholdApproval tokens, each from a different authority.
//   2. validateMultiPartyApprovals() validates all tokens individually, checks:
//      a. Each token is valid (signature, expiry, binding, amount).
//      b. At least `requiredApprovals` distinct approvers.
//      c. All approvers are in `authorizedApprovers` (if list non-empty).
//      d. No token has been replayed.
//   3. All tokens are consumed only if the full quorum is met (fail-closed).
//      Partial quorum = rejection; no tokens consumed.
//
// Fail-closed invariants:
//   • Missing or empty tokens list → rejection.
//   • Any single invalid token → whole set rejected; no tokens consumed.
//   • Duplicate approver (same approvedBy) counts as one vote — prevents Sybil.
//   • authorizedApprovers=[] means any identity may approve (open quorum).

export interface MultiPartyThresholdConfig {
  /** Number of required distinct approvals (N). Must be ≥ 1. */
  requiredApprovals: number;
  /**
   * Optional explicit list of authorised approver identities (M).
   * If non-empty, all tokens must come from identities in this set.
   * If empty, any identity may approve (open quorum).
   */
  authorizedApprovers?: string[];
}

export class MultiPartyThresholdError extends Error {
  code:
    | "insufficient_approvals"
    | "unauthorized_approver"
    | "duplicate_approver"
    | "token_invalid"
    | "invalid_config"
    | "denied"; // K1 (I21): a valid deny is a veto — fail-closed

  constructor(
    code:
      | "insufficient_approvals"
      | "unauthorized_approver"
      | "duplicate_approver"
      | "token_invalid"
      | "invalid_config"
      | "denied",
    message: string,
  ) {
    super(message);
    this.name = "MultiPartyThresholdError";
    this.code = code;
  }
}

/**
 * Validate and consume a set of threshold approval tokens for N-of-M quorum.
 *
 * Throws MultiPartyThresholdError if quorum is not met or any token is invalid.
 * Throws ThresholdApprovalError (re-thrown) if an individual token fails its own check.
 * On success, all N tokens are consumed (replay prevention).
 *
 * @param secret        - Kernel HMAC secret.
 * @param tokens        - Array of base64-encoded ThresholdApproval token strings.
 * @param agreementId   - All tokens must bind to this agreement.
 * @param tenantId      - All tokens must bind to this tenant.
 * @param releaseAmount - Amount being released; each token must cover it.
 * @param store         - Nonce store for replay prevention.
 * @param config        - N-of-M quorum configuration.
 */
export function validateMultiPartyApprovals(
  secret: string,
  tokens: string[],
  agreementId: string,
  tenantId: string,
  releaseAmount: bigint,
  store: ThresholdApprovalStore,
  config: MultiPartyThresholdConfig,
): void {
  const { requiredApprovals, authorizedApprovers = [] } = config;

  if (requiredApprovals < 1) {
    throw new MultiPartyThresholdError("invalid_config", "requiredApprovals must be \u2265 1");
  }
  if (!tokens || tokens.length === 0) {
    throw new MultiPartyThresholdError(
      "insufficient_approvals",
      `quorum requires ${requiredApprovals} approvals; 0 tokens provided`,
    );
  }

  // Built once: O(1) membership check per token instead of Array.includes()
  // (O(authorizedApprovers.length)) re-scanned on every one of the N tokens
  // in phase 2 below — O(tokens × approvers) → O(tokens). Empty array means
  // "no restriction" (checked via size, same semantics as .length > 0).
  const authorizedApproverSet = new Set(authorizedApprovers);

  // Phase 1: decode and validate each token without consuming any (fail-fast, fail-closed)
  const decodedInfos: Array<{ id: string; approvedBy: string }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Non-consuming store shim — checks replay but does not record consumption
    const peekStore: ThresholdApprovalStore = {
      hasConsumed: (id: string) => store.hasConsumed(id),
      consume: (_id: string) => { /* noop in phase 1 */ },
    };

    try {
      validateAndConsumeApproval(secret, token, agreementId, tenantId, releaseAmount, peekStore);
    } catch (err: unknown) {
      if (err instanceof ThresholdApprovalError) {
        throw new MultiPartyThresholdError(
          "token_invalid",
          `token[${i}] invalid: ${err.message}`,
        );
      }
      throw err;
    }

    // Decode approvedBy for quorum checks (base64 JSON — same encoding as encodeToken)
    let approvedBy = "";
    let tokenId = "";
    try {
      const raw = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as Record<string, unknown>;
      if (typeof raw.approvedBy === "string") approvedBy = raw.approvedBy;
      if (typeof raw.id === "string") tokenId = raw.id;
    } catch { /* unreachable — token was already validated */ }

    if (!approvedBy || !tokenId) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: could not extract approver identity`);
    }
    decodedInfos.push({ id: tokenId, approvedBy });
  }

  // Phase 2: quorum checks — distinct approvers + authorization list
  const seenApprovers = new Map<string, number>(); // approvedBy → token index
  for (let i = 0; i < decodedInfos.length; i++) {
    const { approvedBy } = decodedInfos[i];

    if (seenApprovers.has(approvedBy)) {
      throw new MultiPartyThresholdError(
        "duplicate_approver",
        `approver "${approvedBy}" appears at indices ${seenApprovers.get(approvedBy)} and ${i}; each approver may only contribute one vote`,
      );
    }
    seenApprovers.set(approvedBy, i);

    if (authorizedApproverSet.size > 0 && !authorizedApproverSet.has(approvedBy)) {
      throw new MultiPartyThresholdError(
        "unauthorized_approver",
        `approver "${approvedBy}" is not in the authorized approvers list`,
      );
    }
  }

  if (seenApprovers.size < requiredApprovals) {
    throw new MultiPartyThresholdError(
      "insufficient_approvals",
      `quorum requires ${requiredApprovals} distinct approvals; got ${seenApprovers.size}`,
    );
  }

  // Phase 3: quorum met — consume all tokens to prevent replay
  for (const { id } of decodedInfos) {
    store.consume(id);
  }
}

// ─── K1: Byzantine-floor quorum with per-identity keys + deny veto ───────────
//
// The sharpened pathway (wired at SettlementService.release/partialRelease):
//   • M committee members, each with their OWN HMAC key (keyring is trusted
//     config — it arrives from the deployment channel, never from a request).
//   • byzantineQuorum(M): tolerate f = ⌊(M−1)/3⌋ faulty members, require
//     N = 2f+1 distinct approvals (classic BFT bound; same DNA as
//     open-autonomy transaction_settlement_abci/rounds.py L121-124).
//   • ONE valid deny from a distinct identity vetoes the release (I21).
//   • Identity is proven by which key validates, never by the token body.

/**
 * Byzantine-aware quorum math.
 * M=1 → f=0, N=1 · M=4 → f=1, N=3 · M=7 → f=2, N=5 · M must be ≥ 3f+1.
 */
export function byzantineQuorum(committeeSize: number): { byzantineTolerance: number; requiredApprovals: number } {
  if (!Number.isInteger(committeeSize) || committeeSize < 1) {
    throw new MultiPartyThresholdError("invalid_config", "committeeSize must be a positive integer");
  }
  const f = Math.floor((committeeSize - 1) / 3);
  const required = 2 * f + 1;
  if (required > committeeSize) {
    throw new MultiPartyThresholdError("invalid_config", `committee of ${committeeSize} cannot reach a Byzantine quorum (needs ${required})`);
  }
  return { byzantineTolerance: f, requiredApprovals: required };
}

export interface QuorumConfig {
  /** Trusted keyring: identity → HMAC key. From deployment config, NEVER from a request. */
  approverKeys: Record<string, string>;
  /** Optional explicit committee list (M). Defaults to Object.keys(approverKeys). */
  authorizedApprovers?: string[];
  /** Optional N override. MUST be ≥ byzantineQuorum(M).requiredApprovals (cannot weaken). */
  requiredApprovals?: number;
}

/**
 * Validate and consume a Byzantine-floor quorum of per-key signed tokens.
 *
 * Fail-closed invariants (all proven in kernel-smoke case 8):
 *   • 0 tokens, missing keyring entry, forged identity (wrong key), expired,
 *     wrong binding, or over-amount → whole set rejected, NOTHING consumed.
 *   • ANY valid deny from a distinct identity → "denied" — release vetoed.
 *   • Duplicate identity → rejected (one vote per identity, enforced by key).
 *   • requiredApprovals below the Byzantine floor → invalid_config at entry.
 *   • Consumption happens only AFTER every check passes.
 */
export function validateQuorumApproval(
  tokens: string[],
  agreementId: string,
  tenantId: string,
  releaseAmount: bigint,
  store: ThresholdApprovalStore,
  config: QuorumConfig,
): { approvals: string[]; denials: string[]; requiredApprovals: number; byzantineTolerance: number } {
  const keyring = config.approverKeys ?? {};
  if (!keyring || Object.keys(keyring).length === 0) {
    throw new MultiPartyThresholdError("invalid_config", "approverKeys must be a non-empty keyring (identity = key possession)");
  }

  const committee = config.authorizedApprovers ?? Object.keys(keyring);
  const { byzantineTolerance, requiredApprovals: floor } = byzantineQuorum(committee.length);
  const required = config.requiredApprovals ?? floor;
  if (required < floor) {
    throw new MultiPartyThresholdError("invalid_config", `requiredApprovals ${required} is below the Byzantine floor ${floor} for a committee of ${committee.length} (cannot weaken a quorum into existence)`);
  }

  if (!tokens || tokens.length === 0) {
    throw new MultiPartyThresholdError("insufficient_approvals", `quorum requires ${required} approvals; 0 tokens provided`);
  }

  const authorizedSet = new Set(committee);

  // Phase 1: decode + verify each token against the keyring (consume nothing yet)
  const votes: Array<{ id: string; approvedBy: string; vote: ApprovalVote }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const decoded = decodeToken(tokens[i]);
    if (!decoded) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}] is malformed`);
    }

    // Identity from KEY possession (I21): the body's approvedBy only SELECTS the
    // keyring entry; trust comes from the signature verifying under that key.
    const key = keyring[decoded.approvedBy];
    if (!key) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: identity "${decoded.approvedBy}" has no key in the keyring — unprovable identity is a rejection (fail-closed)`);
    }

    // Binding (fail-closed)
    if (decoded.tenantId !== tenantId) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: tenant mismatch`);
    }
    if (decoded.agreementId !== agreementId) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: agreement mismatch`);
    }

    // Expiry (fail-closed)
    if (Date.now() > new Date(decoded.expiresAt).getTime()) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: expired`);
    }

    // Signature under the approver's own key — a forged identity fails here
    const expectedSig = sign(key, makePayload(decoded.id, decoded.agreementId, decoded.tenantId, decoded.maxAmount, decoded.approvedBy, decoded.expiresAt, decoded.vote));
    if (!safeEqual(expectedSig, decoded.sig)) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: signature does not verify under "${decoded.approvedBy}"'s key (forged identity rejected)`);
    }

    // Amount (fail-closed)
    if (releaseAmount > BigInt(decoded.maxAmount)) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: release ${releaseAmount} exceeds approved maximum ${decoded.maxAmount}`);
    }

    // Replay peek (consume nothing in phase 1)
    if (store.hasConsumed(decoded.id)) {
      throw new MultiPartyThresholdError("token_invalid", `token[${i}]: already used (replay)`);
    }

    votes.push({ id: decoded.id, approvedBy: decoded.approvedBy, vote: decoded.vote });
  }

  // Phase 2: deny veto FIRST (I21 — one deny fails closed, before counting approvals)
  const deniers = new Set<string>();
  const approvers = new Map<string, number>();
  for (const v of votes) {
    if (v.vote === "deny") {
      deniers.add(v.approvedBy);
      continue;
    }
    if (approvers.has(v.approvedBy)) {
      throw new MultiPartyThresholdError("duplicate_approver", `approver "${v.approvedBy}" voted twice; each identity may only contribute one vote`);
    }
    approvers.set(v.approvedBy, 0);
    if (authorizedSet.size > 0 && !authorizedSet.has(v.approvedBy)) {
      throw new MultiPartyThresholdError("unauthorized_approver", `approver "${v.approvedBy}" is not in the committee`);
    }
  }
  for (const d of deniers) {
    if (authorizedSet.size > 0 && !authorizedSet.has(d)) {
      throw new MultiPartyThresholdError("unauthorized_approver", `denier "${d}" is not in the committee`);
    }
  }
  if (deniers.size > 0) {
    throw new MultiPartyThresholdError("denied", `release vetoed by deny vote(s) from: ${[...deniers].join(", ")} — a single deny fails the quorum closed (I21)`);
  }

  if (approvers.size < required) {
    throw new MultiPartyThresholdError("insufficient_approvals", `quorum requires ${required} distinct approvals (Byzantine floor for committee of ${committee.length}); got ${approvers.size}`);
  }

  // Phase 3: everything passed — consume every token (approves AND denies) against replay
  for (const v of votes) {
    store.consume(v.id);
  }

  return { approvals: [...approvers.keys()], denials: [...deniers], requiredApprovals: required, byzantineTolerance };
}
