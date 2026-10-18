/**
 * kernel/ledger/persistent-ledger.test.ts — P1 proof suite (bun:test).
 *
 * הטענות-שנבדקות כאן אינן-הצהרות: כל-מבחן מפיל-את-הריצה על-הפרה.
 *   1. פעולות חיות → הפעלה-מחדש מאותו-יומן → יתרות/עסקאות/כשירות-פירעון זהות.
 *   2. פגיעה ביומן → אתחול מסרב (fail-closed), לעולם לא עולה שקט.
 *   3. idempotency חוצה-הפעלה-מחדש: אותו-מפתח מחזיר את-אותה-עסקה, לא מטביע פעמיים.
 *   4. fold עם עסקה-שאינה-משמרת / לא-מאוזנת → נדחה.
 *   5. snapshot: נתיב-מהיר + fold-מלא מאשרים זה-את-זה; snapshot פגום = מוזנח (היומן שולט).
 *   6. parseMicroCents: מחרוזת-עשרונית בלבד; שום-float לא עובר; דיוק μ¢ מלא.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical-json";
import { PersistentLedger, Journal, fold, parseMicroCents, microCentsToString, JournalError } from "./persistent-ledger";
import type { Account, LedgerTransaction } from "./types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "roshpina-journal-"));
}

const balanceHashOf = (rows: Account[]) =>
  createHash("sha256")
    .update(canonicalJson(rows.map((a) => ({ id: a.id, balance: a.balance.toString() }))))
    .digest("hex");

let dir: string;
beforeEach(() => {
  dir = tmpDir();
});

/** alice 10.00 · bob 2.50 (transfer paid) · reserve journaled lazily by the mint. */
async function seed(led: PersistentLedger): Promise<{ alice: string; bob: string }> {
  const alice = await led.createAccount("t1", "u-alice", "asset", "alice", "seed-alice");
  const bob = await led.createAccount("t1", "u-bob", "asset", "bob", "seed-bob");
  await led.guardMint("t1", alice.id, parseMicroCents("10.00"), "seed mint", "operator", "seed-mint");
  await led.transfer("t1", alice.id, bob.id, parseMicroCents("2.50"), "pay bob", "operator", "seed-move");
  return { alice: alice.id, bob: bob.id };
}

describe("PersistentLedger — reboot equality (the measured hole, closed)", () => {
  test("state survives a full restart", async () => {
    const l1 = await PersistentLedger.open(dir);
    const s = await seed(l1);
    const preProof = await l1.proofOfSolvency("t1");
    const preTxs = [...l1.exportState().transactions].sort((a, b) => a.id.localeCompare(b.id));
    l1.close();

    const l2 = await PersistentLedger.open(dir); // fresh-process equivalent
    const postProof = await l2.proofOfSolvency("t1");
    const postTxs = [...l2.exportState().transactions].sort((a, b) => a.id.localeCompare(b.id));

    expect(postProof.totalAssets).toBe(preProof.totalAssets);
    expect(postProof.totalLiabilities).toBe(preProof.totalLiabilities);
    expect(postProof.balanceHash).toBe(preProof.balanceHash);
    expect(postTxs.map((t) => t.id)).toEqual(preTxs.map((t) => t.id));
    // exact balances: alice = 10.00 − 2.50 · bob = 2.50
    expect((await l2.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("7.50"));
    expect((await l2.getAccount("t1", s.bob)).balance).toBe(parseMicroCents("2.50"));
    // the lazy platform-reserve account survived (journaled together with the mint op)
    expect((await l2.listAccounts("t1")).some((a) => a.ownerId === "system")).toBe(true);
    // per-account transaction history is intact across reboot
    expect((await l2.getTransactions("t1", s.alice)).length).toBe(2); // mint + transfer
    expect((await l2.getTransactions("t1", s.bob)).length).toBe(1); // transfer
    l2.close();
  });

  test("μ¢ precision and multi-tenant isolation survive reboot", async () => {
    const l1 = await PersistentLedger.open(dir);
    const a = await l1.createAccount("tx", "u1", "asset", "a", "k1");
    const b = await l1.createAccount("ty", "u2", "asset", "b", "k2");
    await l1.guardMint("tx", a.id, parseMicroCents("100.00"), "m", "op", "m1");
    await l1.guardMint("ty", b.id, parseMicroCents("0.0001"), "m", "op", "m2"); // exactly 1 μ¢
    const h1 = (await l1.proofOfSolvency("tx")).balanceHash;
    const h2 = (await l1.proofOfSolvency("ty")).balanceHash;
    l1.close();

    const l2 = await PersistentLedger.open(dir);
    expect((await l2.proofOfSolvency("tx")).balanceHash).toBe(h1);
    expect((await l2.proofOfSolvency("ty")).balanceHash).toBe(h2);
    expect((await l2.getAccount("ty", b.id)).balance).toBe(1n);
    l2.close();
  });
});

describe("Journal — tamper refusal (fail-closed)", () => {
  test("rewriting a committed amount refuses boot", async () => {
    const l1 = await PersistentLedger.open(dir);
    await seed(l1);
    l1.close();

    const p = path.join(dir, "journal.jsonl");
    const raw = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    const i = raw.findIndex((l) => (JSON.parse(l).rec.tx?.kind ?? null) === "mint");
    expect(i).toBeGreaterThan(-1);
    const env = JSON.parse(raw[i]);
    env.rec.tx.amount = "999999.0000"; // rewrite history — the classic
    raw[i] = JSON.stringify(env);
    fs.writeFileSync(p, raw.join("\n") + "\n");

    let code = "";
    try {
      await PersistentLedger.open(dir);
    } catch (e) {
      code = e instanceof JournalError ? e.code : (e as Error).name;
    }
    expect(code).toBe("JOURNAL_TAMPERED");
  });

  test("a deleted middle line refuses boot", async () => {
    const l1 = await PersistentLedger.open(dir);
    await seed(l1);
    l1.close();

    const p = path.join(dir, "journal.jsonl");
    const raw = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    raw.splice(1, 1); // drop seq=2
    fs.writeFileSync(p, raw.join("\n") + "\n");

    let code = "";
    try {
      await PersistentLedger.open(dir);
    } catch (e) {
      code = e instanceof JournalError ? e.code : (e as Error).name;
    }
    expect(["JOURNAL_SEQ_GAP", "JOURNAL_CHAIN_BREAK", "JOURNAL_TAMPERED"]).toContain(code);
  });
});

describe("Idempotency — including across restart", () => {
  test("same key → same tx, exactly one effect; also after reboot", async () => {
    const l1 = await PersistentLedger.open(dir);
    const a = await l1.createAccount("t1", "u", "asset", "a", "acc-k");
    const mint = await l1.guardMint("t1", a.id, parseMicroCents("1.00"), "m", "op", "m-k");
    const again = await l1.guardMint("t1", a.id, parseMicroCents("1.00"), "m", "op", "m-k");
    expect(again.id).toBe(mint.id);
    expect((await l1.getAccount("t1", a.id)).balance).toBe(parseMicroCents("1.00")); // NOT 2.00
    l1.close();

    const l2 = await PersistentLedger.open(dir);
    const afterCrash = await l2.guardMint("t1", a.id, parseMicroCents("1.00"), "m", "op", "m-k");
    expect(afterCrash.id).toBe(mint.id);
    expect((await l2.getAccount("t1", a.id)).balance).toBe(parseMicroCents("1.00")); // still once
    const accAgain = await l2.createAccount("t1", "u", "asset", "a", "acc-k");
    expect(accAgain.id).toBe(a.id);
    l2.close();
  });
});

describe("fold — conservation is the law", () => {
  test("a non-conserving tx refuses the fold", async () => {
    const l1 = await PersistentLedger.open(dir);
    await seed(l1);
    l1.close();

    const j = new Journal(dir);
    const { records } = j.open();
    const broken = records.map((env) => {
      if (env.rec.tx?.kind === "mint") {
        const bad: typeof env = {
          ...env,
          rec: { ...env.rec, tx: { ...env.rec.tx, amount: "999999" } }, // integer — but does NOT conserve
        };
        return bad;
      }
      return env;
    });
    let code = "";
    try {
      fold(broken);
    } catch (e) {
      code = e instanceof JournalError ? e.code : (e as Error).name;
    }
    expect(code).toBe("FOLD_CONSERVATION");
  });

  test("a non-integer μ¢ string in the JSON channel refuses the fold", async () => {
    const l1 = await PersistentLedger.open(dir);
    await seed(l1);
    l1.close();
    const j = new Journal(dir);
    const { records } = j.open();
    const broken = records.map((env) =>
      env.rec.tx?.kind === "mint"
        ? ({ ...env, rec: { ...env.rec, tx: { ...env.rec.tx, amount: "3.3333" } } } as typeof env)
        : env,
    );
    let code = "";
    try {
      fold(broken);
    } catch (e) {
      code = e instanceof JournalError ? e.code : (e as Error).name;
    }
    expect(code).toBe("FOLD_BAD_NUMBER");
  });

  test("a single-leg tx refuses the fold", async () => {
    const l1 = await PersistentLedger.open(dir);
    await seed(l1);
    l1.close();
    const j = new Journal(dir);
    const { records } = j.open();
    const broken = records.map((env) =>
      env.rec.tx?.kind === "mint"
        ? ({ ...env, rec: { ...env.rec, entries: env.rec.entries.slice(0, 1) } } as typeof env)
        : env,
    );
    let code = "";
    try {
      fold(broken);
    } catch (e) {
      code = e instanceof JournalError ? e.code : (e as Error).name;
    }
    expect(code).toBe("FOLD_ENTRY_COUNT");
  });

  test("fold of the honest journal reproduces the exact live balances", async () => {
    const l1 = await PersistentLedger.open(dir);
    const s = await seed(l1);
    l1.close();
    const j = new Journal(dir);
    const { records } = j.open();
    const folded = fold(records);
    const byId = new Map([...folded.accounts.values()].map((a) => [a.id, a]));
    expect(byId.get(s.alice)!.balance).toBe(parseMicroCents("7.50"));
    expect(byId.get(s.bob)!.balance).toBe(parseMicroCents("2.50"));
    // the lazy reserve: −10.00 exactly once (a double-apply would show −20.00 —
    // the measured BOOT_DISAGREE bug this assertion now guards forever)
    const reserve = [...folded.accounts.values()].find((a) => a.ownerId === "system")!;
    expect(reserve.balance).toBe(-parseMicroCents("10.00"));
    expect(folded.transactions.length).toBe(2);
    expect(folded.entries.length).toBe(4);
  });
});

describe("Snapshot + full-fold cross-check", () => {
  test("snapshot boot agrees with full fold; corrupt snapshot is ignored (journal wins)", async () => {
    const l1 = await PersistentLedger.open(dir, { snapshotEvery: 1 });
    const s = await seed(l1);
    await l1.guardMint("t1", s.alice, parseMicroCents("0.10"), "snap trigger", "op", "snap-1");
    l1.close();
    expect(fs.existsSync(path.join(dir, "snapshot.json"))).toBe(true);

    // boot from the snapshot head; full verification must run AND agree
    const l2 = await PersistentLedger.open(dir);
    expect(l2.stats().fullFold).toBe(true);
    expect((await l2.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("7.60")); // 7.50 + 0.10
    l2.close();

    // corrupt the snapshot — boot IGNORES it and the journal alone reproduces state
    fs.writeFileSync(path.join(dir, "snapshot.json"), "{\"corrupt\":");
    const l3 = await PersistentLedger.open(dir);
    expect((await l3.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("7.60"));
    l3.close();
  });
});

describe("parseMicroCents — the float wall", () => {
  test("exact conversion; floats and garbage refused", () => {
    expect(parseMicroCents("1")).toBe(10000n);
    expect(parseMicroCents("1.2")).toBe(12000n);
    expect(parseMicroCents("1.23")).toBe(12300n);
    expect(parseMicroCents("1.2345")).toBe(12345n);
    expect(parseMicroCents("0.0001")).toBe(1n);
    expect(microCentsToString(12345n)).toBe("1.2345");
    expect(microCentsToString(1n)).toBe("0.0001");
    for (const bad of [1.23 as unknown as string, "1.23000", "-1.00", "1e3", "0x10", "", "abc", "1.23456"]) {
      expect(() => parseMicroCents(bad)).toThrow();
    }
  });
});

// ─── Self-healing: the data dir can vanish under a running process ──────────
// (sandbox resets deleted data/ mid-flight: snapshots ENOENT'd and journal
//  appends disappeared into a vanished inode. The ledger now heals honestly.)

describe("PersistentLedger — self-healing after mid-run deletion", () => {
  test("dir deleted under the running process: ops continue, restart restores full state, chain continues", async () => {
    const l1 = await PersistentLedger.open(dir);
    const s = await seed(l1); // 4 ops: create×2, mint, transfer
    const seqBefore = l1.stats().seq; // 4
    expect(seqBefore).toBe(4);

    fs.rmSync(dir, { recursive: true, force: true }); // the sandbox did exactly this

    // ops CONTINUE (in-memory truth), journal heals on the next append
    await l1.transfer("t1", s.alice, s.bob, parseMicroCents("1.00"), "post-heal pay", "operator", "post-heal-1");
    const midProof = await l1.proofOfSolvency("t1");
    l1.close();

    // reopen: meta-anchored journal + snapshot at the heal point → full state
    const l2 = await PersistentLedger.open(dir);
    expect(l2.stats().seq).toBe(5); // global seq continuity across the re-anchor
    expect((await l2.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("6.50"));
    expect((await l2.getAccount("t1", s.bob)).balance).toBe(parseMicroCents("3.50"));
    expect((await l2.proofOfSolvency("t1")).balanceHash).toBe(midProof.balanceHash);

    // the chain keeps growing past the re-anchor…
    await l2.transfer("t1", s.bob, s.alice, parseMicroCents("0.25"), "tail pay", "operator", "post-heal-2");
    l2.close();

    // …and a SECOND restart still boots (tail replay on the re-anchored chain)
    const l3 = await PersistentLedger.open(dir);
    expect(l3.stats().seq).toBe(6);
    expect((await l3.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("6.75"));
    expect((await l3.getAccount("t1", s.bob)).balance).toBe(parseMicroCents("3.25"));
    l3.close();
  });

  test("empty journal + valid snapshot boots anchored and keeps counting", async () => {
    const l1 = await PersistentLedger.open(dir, { snapshotEvery: 1 });
    const s = await seed(l1);
    const preHash = (await l1.proofOfSolvency("t1")).balanceHash;
    l1.close();

    fs.rmSync(path.join(dir, "journal.jsonl")); // only the journal vanished

    const l2 = await PersistentLedger.open(dir); // snapshot-anchored restart
    expect(l2.stats().seq).toBe(4); // state restored at the snapshot's global seq
    expect((await l2.proofOfSolvency("t1")).balanceHash).toBe(preHash);

    await l2.guardMint("t1", s.alice, parseMicroCents("1.00"), "anchored mint", "operator", "anchored-mint-1");
    expect(l2.stats().seq).toBe(5); // appends continue the global sequence
    l2.close();

    const l3 = await PersistentLedger.open(dir);
    expect(l3.stats().seq).toBe(5);
    expect((await l3.getAccount("t1", s.alice)).balance).toBe(parseMicroCents("8.50"));
    l3.close();
  });

  test("re-anchored journal without any snapshot refuses to boot (fail-closed)", async () => {
    const l1 = await PersistentLedger.open(dir);
    const s = await seed(l1);
    l1.close();

    // forge a re-anchored state manually: empty journal + meta, no snapshot
    fs.rmSync(path.join(dir, "journal.jsonl"));
    fs.rmSync(path.join(dir, "snapshot.json"), { force: true });
    fs.writeFileSync(path.join(dir, "journal.meta.json"), JSON.stringify({ baseSeq: 4, rebasedAt: new Date().toISOString() }));

    let refused = false;
    try {
      await PersistentLedger.open(dir);
    } catch (e) {
      refused = e instanceof JournalError && e.code === "BOOT_UNANCHORED";
    }
    expect(refused).toBe(true);
    void s;
  });
});
