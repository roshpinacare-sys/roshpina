/**
 * lib/transparency-log/witness.ts — witness co-signing for the transparency log.
 *
 * WHY THIS EXISTS (the structural moat)
 * -------------------------------------
 * Consistency proofs (v379) make a split-view *detectable* by any monitor that
 * compares the roots it sees over time. Witnessing makes split-view *impossible
 * to hide*: independent third parties observe the log's signed tree head and
 * CO-SIGN it. To fork the log — show party A one history and party B another —
 * the operator would now have to get a QUORUM of independent witnesses to sign
 * the fork. A receipt holder then checks not just "the operator signed this root"
 * but "K independent witnesses also signed this exact root."
 *
 * This is the Certificate-Transparency gossip/witness model. It is also the one
 * trust property a SINGLE-VENDOR agent stack structurally cannot provide for its
 * own agents: a vendor cannot be a neutral witness to itself. A cross-vendor
 * trust layer can. That is precisely TFA's thesis made concrete.
 *
 * THIS MODULE (bounded sub-step)
 * ------------------------------
 *   • WitnessStatement — a canonical, signed observation of one tree head.
 *   • signTreeHead()   — a witness produces a statement over {logId, root, size}.
 *   • verifyWitnessStatement() — verify one co-signature against a witness key.
 *   • collectWitnessQuorum()   — given statements for a target root, confirm K
 *     DISTINCT witnesses signed THAT root; fail-closed alarm on any statement
 *     that signs a DIFFERENT root for the same (logId, treeSize) — a split-view.
 *
 * DESIGN
 * ------
 * • Signer-agnostic: works with any Signer (HMAC for tests, Ed25519 in prod).
 * • Canonical signing payload: deterministic, version-tagged, so a statement
 *   signed by one process verifies byte-for-byte in another.
 * • FAIL-CLOSED: malformed statement → not verified; conflicting roots → quorum
 *   throws a SplitViewError (never silently returns "ok"); duplicate witnessId
 *   counts once.
 * • Zero external dependencies (node:crypto via the Signer only).
 */

import type { Signer } from "../orchestrator/types";
import { canonicalJson } from "../common/canonical-json";

const HEX64_RE = /^[a-f0-9]{64}$/i;

/** Statement schema version — bump only on a breaking payload change. */
export const WITNESS_STATEMENT_VERSION = "tfa-witness-v1" as const;

/** A witness's signed observation of one tree head. */
export interface WitnessStatement {
  /** Schema tag. */
  version: typeof WITNESS_STATEMENT_VERSION;
  /** Which log was observed (tenant-scoped log id / anchor namespace). */
  logId: string;
  /** The observed Merkle root (64-hex SHA-256). */
  root: string;
  /** The observed tree size (leaf count) at that root. */
  treeSize: number;
  /** ISO-8601 time the witness observed the head. */
  observedAt: string;
  /** Stable identifier of the witness (e.g. its public-key fingerprint). */
  witnessId: string;
  /** Signature algorithm label, copied from the signer. */
  algorithm: string;
  /** base64 signature over the canonical payload. */
  signature: string;
}

/** The fields a witness signs (everything except the signature itself). */
export interface TreeHeadObservation {
  logId: string;
  root: string;
  treeSize: number;
  observedAt: string;
  witnessId: string;
}

/**
 * Canonical signing payload for a tree-head observation. Deterministic field
 * order via canonicalJson, version-tagged so the bytes are stable and portable.
 */
export function witnessSigningPayload(obs: TreeHeadObservation): string {
  return canonicalJson({
    version: WITNESS_STATEMENT_VERSION,
    logId: obs.logId,
    root: obs.root,
    treeSize: obs.treeSize,
    observedAt: obs.observedAt,
    witnessId: obs.witnessId,
  });
}

function isValidObservation(obs: TreeHeadObservation): boolean {
  return (
    !!obs &&
    typeof obs.logId === "string" && obs.logId.length > 0 &&
    typeof obs.root === "string" && HEX64_RE.test(obs.root) &&
    Number.isInteger(obs.treeSize) && obs.treeSize >= 1 &&
    typeof obs.observedAt === "string" && obs.observedAt.length > 0 &&
    typeof obs.witnessId === "string" && obs.witnessId.length > 0
  );
}

/**
 * Produce a witness statement: a witness signs a tree-head observation.
 * Fail-closed: an invalid observation throws before any signing happens.
 */
export function signTreeHead(signer: Signer, obs: TreeHeadObservation): WitnessStatement {
  if (!signer || typeof signer.sign !== "function") {
    throw new WitnessError("BAD_SIGNER", "signTreeHead: a Signer is required");
  }
  if (!isValidObservation(obs)) {
    throw new WitnessError("BAD_OBSERVATION", "signTreeHead: invalid tree-head observation");
  }
  const payload = witnessSigningPayload(obs);
  return {
    version: WITNESS_STATEMENT_VERSION,
    logId: obs.logId,
    root: obs.root,
    treeSize: obs.treeSize,
    observedAt: obs.observedAt,
    witnessId: obs.witnessId,
    algorithm: signer.algorithm,
    signature: signer.sign(payload),
  };
}

/**
 * Verify a single witness statement against the witness's signer (which holds
 * the verifying key). Fail-closed: any structural defect → false (no throw).
 */
export function verifyWitnessStatement(statement: WitnessStatement, signer: Signer): boolean {
  if (!statement || typeof statement !== "object") return false;
  if (statement.version !== WITNESS_STATEMENT_VERSION) return false;
  if (!signer || typeof signer.verify !== "function") return false;
  if (
    !isValidObservation({
      logId: statement.logId,
      root: statement.root,
      treeSize: statement.treeSize,
      observedAt: statement.observedAt,
      witnessId: statement.witnessId,
    })
  ) {
    return false;
  }
  if (typeof statement.signature !== "string" || statement.signature.length === 0) return false;

  const payload = witnessSigningPayload({
    logId: statement.logId,
    root: statement.root,
    treeSize: statement.treeSize,
    observedAt: statement.observedAt,
    witnessId: statement.witnessId,
  });
  try {
    return signer.verify(payload, statement.signature);
  } catch {
    return false;
  }
}

/** Result of a quorum check over a target tree head. */
export interface WitnessQuorumResult {
  /** True iff distinct verified witnesses ≥ threshold all signed the target root. */
  reached: boolean;
  /** Number of distinct witnesses that verified against the target root. */
  distinctWitnesses: number;
  /** The threshold that was required. */
  threshold: number;
  /** The witnessIds that verified (sorted, de-duplicated). */
  witnessIds: string[];
}

/**
 * A witness signed a DIFFERENT root than its peers for the same (logId, treeSize).
 * That is the on-the-wire signature of a split-view attack: two valid statements
 * over the same log position disagree on the root.
 */
export class SplitViewError extends Error {
  readonly code = "SPLIT_VIEW" as const;
  readonly logId: string;
  readonly treeSize: number;
  readonly roots: string[];
  constructor(logId: string, treeSize: number, roots: string[]) {
    super(`split-view detected for log ${logId} at size ${treeSize}: conflicting roots ${roots.join(", ")}`);
    this.name = "SplitViewError";
    this.logId = logId;
    this.treeSize = treeSize;
    this.roots = roots;
  }
}

/**
 * Confirm that a quorum of DISTINCT, verified witnesses co-signed a target tree
 * head. `resolveSigner(witnessId)` returns the verifying Signer for a witness, or
 * null if the witness is unknown (unknown witnesses are ignored, fail-closed).
 *
 * Split-view alarm: if any verified statement matches the target (logId, treeSize)
 * but carries a DIFFERENT root, this throws SplitViewError rather than counting it.
 *
 * @param statements  candidate statements (from one or many witnesses).
 * @param target      the tree head a receipt holder is trying to trust.
 * @param threshold   minimum distinct witnesses required (>= 1).
 * @param resolveSigner  maps a witnessId to its verifying Signer (or null).
 */
export function collectWitnessQuorum(
  statements: WitnessStatement[],
  target: { logId: string; root: string; treeSize: number },
  threshold: number,
  resolveSigner: (witnessId: string) => Signer | null,
): WitnessQuorumResult {
  if (!Array.isArray(statements)) {
    throw new WitnessError("BAD_INPUT", "collectWitnessQuorum: statements must be an array");
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new WitnessError("BAD_INPUT", "collectWitnessQuorum: threshold must be an integer >= 1");
  }
  if (!target || !HEX64_RE.test(target.root) || !Number.isInteger(target.treeSize)) {
    throw new WitnessError("BAD_INPUT", "collectWitnessQuorum: invalid target tree head");
  }

  const agreeing = new Set<string>();
  const conflictingRoots = new Set<string>();

  for (const st of statements) {
    // Only statements about the same log position are relevant.
    if (!st || st.logId !== target.logId || st.treeSize !== target.treeSize) continue;

    const signer = resolveSigner(st.witnessId);
    if (!signer) continue; // unknown witness → ignore (fail-closed)
    if (!verifyWitnessStatement(st, signer)) continue; // bad signature → ignore

    if (st.root === target.root) {
      agreeing.add(st.witnessId);
    } else {
      // A verified witness signed a different root at the same position.
      conflictingRoots.add(st.root);
    }
  }

  if (conflictingRoots.size > 0) {
    throw new SplitViewError(target.logId, target.treeSize, [target.root, ...conflictingRoots]);
  }

  const witnessIds = [...agreeing].sort();
  return {
    reached: witnessIds.length >= threshold,
    distinctWitnesses: witnessIds.length,
    threshold,
    witnessIds,
  };
}

export type WitnessErrorCode = "BAD_SIGNER" | "BAD_OBSERVATION" | "BAD_INPUT";

export class WitnessError extends Error {
  readonly code: WitnessErrorCode;
  constructor(code: WitnessErrorCode, message: string) {
    super(message);
    this.name = "WitnessError";
    this.code = code;
  }
}
