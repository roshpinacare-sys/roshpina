/**
 * architect.test.ts — TDD RED (written before implementation, §5 חוק-ה-TDD)
 * מנהל-הארכיטקטורה הריבוני — מבחני-קבלה מלאים. אפס-רשת, אפס-שעון-אמיתי
 * (שעון-מוזרק), אפס-RNG. כל-עץ-קבצים ב-fixture זמני. fail-closed בכל-נתיב.
 */
import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseEvidence,
  rankContracts,
  selectContract,
  type TsContract,
} from "../executive.ts";
import {
  CURE_REGISTRY,
  capitalLiquidityCure,
  steemFeedNullableCure,
  bunTestReferenceCure,
  swallowGuardCliReadonlyCure,
  trunkUnitBoundaryCure,
  applyCure,
  revertToSnapshot,
} from "../registry.ts";
import { ReceiptChain, verifyReceipts } from "../receipts.ts";
import { acquireLock, releaseLock, type LockHandle } from "../lock.ts";

let tmps: string[] = [];
function tmpTree(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "arch-daemon-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  tmps = [];
});

/* ── 1. evidence parsing: tsc output → deterministic contracts ───────────── */
describe("parseEvidence", () => {
  const TSC_OUT = [
    "src/lib/giant/capital.ts(685,7): error TS2322: Type '\"LOW\"' is not assignable to type '\"FULL\" | \"HIGH\" | \"MEDIUM\" | \"LOCKED-7D\" | \"NONE\"'.",
    "src/lib/steem-feed.ts(190,3): error TS2322: Type 'null' is not assignable to type 'SteemMarketSnapshot'.",
    "src/lib/sovereign/swallow-guard.test.ts(11,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.",
    "",
    "Found 3 errors.",
  ].join("\n");

  test("parses file/line/code/message deterministically", () => {
    const cs = parseEvidence(TSC_OUT);
    expect(cs.length).toBe(3);
    expect(cs[0]).toEqual({
      file: "src/lib/giant/capital.ts",
      line: 685,
      col: 7,
      code: "TS2322",
      message: expect.any(String),
    } satisfies TsContract);
    expect(cs[0].message).toContain('"LOW"');
  });

  test("fail-closed on malformed lines (skips noise, keeps truth)", () => {
    const cs = parseEvidence("garbage line\n\nFound 0 errors.\nsrc/a.ts(1,1): error TS9999: boom");
    expect(cs.length).toBe(1);
    expect(cs[0].code).toBe("TS9999");
  });

  test("empty evidence → empty contracts (honest)", () => {
    expect(parseEvidence("")).toEqual([]);
  });
});

/* ── 2. ranking + selection ──────────────────────────────────────────────── */
describe("rankContracts / selectContract", () => {
  test("rank is deterministic and stable across runs", () => {
    const cs: TsContract[] = [
      { file: "src/a.ts", line: 1, col: 1, code: "TS2307", message: "Cannot find module 'bun:test'" },
      { file: "src/b.ts", line: 2, col: 1, code: "TS2322", message: "Type 'null' is not assignable to type 'SteemMarketSnapshot'." },
      { file: "src/c.ts", line: 3, col: 1, code: "TS2322", message: "Type '\"LOW\"' is not assignable" },
    ];
    const r1 = rankContracts(cs, CURE_REGISTRY);
    const r2 = rankContracts(cs, CURE_REGISTRY);
    expect(r1).toEqual(r2);
  });

  test("select: curable contract wins; non-curable skipped with reason", () => {
    const curable: TsContract = { file: "src/lib/giant/capital.ts", line: 685, col: 7, code: "TS2322", message: "Type '\"LOW\"' is not assignable to type '\"FULL\" | \"HIGH\" | \"MEDIUM\" | \"LOCKED-7D\" | \"NONE\"'." };
    const strangers: TsContract = { file: "src/unknown/lane.ts", line: 1, col: 1, code: "TS2322", message: "Type 'x' is not assignable to type 'y'." };
    const sel = selectContract([strangers, curable], CURE_REGISTRY);
    expect(sel).not.toBeNull();
    expect(sel!.contract.file).toBe("src/lib/giant/capital.ts");
    expect(sel!.cureId).toBe("capital-liquidity-band");
    expect(selectContract([strangers], CURE_REGISTRY)).toBeNull();
  });
});

/* ── 3. deterministic cures on fixture trees ─────────────────────────────── */
describe("cures", () => {
  const TYPES_FILE = `export interface StrategyRow {
  id: string;
  liquidity: "FULL" | "HIGH" | "MEDIUM" | "LOCKED-7D" | "NONE";
  risk: "LOW" | "MEDIUM" | "HIGH";
}
`;
  const VIEW_FILE = `const LIQ_HE: Record<StrategyRow["liquidity"], string> = {
  FULL: "מלאה",
  HIGH: "גבוהה",
  MEDIUM: "בינונית",
  "LOCKED-7D": "נעולה-7-ימים",
  NONE: "אין",
};
`;
  const FEED_FILE = `import { cached } from "./cache";
export async function steemMarketSnapshot(): Promise<SteemMarketSnapshot> {
  return cached("steem:snapshot", 20000, async () => {
    return null;
  });
}
`;
  const TEST_FILE = `import { describe, test, expect } from "bun:test";
import { detectSwallows } from "./swallow-guard";
test("t", () => { expect(detectSwallows).toBeDefined(); });
`;

  test("capitalLiquidityCure: union gains LOW AND CapitalView record gains the LOW label (compound, rest byte-preserved)", () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "src/lib/giant"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/components/giant"), { recursive: true });
    const p = path.join(root, "src/lib/giant/capital-types.ts");
    fs.writeFileSync(p, TYPES_FILE);
    const viewPath = path.join(root, "src/components/giant/CapitalView.tsx");
    fs.writeFileSync(viewPath, VIEW_FILE);
    const plan = capitalLiquidityCure(root, {
      file: "src/lib/giant/capital.ts", line: 685, col: 7, code: "TS2322",
      message: "Type '\"LOW\"' is not assignable to type '\"FULL\" | \"HIGH\" | \"MEDIUM\" | \"LOCKED-7D\" | \"NONE\"'.",
    });
    expect(plan.files).toEqual(["src/lib/giant/capital-types.ts", "src/components/giant/CapitalView.tsx"]);
    plan.apply(root);
    const out = fs.readFileSync(p, "utf8");
    expect(out).toContain('"LOCKED-7D" | "NONE" | "LOW"');
    expect(out.startsWith('export interface StrategyRow')).toBe(true);
    const view = fs.readFileSync(viewPath, "utf8");
    expect(view).toContain('LOW: "נמוכה"');
    expect(view).toContain('FULL: "מלאה"');
    plan.apply(root); // idempotent — no duplicate LOW entry
    expect(fs.readFileSync(viewPath, "utf8")).toBe(view);
  });

  test("steemFeedNullableCure: COMPOUND — signature + genesis guard + sbdMark + market-route oracle honesty", () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/app/api/giant/dex"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/app/api/dex/steem/market"), { recursive: true });
    const p = path.join(root, "src/lib/steem-feed.ts");
    fs.writeFileSync(p, FEED_FILE);
    const bridgePath = path.join(root, "src/lib/steem-bridge.ts");
    fs.writeFileSync(bridgePath, `const snap = await steemMarketSnapshot();
if (!snap.oracle.fresh || snap.oracle.steemUsds === null || snap.oracle.sbdUsds === null) { return; }
const note = snap.usd.source;
`);
    const dexPath = path.join(root, "src/app/api/giant/dex/route.ts");
    fs.writeFileSync(dexPath, `const snap = await steemMarketSnapshot();
if (snap.oracle.sbdUsds !== null) sbdMark = snap.oracle.sbdUsds;
`);
    const mktPath = path.join(root, "src/app/api/dex/steem/market/route.ts");
    fs.writeFileSync(mktPath, `const targetBy = new Map([
  ["STEEM", snap.oracle.steemUsds],
  ["SBD", snap.oracle.sbdUsds],
]);
return NextResponse.json({
  ok: true,
  snapshot: snap,
  pools,
});
`);
    const plan = steemFeedNullableCure(root, {
      file: "src/lib/steem-feed.ts", line: 190, col: 3, code: "TS2322",
      message: "Type 'null' is not assignable to type 'SteemMarketSnapshot'.",
    });
    expect(plan.files).toEqual(["src/lib/steem-feed.ts", "src/lib/steem-bridge.ts", "src/app/api/giant/dex/route.ts", "src/app/api/dex/steem/market/route.ts"]);
    plan.apply(root);
    expect(fs.readFileSync(p, "utf8")).toContain("Promise<SteemMarketSnapshot | null>");
    expect(fs.readFileSync(bridgePath, "utf8")).toContain("if (!snap || !snap.oracle.fresh");
    expect(fs.readFileSync(dexPath, "utf8")).toContain("if (snap && snap.oracle.sbdUsds !== null)");
    const mkt = fs.readFileSync(mktPath, "utf8");
    expect(mkt).toContain('snap?.oracle.steemUsds ?? null');
    expect(mkt).toContain('snapshot: snap ?? null');
    plan.apply(root); // idempotent — byte-stable on second apply
    expect(fs.readFileSync(bridgePath, "utf8")).toContain("if (!snap || !snap.oracle.fresh");
  });

  test("swallowGuardCliReadonlyCure: destructure type matches library truth (readonly)", () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    const p = path.join(root, "scripts/swallow-guard-cli.ts");
    fs.writeFileSync(p, `const { swallows, alerts }: { swallows: Swallow[]; alerts: ContentAlert[] } = detectSwallows(input.tree, input.baseline);
if (swallows.length > 0) {}
`);
    const plan = swallowGuardCliReadonlyCure(root, {
      file: "scripts/swallow-guard-cli.ts", line: 65, col: 9, code: "TS2322",
      message: "Type '{ swallows: readonly Swallow[]; alerts: readonly ContentAlert[]; }' is not assignable",
    });
    plan.apply(root);
    const out = fs.readFileSync(p, "utf8");
    expect(out).toContain("{ swallows: readonly Swallow[]; alerts: readonly ContentAlert[] }");
    plan.apply(root); // idempotent
    expect(fs.readFileSync(p, "utf8")).toBe(out);
  });

  test("bunTestReferenceCure: reference line prepended, idempotent", () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "src/lib/sovereign"), { recursive: true });
    const p = path.join(root, "src/lib/sovereign/swallow-guard.test.ts");
    fs.writeFileSync(p, TEST_FILE);
    const plan = bunTestReferenceCure(root, {
      file: "src/lib/sovereign/swallow-guard.test.ts", line: 11, col: 40, code: "TS2307",
      message: "Cannot find module 'bun:test' or its corresponding type declarations.",
    });
    plan.apply(root);
    const once = fs.readFileSync(p, "utf8");
    expect(once.startsWith('/// <reference types="bun-types" />')).toBe(true);
    plan.apply(root);
    expect(fs.readFileSync(p, "utf8")).toBe(once); // idempotent — no double-line
  });

  test("applyCure + revertToSnapshot: byte-identical rollback on verify-fail", () => {
    const root = tmpTree();
    fs.mkdirSync(path.join(root, "src/lib/giant"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/components/giant"), { recursive: true });
    const p = path.join(root, "src/lib/giant/capital-types.ts");
    fs.writeFileSync(p, TYPES_FILE);
    fs.writeFileSync(path.join(root, "src/components/giant/CapitalView.tsx"), VIEW_FILE);
    const contract: TsContract = {
      file: "src/lib/giant/capital.ts", line: 685, col: 7, code: "TS2322",
      message: "Type '\"LOW\"' is not assignable to type '\"FULL\" | \"HIGH\" | \"MEDIUM\" | \"LOCKED-7D\" | \"NONE\"'.",
    };
    const sel = selectContract([contract], CURE_REGISTRY)!;
    const snap = applyCure(root, sel);
    expect(snap.selections.length).toBe(2);
    revertToSnapshot(root, snap);
    expect(fs.readFileSync(p, "utf8")).toBe(TYPES_FILE);
  });

  test("registry keyed by signature, not by line number (resilient to drift)", () => {
    const shifted: TsContract = {
      file: "src/lib/giant/capital.ts", line: 999, col: 7, code: "TS2322",
      message: "Type '\"LOW\"' is not assignable to type '\"FULL\" | \"HIGH\" | \"MEDIUM\" | \"LOCKED-7D\" | \"NONE\"'.",
    };
    expect(selectContract([shifted], CURE_REGISTRY)).not.toBeNull();
  });

  test("trunkUnitBoundaryCure: adopted exclude restored, rest byte-preserved", () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, exclude: ["node_modules"] }, null, 2));
    const plan = trunkUnitBoundaryCure(root, { file: "tsconfig.json", line: 0, col: 0, code: "TS0000", message: "unit-boundary rewind detected" });
    plan.apply(root);
    const out = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    expect(out.exclude).toEqual(["node_modules", "mini-services", "examples"]);
    expect(out.compilerOptions.strict).toBe(true);
    plan.apply(root); // idempotent
    expect(JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).exclude).toEqual(["node_modules", "mini-services", "examples"]);
  });

  test("trunkUnitBoundaryCure refuses when exclude already adopted (no-op) and when drifted unrecognizably", () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {}, exclude: ["node_modules", "mini-services", "examples"] }));
    expect(() => trunkUnitBoundaryCure(root, { file: "tsconfig.json", line: 0, col: 0, code: "TS0000", message: "x" }).apply(root)).not.toThrow(); // idempotent silent
    const root2 = tmpTree();
    fs.writeFileSync(path.join(root2, "tsconfig.json"), "{ not json !!");
    expect(() => trunkUnitBoundaryCure(root2, { file: "tsconfig.json", line: 0, col: 0, code: "TS0000", message: "x" }).apply(root2)).toThrow();
  });
});

/* ── 4. receipts: hash chain, tamper-evidence ────────────────────────────── */
describe("receipts", () => {
  test("chain grows, prevHash links, verify passes", () => {
    const ch = new ReceiptChain();
    const r1 = ch.append({ kind: "cycle-start", at: "t1" });
    const r2 = ch.append({ kind: "cure-applied", at: "t2" });
    expect(r2.prevHash).toBe(r1.hash);
    expect(verifyReceipts(ch.all()).ok).toBe(true);
  });

  test("tamper at exact index detected; splice/reorder detected", () => {
    const ch = new ReceiptChain();
    ch.append({ kind: "a", at: "t1" });
    ch.append({ kind: "b", at: "t2" });
    const tampered = JSON.parse(JSON.stringify(ch.all()));
    tampered[1].body.kind = "FORGED";
    expect(verifyReceipts(tampered).ok).toBe(false);
    expect(verifyReceipts(tampered).index).toBe(1);
    const spliced = ch.all().slice(1);
    expect(verifyReceipts(spliced).ok).toBe(false);
  });

  test("canonical JSON: key order never changes the hash", () => {
    const ch = new ReceiptChain();
    const a = ch.append({ b: 1, a: 2 });
    const ch2 = new ReceiptChain();
    const b = ch2.append({ a: 2, b: 1 });
    expect(a.hash).toBe(b.hash);
  });
});

/* ── 5. single-flight lock ───────────────────────────────────────────────── */
describe("lock", () => {
  test("second acquire refused while held; release frees", () => {
    const dir = tmpTree();
    const l1: LockHandle = acquireLock(path.join(dir, "cycle.lock"), 1);
    expect(() => acquireLock(path.join(dir, "cycle.lock"), 2)).toThrow();
    releaseLock(l1);
    const l2 = acquireLock(path.join(dir, "cycle.lock"), 2);
    expect(l2.pid).toBe(2);
    releaseLock(l2);
  });

  test("stale lock broken honestly (recorded, not silent)", () => {
    const dir = tmpTree();
    const lockPath = path.join(dir, "cycle.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 60 * 60 * 1000 }));
    const l = acquireLock(lockPath, 9, () => Date.now() - 10 * 60 * 1000);
    expect(l.staleBroken).toBe(true);
    releaseLock(l);
  });
});
