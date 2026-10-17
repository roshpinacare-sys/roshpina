/**
 * kernel/market/economy.test.ts — the sovereign fiscal layer, proven.
 *
 * stake/unstake (agent-signed) + payroll/tax/rewards (operator-signed):
 *   1. conservation after EVERY op (the THE invariant)
 *   2. honest math: floor on tax levy, floor on pro-rata rewards, remainder stays in treasury
 *   3. fail-closed: insufficient stake/free/treasury refuses BEFORE any mutation
 *   4. epoch idempotency — live AND after a real reboot (paidKeys rebuilt from journal replay)
 *
 * כמו-תמיד: אפס-float, הכל BigInt μ¢.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketEngine } from "./engine";

const dir = mkdtempSync(join(tmpdir(), "econ-test-"));
let eng: MarketEngine;

const expectHolds = async () => {
  const c = await eng.conservation();
  if (!c.quote.holds) throw new Error(`quote conservation broken: ${JSON.stringify(c.quote)}`);
  if (!c.base.holds) throw new Error(`base conservation broken: ${JSON.stringify(c.base)}`);
};

beforeAll(async () => {
  eng = await MarketEngine.open(dir);
  await eng.allocate("alpha", "1000.0000", "0");
  await eng.allocate("bravo", "1000.0000", "0");
  await expectHolds();
});

afterAll(() => {
  eng?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("staking (agent-signed)", () => {
  test("stake moves free → staked and conserves", async () => {
    const r = await eng.stake("alpha", 4_000_000n, "s-1");
    expect(r.staked).toBe("4000000");
    const b = await eng.balances("alpha");
    expect(b.usdsAvailable).toBe("6000000");
    expect(b.usdsStaked).toBe("4000000");
    await expectHolds();
  });

  test("fail-closed: stake more than free refuses, nothing moves", async () => {
    const before = await eng.balances("alpha");
    await expect(eng.stake("alpha", 7_000_000n, "s-2")).rejects.toThrow(/insufficient free USDS/);
    const after = await eng.balances("alpha");
    expect(after).toEqual(before);
    await expectHolds();
  });

  test("fail-closed: unknown agent refuses", () => {
    expect(eng.stake("ghost", 1n, "s-3")).rejects.toThrow(/unknown agent/);
  });

  test("unstake returns committed funds and conserves", async () => {
    const r = await eng.unstake("alpha", 1_500_000n, "u-1");
    expect(r.staked).toBe("2500000");
    const b = await eng.balances("alpha");
    expect(b.usdsAvailable).toBe("7500000");
    expect(b.usdsStaked).toBe("2500000");
    await expectHolds();
  });

  test("fail-closed: unstake more than staked refuses", async () => {
    await expect(eng.unstake("alpha", 3_000_000n, "u-2")).rejects.toThrow(/insufficient staked USDS/);
    await expectHolds();
  });
});

describe("tax (operator-signed)", () => {
  test("levy = floor(free × rateBps/10000) per agent, treasury collects, conserves", async () => {
    const r = await eng.tax("t1", 100n); // 1%
    expect(r.taxed).toBe(2);
    expect(r.collected).toBe("175000"); // alpha 75,000 + bravo 100,000 (μ¢)
    const t = await eng.treasury();
    expect(t.usds).toBe("175000");
    await expectHolds();
  });

  test("same epoch is idempotent — no double taxation", async () => {
    const r = await eng.tax("t1", 100n);
    expect(r.taxed).toBe(0);
    expect(r.collected).toBe("0");
    const t = await eng.treasury();
    expect(t.usds).toBe("175000");
  });

  test("new epoch taxes again (epoch separation)", async () => {
    const r = await eng.tax("t2", 50n);
    expect(r.taxed).toBe(2);
    expect(r.collected).toBe("86625"); // alpha 37,125 + bravo 49,500 — floor on post-t1 balances
    const t = await eng.treasury();
    expect(t.usds).toBe("261625");
    await expectHolds();
  });
});

describe("payroll (operator-signed)", () => {
  test("fail-closed: treasury cannot cover → NOTHING is paid", async () => {
    const balA = await eng.balances("alpha");
    const balB = await eng.balances("bravo");
    await expect(eng.payroll("p1", 5_000_000n)).rejects.toThrow(/treasury cannot cover payroll/);
    expect(await eng.balances("alpha")).toEqual(balA);
    expect(await eng.balances("bravo")).toEqual(balB);
    const t = await eng.treasury();
    expect(t.usds).toBe("261625");
    await expectHolds();
  });

  test("affordable payroll pays every registered agent exactly once", async () => {
    const r = await eng.payroll("p1", 100_000n);
    expect(r.paid).toBe(2);
    expect(r.total).toBe("200000");
    expect(r.skipped).toBe(0);
    const t = await eng.treasury();
    expect(t.usds).toBe("61625"); // 261,625 − 2×100,000
    const a = await eng.balances("alpha");
    expect(a.usdsAvailable).toBe("7487875"); // 7,387,500 + 100,000
    await expectHolds();
  });

  test("same epoch payroll is idempotent", async () => {
    const r = await eng.payroll("p1", 100_000n);
    expect(r.paid).toBe(0);
    const t = await eng.treasury();
    expect(t.usds).toBe("61625");
  });
});

describe("staking rewards (operator-signed)", () => {
  test("pro-rata by stake: floor shares, remainder stays in treasury, conserves", async () => {
    await eng.stake("bravo", 4_000_000n, "s-b1"); // stakes: bravo 4M + alpha 2.5M = 6.5M
    const r = await eng.rewards("r1", 10000n); // 100% of treasury as budget
    expect(r.budget).toBe("61625");
    expect(r.stakers).toBe(2);
    // budget×stake/total: alpha 61,625×2.5/6.5=23,701.92→23,701 · bravo 37,923.07→37,923
    expect(r.distributed).toBe("61624");
    expect(r.remainder).toBe("1");
    const t = await eng.treasury();
    expect(t.usds).toBe("1"); // 61,625 − 61,624 — honest dust, kept
    await expectHolds();
  });

  test("same epoch rewards are idempotent", async () => {
    const r = await eng.rewards("r1", 10000n);
    expect(r.distributed).toBe("0");
    const t = await eng.treasury();
    expect(t.usds).toBe("1");
  });

  test("no stakers → honest zero", async () => {
    const e2 = await MarketEngine.open(join(dir, "fresh")); // hmm — separate dir boots its own empty economy
    try {
      const r = await e2.rewards("r9", 10000n);
      expect(r.stakers).toBe(0);
      expect(r.distributed).toBe("0");
    } finally {
      e2.close();
      rmSync(join(dir, "fresh"), { recursive: true, force: true });
    }
  });
});

describe("reboot — the economy survives a real restart", () => {
  test("reopen: balances, stakes, idempotency keys and audit trail all restored", async () => {
    const before = {
      a: await eng.balances("alpha"),
      b: await eng.balances("bravo"),
      treasury: (await eng.treasury()).usds,
      settled: eng.stats().settled,
      ops: eng.epochReport(1000).length,
    };
    eng.close();
    eng = await MarketEngine.open(dir);

    expect(await eng.balances("alpha")).toEqual(before.a);
    expect(await eng.balances("bravo")).toEqual(before.b);
    expect((await eng.treasury()).usds).toBe(before.treasury);
    expect(eng.stats().settled).toBe(before.settled);

    // epoch idempotency survives reboot (paidKeys rebuilt from journal replay)
    const pay = await eng.payroll("p1", 100_000n);
    expect(pay.paid).toBe(0);
    const tax = await eng.tax("t1", 100n);
    expect(tax.taxed).toBe(0);
    const rew = await eng.rewards("r1", 10000n);
    expect(rew.distributed).toBe("0");

    // audit trail rebuilt
    const ops = eng.epochReport(1000);
    expect(ops.length).toBe(before.ops);
    const kinds = new Set(ops.map((o) => o.kind));
    for (const k of ["stake", "unstake", "tax", "payroll", "reward"]) expect(kinds.has(k as never)).toBe(true);

    await expectHolds();
  });
});
