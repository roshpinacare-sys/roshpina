/**
 * kernel/market/resilience.test.ts — the 2026-10-18 reboot bugs, proven fixed.
 *
 * שלושה-ווקטורי-רגרסיה על הבאגים-החיים שנתפסו באתחול-הסנדבוקס של 06:06:
 *   1. boot ghosting — גיבוי-קרוע (torn tar) החזיר הזמנות שה-escrow שלהן כבר
 *      נסחט לאוצר: ה-boot חייב להתכנס (locks == escrow) בכנות — רוח-רפאים
 *      מתועדת-יומן, לא-זיוף ולא-degradation תקוע.
 *   2. realloc — הצפת-בצורת SAOS (האספקה כולה נמחקה עם ה-reboot → אפס-asks
 *      → אפס-עסקאות → economy-run INCONCLUSIVE לנצח): הקצאה-מחדש חתומה,
 *      מתועדת, idempotent לפי-ref.
 *   3. quiesce — השעיית-מוטציות לגיבוי-חסר-קרעים: fail-closed בזמן-גיבוי,
 *      חזרה-לחיים מיידית אחריו.
 *
 * כמו-תמיד: אפס-float, הכל BigInt μ¢, שימור-החוק בכל-צעד.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketEngine } from "./engine";
import type { PersistentLedger } from "../ledger/persistent-ledger";

const dir = mkdtempSync(join(tmpdir(), "resil-test-"));
let eng: MarketEngine;

const expectHolds = async () => {
  const c = await eng.conservation();
  if (!c.quote.holds) throw new Error(`quote conservation broken: ${JSON.stringify(c.quote)}`);
  if (!c.base.holds) throw new Error(`base conservation broken: ${JSON.stringify(c.base)}`);
};

beforeAll(async () => {
  eng = await MarketEngine.open(dir);
});

afterAll(() => {
  eng?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("realloc — era-accident liquidity restoration (the SAOS drought bug)", () => {
  test("genesis allocation without SAOS → realloc restores supply honestly", async () => {
    await eng.allocate("alpha", "1000.0000", "0"); // the drought era: USDS only
    let b = await eng.balances("alpha");
    expect(b.saosAvailable).toBe("0");

    const r = await eng.realloc("alpha", "0", "50000000", "restore-20261018");
    expect(r.saosIdem).toBe("alloc:alpha:saos:restore-20261018");
    b = await eng.balances("alpha");
    expect(b.saosAvailable).toBe("50000000");
    await expectHolds();
  });

  test("idempotent per ref — the same ref never double-mints", async () => {
    await eng.realloc("alpha", "0", "50000000", "restore-20261018"); // same ref
    const b = await eng.balances("alpha");
    expect(b.saosAvailable).toBe("50000000"); // unchanged — the decision was already applied
    await expectHolds();
  });

  test("a new ref is a new signed decision — mints again (audited)", async () => {
    await eng.realloc("alpha", "0", "25000000", "restore-20261019");
    const b = await eng.balances("alpha");
    expect(b.saosAvailable).toBe("75000000");
    await expectHolds();
  });

  test("fail-closed: bad ref refuses", async () => {
    await expect(eng.realloc("alpha", "0", "1", "bad ref with spaces")).rejects.toThrow(/ref must match/);
  });
});

describe("quiesce — the tear-free backup gate", () => {
  test("while quiesced every money mutation refuses MARKET_QUIESCED", async () => {
    eng.quiesce(true);
    expect(eng.isQuiesced()).toBe(true);
    await expect(
      eng.placeOrder({ agentId: "alpha", orderId: "q-1", side: "bid", price: 1000000n, amount: 10n }),
    ).rejects.toThrow(/quiesced/);
    await expect(eng.stake("alpha", 1n, "q-2")).rejects.toThrow(/quiesced/);
    await expect(eng.realloc("alpha", "0", "1", "q-3")).rejects.toThrow(/quiesced/);
    await expectHolds();
  });

  test("resume — the market is live again, nothing was mutated during quiesce", async () => {
    eng.quiesce(false);
    const res = await eng.placeOrder({ agentId: "alpha", orderId: "q-4", side: "bid", price: 1000000n, amount: 5n });
    expect(res.fills.length).toBe(0); // no opposite side — rests honestly
    const book = eng.stats().book;
    expect(book.bids).toBe(1);
    await eng.cancelOrder("alpha", "q-4"); // leave the book clean for the ghost test
    await expectHolds();
  });
});

describe("boot ghosting — torn-backup convergence (the -22,798,930 µ¢ bug)", () => {
  test("orders whose escrow backing vanished are ghosted at boot; book converges with escrow", async () => {
    // era A: two funded resting bids (old b-old, new b-new), escrow fully backs both
    await eng.placeOrder({ agentId: "alpha", orderId: "b-old", side: "bid", price: 1000000n, amount: 10n });
    await eng.placeOrder({ agentId: "alpha", orderId: "b-new", side: "bid", price: 1000000n, amount: 10n });
    let st = eng.stats().book;
    expect(st.bids).toBe(2);

    // the torn backup: the escrow loses its backing for ONE order (the ledger
    // was restored from a snapshot that predates the second deposit)
    const internals = eng as unknown as {
      quote: PersistentLedger;
      escrowQuoteId: string;
      treasuryQuoteId: string;
    };
    const escrowBefore = BigInt((await internals.quote.getAccount("sovereign", internals.escrowQuoteId)).balance);
    await internals.quote.transfer(
      "sovereign", internals.escrowQuoteId, internals.treasuryQuoteId,
      10n, // exactly one order's lock (10 × 1_000_000 / 1_000_000 = 10 µ¢)
      "simulated torn-backup escrow loss", "test", `torn-sim:${Date.now()}`,
    );
    const escrowAfter = BigInt((await internals.quote.getAccount("sovereign", internals.escrowQuoteId)).balance);
    expect(escrowAfter).toBe(escrowBefore - 10n);

    // reboot on the same state dir — the boot must CONVERGE, not stay degraded
    eng.close();
    eng = await MarketEngine.open(dir);

    expect(eng.escrowOrphanQuote).toBe(0n); // no lingering negative orphan
    expect(eng.ghostsBoot.quote.count).toBe(1); // exactly the unbacked order ghosted
    expect(eng.ghostsBoot.quote.amount).toBe(10n);
    st = eng.stats().book;
    expect(st.bids).toBe(1); // the backed (older) order survived, the newest ghosted
    await expectHolds(); // conservation is still the law
  });

  test("the ghost decision is journaled — a second reboot does NOT re-ghost or resurrect", async () => {
    eng.close();
    eng = await MarketEngine.open(dir);
    expect(eng.ghostsBoot.quote.count).toBe(0); // converged state is stable
    expect(eng.stats().book.bids).toBe(1); // the honest survivor remains
    await expectHolds();
  });
});
