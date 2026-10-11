/**
 * lib/common/canonical-json.ts
 *
 * Deterministic canonical JSON stringify (v2).
 * - Keys sorted recursively alphabetically
 * - BigInt → tagged object {"$bigint":"<decimal>"} (type-safe: 123n ≠ "123")
 * - TRUE cycles → key dropped; SHARED (acyclic/DAG) references serialise IN FULL
 *   (v2 fix: the old WeakSet never unwound, so shared refs and duplicate array
 *   slots were silently DROPPED — two different objects could hash identically.
 *   Cycle detection now tracks the ACTIVE recursion path only: added on enter,
 *   deleted on leave.)
 * - null preserved (not treated as object)
 * - undefined values → key dropped (consistent with JSON.stringify)
 *
 * Used for hash-stable serialization across transparency-log, track-record,
 * passport, and anywhere two parties must recompute the exact same digest.
 *
 * Invariant: canonicalJson(a) === canonicalJson(b)  ⟺  deep-equal(a, b)
 * (modulo true cyclic refs and undefined values, which drop from output;
 *  modulo the BigInt tag — build BigInt fields as BigInt, never as raw decimal
 *  strings, or the two will collide by design of JSON).
 *
 * v2 HASH-COMPAT NOTE (pre-live per armed→live doctrine — host decision):
 * digests computed with v1 over payloads containing BigInt values or shared
 * references differ from v2. Re-seed / re-issue any persisted digests before
 * go-live; never mix v1 and v2 outputs across verifying parties.
 *
 * Efficiency (v372): builds the canonical JSON string directly instead of first
 * materialising an intermediate sorted-keys object tree and then calling
 * JSON.stringify on it. The previous approach allocated one `{}` accumulator
 * per object node (O(nodes) extra heap objects). The new approach writes
 * each key-value pair straight into the output string, cutting GC pressure on
 * deeply-nested proof bundles and receipt payloads — the two hottest callers.
 */

export function canonicalJson(obj: unknown): string {
  return canonicalSerialise(obj, new Set<object>()) ?? "null";
}

/**
 * Returns the serialised string for `val`, or undefined when the value should
 * be omitted from the parent (true cyclic ref on the active path, or undefined).
 * `active` holds only the objects currently being serialised up the recursion
 * stack, so shared/acyclic references serialise in full while genuine cycles
 * are cut (key omitted by caller; array slot falls back to "null").
 */
function canonicalSerialise(val: unknown, active: Set<object>): string | undefined {
  if (val === undefined) return undefined;
  if (val === null) return "null";
  if (typeof val === "bigint") return '{"$bigint":' + JSON.stringify(val.toString()) + "}";
  if (typeof val !== "object") return JSON.stringify(val);
  if (active.has(val)) return undefined; // true cycle → drop (key omitted by caller)
  active.add(val);
  try {
    if (Array.isArray(val)) {
      // Array slots that are undefined serialise as "null" (matches JSON.stringify).
      return "[" + val.map((item) => canonicalSerialise(item, active) ?? "null").join(",") + "]";
    }
    const o = val as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const pairs: string[] = [];
    for (const k of keys) {
      const serialised = canonicalSerialise(o[k], active);
      if (serialised !== undefined) {
        pairs.push(JSON.stringify(k) + ":" + serialised);
      }
    }
    return "{" + pairs.join(",") + "}";
  } finally {
    active.delete(val);
  }
}
