/**
 * lib/common/canonical-json.ts
 *
 * Deterministic canonical JSON stringify.
 * - Keys sorted recursively alphabetically
 * - BigInt → decimal string
 * - Cyclic references → key dropped (same behaviour as the original)
 * - null preserved (not treated as object)
 * - undefined values → key dropped (consistent with JSON.stringify)
 *
 * Used for hash-stable serialization across transparency-log, track-record,
 * passport, and anywhere two parties must recompute the exact same digest.
 *
 * Invariant: canonicalJson(a) === canonicalJson(b)  ⟺  deep-equal(a, b)
 * (modulo cyclic refs and undefined values, which drop from output).
 *
 * Efficiency (v372): builds the canonical JSON string directly instead of first
 * materialising an intermediate sorted-keys object tree and then calling
 * JSON.stringify on it. The previous approach allocated one `{}` accumulator
 * per object node (O(nodes) extra heap objects). The new approach writes
 * each key-value pair straight into the output string, cutting GC pressure on
 * deeply-nested proof bundles and receipt payloads — the two hottest callers.
 */

export function canonicalJson(obj: unknown): string {
  return canonicalSerialise(obj, new WeakSet<object>()) ?? "null";
}

/**
 * Returns the serialised string for `val`, or undefined when the value should
 * be omitted from the parent (cyclic ref, or undefined).  Callers that care
 * about omission (object key serialisation) check for undefined explicitly.
 */
function canonicalSerialise(val: unknown, seen: WeakSet<object>): string | undefined {
  if (val === undefined) return undefined;
  if (val === null) return "null";
  if (typeof val === "bigint") return JSON.stringify(val.toString());
  if (typeof val !== "object") return JSON.stringify(val);
  if (seen.has(val)) return undefined; // cyclic ref → drop (key omitted by caller)
  seen.add(val);
  if (Array.isArray(val)) {
    // Array slots that are undefined serialise as "null" (matches JSON.stringify).
    return "[" + val.map((item) => canonicalSerialise(item, seen) ?? "null").join(",") + "]";
  }
  const o = val as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    const serialised = canonicalSerialise(o[k], seen);
    if (serialised !== undefined) {
      pairs.push(JSON.stringify(k) + ":" + serialised);
    }
  }
  return "{" + pairs.join(",") + "}";
}
