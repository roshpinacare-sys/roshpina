<!-- hardening:allow-file ALL reason=patch specifications quoting the defective function signatures they change -->

# Patch Spec P-09 and P-10 - exact code, read out of the files they change

Two HIGH-severity findings, both in a single function, both verified verbatim from
source on 2026-09-11. Every quoted line below was read from the file, not
reconstructed from memory.

The epoch specification published the same way was adopted in full, including the
subtlety about assigning once per job rather than per chain. This follows the same
shape: the current code, the replacement, the call sites, the migration, and the
test that would have caught it.

---

# P-09 - `reconstructSecret` takes no threshold

**File:** `Saosmartwallet/packages/core/src/crypto/shamir.ts` (8,092 chars)

## The code as it stands

    export async function reconstructSecret(shares: Share[]): Promise<Uint8Array> {
      if (!Array.isArray(shares) || shares.length === 0) {
        throw new VaultError("SHAMIR_INVALID", "no shares provided");
      }

      const seen = new Set<number>();
      const parsed: Array<{ x: number; data: Uint8Array }> = [];
      for (const s of shares) {
        if (s === null || typeof s !== "object") {
          throw new VaultError("SHAMIR_INVALID", "share is not an object");
        }
        if (!Number.isInteger(s.index) || s.index < 1 || s.index > 255) {
          throw new VaultError("SHAMIR_INVALID", "share index must be an integer in [1, 255]");
        }
        if (typeof s.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s.data)) {
          throw new VaultError("SHAMIR_INVALID", "share data is not valid base64");
        }
        const data = b64ToBytes(s.data);
        if (data.length === 0) {
          throw new VaultError("SHAMIR_INVALID", "share data is empty");
        }
        if (seen.has(s.index)) {
          throw new VaultError("SHAMIR_INVALID", `duplicate share index ${s.index}`);
        }
        seen.add(s.index);
        parsed.push({ x: s.index, ...

The per-share validation is thorough and correct. **What is missing is any check on
how many shares there are.** The signature does not accept a threshold, so no such
check is possible.

By contrast the split side is sound:

    export async function shardSecret(secret: Uint8Array, threshold: number,
                                      totalShares: number): Promise<Share[]> {
      if (!Number.isInteger(threshold) || !Number.isInteger(totalShares)) { throw ... }
      if (threshold < 1 || totalShares < 1) { throw ... }
      if (threshold > totalShares) { throw ... }

**The split validates its threshold. The rejoin never receives one.**

## Consequences

- **1 share** fits a degree-0 polynomial and returns that share's bytes as the secret
- **2 shares of a 3-of-5** fits a line and returns a **wrong secret**, with no error
- The output length comes from `Math.max` over the shares supplied, so a short
  reconstruction is not even length-checked against the original

And the module's own header names this exact pitfall: a reconstruction from too few
shares silently produces a WRONG secret.

**Why it matters more than it looks:** social recovery is the last resort - the
password is gone, the device is gone, and t of n guardians are producing shares.
That is exactly when a wrong-but-plausible secret is worst, because the
reconstruction succeeds, the caller then fails to open the AEAD envelope, and the
failure reads as "the shares are wrong" or "the backup is corrupt". The real cause -
too few shares - is never reported.

## The two call sites

Both are in `packages/core/src/backup/backup.ts`, both in recovery paths:

    const wrappingKey = await reconstructSecret(shares);
    const recoveryKey = await reconstructSecret(shares);

Neither passes a threshold, because the function does not take one.

## The patch

    export async function reconstructSecret(
      shares: Share[],
      threshold: number,
    ): Promise<Uint8Array> {
      if (!Array.isArray(shares) || shares.length === 0) {
        throw new VaultError("SHAMIR_INVALID", "no shares provided");
      }
      if (!Number.isInteger(threshold) || threshold < 1) {
        throw new VaultError("SHAMIR_INVALID", "threshold must be an integer >= 1");
      }
      if (shares.length < threshold) {
        throw new VaultError(
          "SHAMIR_INVALID",
          `insufficient shares: ${shares.length} of ${threshold} required - refusing ` +
          `to interpolate, which would return a plausible wrong secret`,
        );
      }
      ...

Every caller already knows the threshold: `shardSecret` was given it, and the backup
metadata stores it alongside the shares. **This is plumbing, not design.**

At the two call sites, pass it through:

    const wrappingKey = await reconstructSecret(shares, meta.threshold);
    const recoveryKey = await reconstructSecret(shares, meta.threshold);

If a stored backup predates the threshold field, read it from the shard count
recorded at creation, or refuse - do not default it to `shares.length`, which would
reproduce the current behaviour under a new name.

## The test that would have caught this

    // 2 shares of a 3-of-5 must throw, not return bytes
    const shares = await shardSecret(secret, 3, 5);
    await expect(reconstructSecret(shares.slice(0, 2), 3))
      .rejects.toThrow(/insufficient shares: 2 of 3/);

    // and the happy path still works
    const out = await reconstructSecret(shares.slice(0, 3), 3);
    expect(out).toEqual(secret);

Without the first assertion the function is correct for every input its author
tried, which is exactly how it shipped.

---

# P-10 - the audit hash binds 5 of 11 fields

**File:** `roshpina/kernel/orchestrator/audit.ts` (5,372 chars, 162 lines)

## The code as it stands

    function computeHash(record: Omit<AuditRecord, "hash">): string {
      const data = [
        record.id,
        record.tenantId,
        record.actionType,
        record.outcome,
        record.prevHash,
      ].join("|");
      return createHash("sha256").update(data, "utf8").digest("hex");
    }

And the record it hashes:

    interface AuditRecord {
      id, tenantId, actionId, actionType,
      source,        // "Which agent / service produced the action."
      outcome,
      reason?,       // "Human-readable explanation for denied or error outcomes."
      occurredAt,    // ISOTimestamp
      prevHash,      // "genesis" for the first record
      hash,          // documented as "SHA-256 of this record's canonical fields"
      signature?     // "Cryptographic signature over hash, proving who wrote this"
    }

| forensic question | field | bound? |
|---|---|---|
| **WHO** | `source` | **no** |
| **WHEN** | `occurredAt` | **no** |
| **WHY** | `reason` | **no** |
| **WHICH** | `actionId` | **no** |
| WHAT | `actionType` | yes |
| OUTCOME | `outcome` | yes |
| ORDER | `prevHash` | yes |

Anyone who can write to the store can rewrite **which agent acted, when it
happened, and why a refusal was refused** on any existing record, and
`verifyChain()` still returns true. The `signature` does not close the gap - it is
computed over `hash`, so it attests to the same five fields and no more.

The field comment says `hash` is "SHA-256 of this record's canonical fields", which
reads as all of them. It is five.

## The patch

    function computeHash(record: Omit<AuditRecord, "hash">): string {
      const data = [
        record.id,
        record.tenantId,
        record.actionId ?? "",
        record.actionType,
        record.source ?? "",
        record.outcome,
        record.reason ?? "",
        record.occurredAt,
        record.prevHash,
      ].join("|");
      return createHash("sha256").update(data, "utf8").digest("hex");
    }

`?? ""` keeps the hash stable for records where an optional field is absent, and
keeps the separator count fixed so a record cannot be reshaped into another by
moving a value between fields.

## Migration - and this is the part that cannot be skipped

**Every existing hash changes.** `verifyChain` will report the whole chain as broken
the moment this lands, because it recomputes hashes that no longer match.

Three options, in order of preference:

1. **Version the hash scheme.** Add `hashVersion` to `AuditRecord`, default 1 for
   existing records and 2 for new ones. `verifyChain` selects the field list by
   version. Nothing existing breaks, and every new record is fully bound. This is
   the same pattern the epoch field used in `saos-dex` - a new field, not a rewrite.
2. **Recompute and re-anchor.** Recompute every stored hash under the new scheme,
   and publish the new head publicly so the recompute is itself attested. Do not do
   this silently - a chain whose hashes all changed without a public record looks
   exactly like tampering.
3. **Do nothing and document it.** Acceptable only if the audit log is not used as
   evidence, which contradicts its purpose.

Option 1 is a few lines and breaks nothing. Options 2 and 3 both cost trust.

Also worth doing in the same change: bind the genesis to a store instance instead
of the literal string `"genesis"`. `tenantId` is hashed, which prevents
cross-tenant grafting, but not re-genesis of a single tenant's history.

---

## What is not being asked here

Neither patch changes a payload format that is already anchored on a public chain.
P-09 changes a function signature inside one package. P-10 changes a hash
preimage, with an explicit version field so nothing already written becomes
unreadable.

Compare the withdrawn P-07, which proposed removing `digest` and `at` from the
anchor payload. That would have broken the six-field equality verified between
Ethereum block 25,929,672 and Solana slot 445,225,030 and orphaned every existing
anchor. **It is withdrawn in `docs/RELAY-PATCH-2.md` and the reason is recorded
there.**

The difference between these patches and that one is not effort. It is whether the
recommendation was checked against the code that consumes the field.

---

*Read-only throughout. No file outside saos-jummper was created, modified or
deleted. These are specifications; they do not apply themselves.*
