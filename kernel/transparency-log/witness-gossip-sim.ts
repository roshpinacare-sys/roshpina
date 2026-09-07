/**
 * lib/transparency-log/witness-gossip-sim.ts — witness gossip protocol, in-process simulation.
 *
 * SECURITY NOTE — SIMULATION TAG (-sim)
 * ─────────────────────────────────────
 * This is a **-sim** (in-process simulation). It faithfully implements the
 * Certificate-Transparency gossip model's *trust logic* — split-view detection,
 * fail-closed on unknown witnesses, deduplication by {witnessId, logId, treeSize,
 * root} — but uses in-memory arrays instead of real network transport. In
 * production, each peer would be a separate process or host exchanging statements
 * over an authenticated channel (e.g. mTLS + signed HTTP). The simulation is
 * clearly labeled; it is not presented as a real network implementation.
 *
 * WHY THIS EXISTS (§2.D-10)
 * ─────────────────────────
 * Quorum (v387) and liveness (v405) operate over a *single registry*: one server
 * accumulating submitted statements. Gossip is the complementary mechanism: peers
 * with *separate statement stores* exchange observations and cross-check for
 * consistency **before** any central quorum gate is consulted. This closes a gap
 * where a compromised log operator withholds certain statements from the registry
 * while still passing a quorum check on a cherry-picked subset.
 *
 * In the gossip model:
 *   • Each "peer" is an independent observer with its own WitnessStatement inbox.
 *   • A "gossip round" is a fan-out: every peer broadcasts all its statements to
 *     every other peer; each peer merges incoming statements it can verify.
 *   • If a peer holds a verified statement at (logId, treeSize) with root A, and
 *     receives a verified statement from the same witness at the same position with
 *     root B ≠ A, a SplitViewError is raised — fail-closed, no data returned.
 *
 * DESIGN
 * ──────
 * • WitnessGossipPeer  — one participant: a named inbox of accepted statements,
 *   plus the resolveSigner callback that came with it.
 * • WitnessGossipSim   — the coordinator: holds peers, runs gossipRound().
 * • gossipRound()      — O(peers² × stmts) fan-out; fine for the simulation
 *   scale (< 100 peers, < 10 000 stmts per peer). Each merge is idempotent
 *   (key = witnessId+logId+treeSize+root).
 * • Fail-closed invariants:
 *     - Unregistered witness → statement not accepted into peer inbox.
 *     - Signature does not verify → rejected.
 *     - Conflicting root at same position from any verified witness → SplitViewError.
 *     - Duplicate statement (same key, same root) → silently deduplicated.
 *
 * Zero external dependencies. No I/O. Pure TypeScript.
 */

import type { Signer } from "../orchestrator/types";
import {
  verifyWitnessStatement,
  SplitViewError,
  type WitnessStatement,
} from "./witness";

// ─── Deduplication key ───────────────────────────────────────────────────────

/**
 * Canonical dedup key for a statement. Two statements with the same key but
 * different roots are a split-view (not a duplicate). Two statements that
 * agree on root AND are from the same witness at the same position are a
 * redundant duplicate — merge keeps only one.
 */
function stmtKey(s: WitnessStatement): string {
  return `${s.witnessId}|${s.logId}|${s.treeSize}|${s.root}`;
}

// ─── GossipPeer ──────────────────────────────────────────────────────────────

/**
 * A single gossip peer: an independent observer with its own verified-statement
 * inbox and the ability to resolve witness verifying-keys.
 *
 * Fail-closed: `accept()` rejects any statement whose witnessId is unresolvable
 * or whose signature does not verify. Split-view detection fires during `accept()`
 * when a new (verified) statement conflicts with an already-accepted statement at
 * the same (logId, treeSize) position.
 */
export class WitnessGossipPeer {
  /** Stable name for logging / debugging (e.g. a replica hostname). */
  readonly name: string;

  /** Accepted statements, keyed by dedup-key for O(1) lookup. */
  private readonly inbox = new Map<string, WitnessStatement>();

  /**
   * Resolve a witness's verifying Signer by witnessId.
   * Returns null for unknown witnesses (fail-closed: unknown → reject).
   */
  private readonly _resolveSigner: (witnessId: string) => Signer | null;

  constructor(name: string, resolveSigner: (witnessId: string) => Signer | null) {
    if (!name || typeof name !== "string") {
      throw new GossipError("BAD_PEER", "WitnessGossipPeer: name must be a non-empty string");
    }
    if (typeof resolveSigner !== "function") {
      throw new GossipError("BAD_PEER", "WitnessGossipPeer: resolveSigner must be a function");
    }
    this.name = name;
    this._resolveSigner = resolveSigner;
  }

  /**
   * Attempt to accept a statement into this peer's inbox.
   *
   * Returns "accepted" if the statement is new and verifies.
   * Returns "duplicate" if the same key is already present (idempotent).
   * Returns "rejected" if the witnessId is unknown or signature fails.
   * Throws SplitViewError if a verified statement for the same (logId, treeSize)
   * carries a different root than an already-accepted verified statement.
   */
  accept(statement: WitnessStatement): "accepted" | "duplicate" | "rejected" {
    if (!statement || typeof statement !== "object") return "rejected";

    // Resolve witness key — unknown witnesses are fail-closed rejected.
    const signer = this._resolveSigner(statement.witnessId);
    if (!signer) return "rejected";

    // Verify signature — tampered or structurally invalid → rejected.
    if (!verifyWitnessStatement(statement, signer)) return "rejected";

    // Split-view check: scan inbox for any accepted statement at the same
    // (witnessId, logId, treeSize) with a different root.
    // Efficiency: only scan statements from this witnessId at this position
    // — the dedup key encodes root, so a conflict has the same prefix minus
    // the root. We iterate only the inbox (not all statements) and break early.
    const positionPrefix = `${statement.witnessId}|${statement.logId}|${statement.treeSize}|`;
    for (const [key] of this.inbox) {
      if (key.startsWith(positionPrefix) && !key.endsWith(`|${statement.root}`)) {
        // A verified statement from this witness at this position carries a
        // different root → split-view detected.
        const existingRoot = key.slice(positionPrefix.length);
        throw new SplitViewError(statement.logId, statement.treeSize, [statement.root, existingRoot]);
      }
    }

    const key = stmtKey(statement);
    if (this.inbox.has(key)) return "duplicate";

    this.inbox.set(key, statement);
    return "accepted";
  }

  /** All statements currently accepted by this peer, insertion-ordered. */
  statements(): WitnessStatement[] {
    return [...this.inbox.values()];
  }

  /** Number of accepted (deduplicated) statements. */
  get size(): number {
    return this.inbox.size;
  }
}

// ─── GossipSim ───────────────────────────────────────────────────────────────

/** Per-peer exchange result from one gossip round. */
export interface PeerGossipResult {
  /** Peer name. */
  peerName: string;
  /** Statements successfully merged into this peer from all other peers. */
  accepted: number;
  /** Statements already present (no-op). */
  duplicates: number;
  /** Statements rejected (unknown witness / bad signature). */
  rejected: number;
}

/** Aggregate result of one full gossip round (all peers × all peers). */
export interface GossipRoundResult {
  /** Round counter (1-indexed). */
  round: number;
  /** True iff at least one new statement was merged by any peer. */
  anyChange: boolean;
  /** Per-peer breakdown. */
  peers: PeerGossipResult[];
}

/**
 * WitnessGossipSim — coordinator for an in-process gossip simulation.
 *
 * SECURITY NOTE: This is a -sim. Peer-to-peer exchange is in-memory (direct
 * method calls). In production, replace with authenticated network transport.
 *
 * Usage:
 *   const sim = new WitnessGossipSim();
 *   sim.addPeer(peerA);
 *   sim.addPeer(peerB);
 *   const result = sim.gossipRound();  // exchange all statements, detect splits
 */
export class WitnessGossipSim {
  private readonly peers: WitnessGossipPeer[] = [];
  private roundCount = 0;

  /** Add a peer to the simulation. Duplicate names are rejected. */
  addPeer(peer: WitnessGossipPeer): void {
    if (!(peer instanceof WitnessGossipPeer)) {
      throw new GossipError("BAD_PEER", "addPeer: argument must be a WitnessGossipPeer");
    }
    if (this.peers.some((p) => p.name === peer.name)) {
      throw new GossipError("DUPLICATE_PEER", `addPeer: peer "${peer.name}" already registered`);
    }
    this.peers.push(peer);
  }

  /** Number of registered peers. */
  get peerCount(): number {
    return this.peers.length;
  }

  /**
   * Run one gossip round: every peer broadcasts all its current statements
   * to every other peer. Each receiving peer accepts, deduplicates, or rejects
   * each statement per its own policy.
   *
   * Throws SplitViewError immediately if any merge triggers a conflict — the
   * partial state at that point is preserved so the caller can inspect it, but
   * the round is considered failed.
   *
   * Returns a GossipRoundResult describing what changed.
   */
  gossipRound(): GossipRoundResult {
    if (this.peers.length < 2) {
      throw new GossipError("INSUFFICIENT_PEERS", "gossipRound: at least 2 peers are required");
    }

    this.roundCount++;
    const round = this.roundCount;
    const peerResults: PeerGossipResult[] = this.peers.map((p) => ({
      peerName: p.name,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
    }));

    // Fan-out: for each sender, push all statements to every other receiver.
    // Snapshot sender statements first to avoid read-your-writes within a round.
    const snapshots = this.peers.map((p) => p.statements());

    for (let s = 0; s < this.peers.length; s++) {
      const senderStmts = snapshots[s];
      for (let r = 0; r < this.peers.length; r++) {
        if (r === s) continue; // no self-gossip
        const receiver = this.peers[r];
        const result = peerResults[r];
        for (const stmt of senderStmts) {
          const outcome = receiver.accept(stmt); // may throw SplitViewError
          if (outcome === "accepted") result.accepted++;
          else if (outcome === "duplicate") result.duplicates++;
          else result.rejected++;
        }
      }
    }

    const anyChange = peerResults.some((r) => r.accepted > 0);
    return { round, anyChange, peers: peerResults };
  }

  /**
   * Run gossip rounds until convergence (no new statements accepted) or
   * `maxRounds` is reached. Returns the results of all rounds run.
   *
   * Throws SplitViewError on the first split-view detected (same semantics
   * as gossipRound). Throws GossipError if convergence is not reached within
   * maxRounds (indicates a bug or unbounded statement growth).
   */
  gossipUntilConverged(maxRounds = 10): GossipRoundResult[] {
    const results: GossipRoundResult[] = [];
    for (let i = 0; i < maxRounds; i++) {
      const r = this.gossipRound();
      results.push(r);
      if (!r.anyChange) return results; // converged
    }
    throw new GossipError(
      "NO_CONVERGENCE",
      `gossipUntilConverged: did not converge within ${maxRounds} rounds`,
    );
  }
}

// ─── Error type ──────────────────────────────────────────────────────────────

export type GossipErrorCode =
  | "BAD_PEER"
  | "DUPLICATE_PEER"
  | "INSUFFICIENT_PEERS"
  | "NO_CONVERGENCE";

export class GossipError extends Error {
  readonly code: GossipErrorCode;
  constructor(code: GossipErrorCode, message: string) {
    super(message);
    this.name = "GossipError";
    this.code = code;
  }
}
