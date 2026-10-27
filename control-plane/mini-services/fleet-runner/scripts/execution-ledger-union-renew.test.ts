/**
 * execution-ledger-union-renew.test.ts — the t64 union/renew spec.
 * Deterministic: injected clock, fixture docs, zero network. The erasureGuard
 * law is the spec: a renewal MERGES — replacement = erasure = failure here.
 */
import { describe, expect, test } from "bun:test";

import { laneIdentityArgs, renewLedger, rowKey, unionLedgers, type LedgerDoc } from "./execution-ledger-union-renew";

const GUARD = { law: "rows-are-APPEND-ONLY · history lives in git" };

function richBase(): LedgerDoc {
  return {
    schema: "SAOS-EXECUTION-LEDGER/1",
    at: "2026-10-26T15:51:47Z",
    generator: "prior-union",
    erasureGuard: GUARD,
    cycle30: { note: "cycle-30 history" },
    wave81: { rows: 4 },
    waveG77c: { custody: "G6" },
    done: [
      { id: "D29-1", title: "round-29 core row", detail: "never dies" },
      { id: "D33-b", title: "G77-b integrity", detail: "7/7 chain" },
      { id: "D33-c", title: "FixedFloat read-only", detail: "rail" },
    ],
    partial: [{ title: "partial-1" }],
    gaps: [
      { id: "GAP-1", title: "compute wall", detail: "covered-by-structure" },
      { id: "GAP-6", title: "custody wound saos-000X", detail: "keyless" },
    ],
    next: [{ title: "next-1", owner: "op" }],
  };
}

function sisterRoot(): LedgerDoc {
  return {
    schema: "SAOS-EXECUTION-LEDGER/1",
    at: "2026-10-26T15:47:28Z",
    erasureGuard: GUARD,
    done: [
      { id: "D29-1", title: "round-29 core row", detail: "never dies" },
      { title: "renew row only-root-has", detail: "d42 lineage" },
    ],
    gaps: [{ id: "GAP-1", title: "compute wall", detail: "covered-by-structure" }],
  };
}

function sisterMirror(): LedgerDoc {
  return {
    schema: "SAOS-EXECUTION-LEDGER/1",
    at: "2026-10-26T15:43:44Z",
    erasureGuard: GUARD,
    done: [{ id: "D29-1", title: "round-29 core row", detail: "never dies" }],
    gaps: [
      { id: "GAP-1", title: "compute wall", detail: "covered-by-structure" },
      { id: "GAP-9", title: "mirror-only wound", detail: "must survive" },
    ],
    cycle31: { note: "only-mirror-section" },
  };
}

describe("unionLedgers — the merge law", () => {
  test("richest doc wins as base and nothing from sisters is lost", () => {
    const { doc, report } = unionLedgers({ domain: richBase(), rootsite: sisterRoot(), mirror: sisterMirror() });
    expect(report.base).toBe("domain");
    expect(report.appendedFromSisters).toBe(2); // root renew row + mirror GAP-9
    const doneTitles = (doc.done as { title: string }[]).map((r) => r.title);
    expect(doneTitles).toContain("renew row only-root-has");
    const gapIds = (doc.gaps as { id?: string }[]).map((r) => r.id);
    expect(gapIds).toContain("GAP-9");
    expect(report.sectionsBroughtIn).toContain("mirror:cycle31");
    expect((doc.cycle31 as { note: string }).note).toBe("only-mirror-section");
  });

  test("guard and history sections ride the spread untouched", () => {
    const { doc } = unionLedgers({ domain: richBase(), rootsite: sisterRoot(), mirror: sisterMirror() });
    expect(doc.erasureGuard).toEqual(GUARD);
    expect(doc.cycle30).toEqual({ note: "cycle-30 history" });
    expect(doc.wave81).toEqual({ rows: 4 });
    expect(doc.waveG77c).toEqual({ custody: "G6" });
  });

  test("no duplicate rows — identity is id|title", () => {
    const { doc } = unionLedgers({ domain: richBase(), rootsite: sisterRoot(), mirror: sisterMirror() });
    const keys = (doc.done as { title: string }[]).map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
    const gkeys = (doc.gaps as { id?: string; title: string }[]).map(rowKey);
    expect(new Set(gkeys).size).toBe(gkeys.length);
  });

  test("picks the true richest base even when it is not domain", () => {
    const fatRoot = sisterRoot();
    fatRoot.done = [
      ...(fatRoot.done as object[]),
      { title: "extra-a" },
      { title: "extra-b" },
      { title: "extra-c" },
      { title: "extra-d" },
      { title: "extra-e" },
      { title: "extra-f" },
    ];
    const { report } = unionLedgers({ domain: richBase(), rootsite: fatRoot, mirror: sisterMirror() });
    expect(report.base).toBe("rootsite");
  });
});

describe("renewLedger — the lineage law", () => {
  test("refreshes identity keys and appends rows; prior rows survive verbatim", () => {
    const base = richBase();
    const before = JSON.stringify(base.done);
    const out = renewLedger(base, {
      at: "2026-10-27T12:40:00Z",
      generator: "test-renew",
      sourceWorklog: "t64 test",
      doneRows: [{ id: "D64-a", title: "renew measured", detail: "evidence" }],
      gapRows: [{ id: "G7", title: "organ-scoped absence", detail: "honest" }],
      measuredSnapshot: { refreshedAt: "2026-10-27T12:40:00Z" },
    });
    expect(out.at).toBe("2026-10-27T12:40:00Z");
    expect(out.generator).toBe("test-renew");
    // prior rows preserved in order
    const prior = (out.done as object[]).slice(0, 3);
    expect(JSON.stringify(prior)).toBe(before);
    expect((out.done as { id?: string }[]).some((r) => r.id === "D64-a")).toBe(true);
    expect((out.gaps as { id?: string }[]).some((r) => r.id === "G7")).toBe(true);
    // untouched arrays pass through
    expect(out.partial).toEqual([{ title: "partial-1" }]);
    expect(out.next).toEqual([{ title: "next-1", owner: "op" }]);
    // measuredSnapshot refreshed wholesale (refresh surface, not a row)
    expect((out.measuredSnapshot as { refreshedAt: string }).refreshedAt).toBe("2026-10-27T12:40:00Z");
    // freshness carries the renew stamp
    expect((out.freshness as { renewedAt?: string }).renewedAt).toBe("2026-10-27T12:40:00Z");
  });

  test("growth law: done rows capped at 60 keeping the TAIL (history lives in git)", () => {
    const base = richBase();
    base.done = Array.from({ length: 70 }, (_, i) => ({ title: `row-${i}` }));
    const out = renewLedger(base, {
      at: "t",
      generator: "g",
      sourceWorklog: "w",
      doneRows: [{ title: "new" }],
      gapRows: [],
      measuredSnapshot: {},
      cap: 60,
    });
    const done = out.done as { title: string }[];
    expect(done.length).toBe(61); // 60 tail + 1 appended
    expect(done[0].title).toBe("row-10"); // head trimmed
    expect(done[60].title).toBe("new");
  });

  test("guard object is never replaced by renew", () => {
    const base = richBase();
    const out = renewLedger(base, {
      at: "t",
      generator: "g",
      sourceWorklog: "w",
      doneRows: [],
      gapRows: [],
      measuredSnapshot: {},
    });
    expect(out.erasureGuard).toEqual(GUARD);
  });
});

describe("laneIdentityArgs — DECISIONS #10 identity law", () => {
  test("lawful default lane identity, env-overridable, per-commit -c injection", () => {
    const args = laneIdentityArgs({});
    expect(args).toContain("user.name=G78-e lane (execution-ledger renewer)");
    expect(args).toContain("user.email=g78-e@agents.roshpinacare-sys");
    const custom = laneIdentityArgs({ LANE_NAME: "X", LANE_EMAIL: "x@fleet.local" });
    expect(custom).toEqual(["-c", "user.name=X", "-c", "user.email=x@fleet.local"]);
    // the sandbox default class must never leak through
    expect(args.join(" ")).not.toContain("z@container");
  });
});
