/**
 * lib/transparency-log/consistency-monitor.ts — Consistency monitor for the transparency log.
 *
 * PURPOSE
 * -------
 * A monitor that verifies the log only grows — no history rewrite, no split-view.
 * For every historical anchored root it verifies that the root is still a valid
 * prefix of the current (latest) tree. This is the correct shape for
 * `getConsistencyProof`, which always proves `oldSize → currentTree`.
 *
 * DESIGN
 * ------
 * • Pure logic: no I/O beyond calls to the TransparencyLog.
 * • Stateless check: takes the full current root list and the log; no in-process
 *   state is retained between calls.
 * • Fail-closed: a root that cannot be verified (null proof, verify returns false)
 *   counts as a failure, not as inconclusive.
 * • Efficiency: O(roots − 1) proofs; each verification is O(n) in leaf count —
 *   same cost as one inclusion proof per historical root.
 */

import { verifyConsistencyProof } from "./consistency-proof";
import type { ConsistencyProof } from "./consistency-proof";
import type { AnchoredRoot } from "./types";

/** Minimal surface of TransparencyLog needed by the monitor. */
export interface ConsistencyCheckable {
  getConsistencyProof(tenantId: string, oldSize: number): Promise<ConsistencyProof | null>;
  getRoots(tenantId: string): Promise<AnchoredRoot[]>;
}

export interface MonitorResult {
  /** Number of historical roots checked against the current root. */
  checked: number;
  /** Number of roots that failed consistency (tamper signal). */
  failures: number;
  /** true iff failures === 0 (or rootCount <= 1, trivially consistent). */
  ok: boolean;
  /** Root count for the tenant at time of check. */
  rootCount: number;
}

/**
 * Verify that every historical anchored root for `tenantId` is a valid prefix
 * of the current (latest) tree. Uses `getConsistencyProof(tenantId, oldSize)`,
 * which returns a proof from `oldSize` leaves → current full tree, then
 * independently recomputes both roots from the proof's leaf hashes.
 *
 * Returns `{ ok: true, checked: 0, failures: 0, rootCount: N }` when N <= 1.
 * Any proof that is null or fails verification increments `failures`.
 */
export async function runConsistencyMonitor(
  tenantId: string,
  log: ConsistencyCheckable,
): Promise<MonitorResult> {
  const roots = await log.getRoots(tenantId);
  const rootCount = roots.length;

  if (rootCount <= 1) {
    return { checked: 0, failures: 0, ok: true, rootCount };
  }

  const currentRoot = roots[roots.length - 1];
  let checked = 0;
  let failures = 0;

  // Check every root except the last one (the current root is the newRoot target).
  for (let i = 0; i < roots.length - 1; i++) {
    const older = roots[i];

    // Proof: first older.leafCount leaves are a prefix of the current tree.
    const proof = await log.getConsistencyProof(tenantId, older.leafCount);
    checked++;

    if (!proof) {
      failures++;
      continue;
    }

    const ok = verifyConsistencyProof(proof, older.root, currentRoot.root);
    if (!ok) failures++;
  }

  return { checked, failures, ok: failures === 0, rootCount };
}
