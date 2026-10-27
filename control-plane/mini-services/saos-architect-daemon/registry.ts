/* ═══ saos-architect-daemon · registry.ts — deterministic cure plans ════════
 * Each cure restores ADOPTED truth (landed receipts of prior waves) or applies
 * a minimal additive semantic fix. Cures are pure file transforms: snapshot →
 * apply → verify → (revert byte-identical on any verify failure). Registered
 * at wave 19.84 (trace 1a16ecab0c7c5bad):
 *
 *  C1 capital-liquidity-band — capital-types.ts liquidity union omits "LOW"
 *     while the FLEET strategy genuinely IS low-liquidity (parallel books).
 *     The type lied by omission; additive union extension.
 *  C2 steem-feed-nullable-truth — restores agent-9's adopted signature
 *     `Promise<SteemMarketSnapshot | null>` (receipt: trunk-type-truth,
 *     wave 19.82) when the ours-merge wipe class rewinds it. The file's own
 *     law: "אם-הזנה-נופלת — null כנה" (if the feed falls — null, honestly).
 *  C3 buntest-file-reference — a test file under src/** importing "bun:test"
 *     fails root-tsc because ambient bun types are not in the root sweep.
 *     File-scoped triple-slash reference (1 additive line), idempotent.
 */
import fs from "node:fs";
import path from "node:path";

import { Cure, CurePlan, Selection, TsContract } from "./executive.ts";

export interface Snapshot {
  selections: { file: string; before: string }[];
}

export function applyCure(root: string, sel: Selection): Snapshot {
  const plan = sel.cure.build(root, sel.contract);
  const snap: Snapshot = {
    selections: plan.files.map((f) => ({
      file: f,
      before: fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "",
    })),
  };
  plan.apply(root);
  return snap;
}

export function revertToSnapshot(root: string, snap: Snapshot): void {
  for (const s of snap.selections) {
    fs.writeFileSync(path.join(root, s.file), s.before);
  }
}

/* ── C0: trunk unit-boundary — adopted tsconfig exclude restored ───────────
 * agent-9 wave 19.82 adopted: exclude += mini-services, examples (standalone
 * units carry their own tsconfigs; the root sweep sweeping them is the 594-
 * error artifact class). The ours-merge wipe class rewinds it periodically —
 * this cure IS the antibody: re-apply adopted truth, byte-preserving the rest.
 */
export function trunkUnitBoundaryCure(root: string, _c: TsContract): CurePlan {
  return {
    files: ["tsconfig.json"],
    describe: "tsconfig.json exclude restored to adopted truth ['node_modules','mini-services','examples'] — standalone build units carry their own tsconfigs (agent-9 wave 19.82 adopted truth, rewound by the ours-merge wipe class)",
    apply(root: string) {
      const p = path.join(root, "tsconfig.json");
      const raw = fs.readFileSync(p, "utf8");
      let doc: { exclude?: string[]; [k: string]: unknown };
      try {
        doc = JSON.parse(raw);
      } catch {
        throw new Error("trunk-unit-boundary: tsconfig.json unparseable — refusing blind edit");
      }
      const adopted = ["node_modules", "mini-services", "examples"];
      if (JSON.stringify(doc.exclude ?? []) === JSON.stringify(adopted)) return; // already cured
      doc.exclude = adopted;
      fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
    },
  };
}

/* ── C1: capital liquidity union gains "LOW" (COMPOUND cure) ───────────────
 * Measured truth (wave 19.84 live cycle): widening the union alone exposes the
 * downstream exhaustive Record in CapitalView.tsx (LIQ_HE) → verify-fail
 * 3→3 (the gate did its job). The honest cure is compound: union += "LOW" AND
 * the LIQ_HE label map gains LOW: "נמוכה". Both idempotent.
 */
export function capitalLiquidityCure(root: string, _c: TsContract): CurePlan {
  return {
    files: ["src/lib/giant/capital-types.ts", "src/components/giant/CapitalView.tsx"],
    describe: 'capital-types.ts liquidity union += "LOW" + CapitalView.tsx LIQ_HE += LOW:"נמוכה" — the FLEET strategy is genuinely low-liquidity (parallel books); the type lied by omission (issue-contract #5, agent-9 reservation)',
    apply(root: string) {
      const tp = path.join(root, "src/lib/giant/capital-types.ts");
      const src = fs.readFileSync(tp, "utf8");
      const anchor = 'liquidity: "FULL" | "HIGH" | "MEDIUM" | "LOCKED-7D" | "NONE"';
      if (!src.includes(anchor)) {
        if (src.includes('"LOCKED-7D" | "NONE" | "LOW"')) {
          /* union already cured — compound: still ensure the view record */
        } else {
          throw new Error(`capital-liquidity-band: anchor not found — union drifted, refusing blind edit`);
        }
      } else {
        fs.writeFileSync(tp, src.replace(anchor, 'liquidity: "FULL" | "HIGH" | "MEDIUM" | "LOCKED-7D" | "NONE" | "LOW"'));
      }
      const vp = path.join(root, "src/components/giant/CapitalView.tsx");
      const view = fs.readFileSync(vp, "utf8");
      if (!view.includes('LOW: "נמוכה"')) {
        const vAnchor = '  "LOCKED-7D": "נעולה-7-ימים",';
        if (!view.includes(vAnchor)) {
          throw new Error("capital-liquidity-band: LIQ_HE anchor not found — view drifted, refusing blind edit");
        }
        fs.writeFileSync(vp, view.replace(vAnchor, `${vAnchor}\n  LOW: "נמוכה",`));
      }
    },
  };
}

/* ── C2: steem-feed signature truth — COMPOUND adopted-truth restore ───────
 * agent-9 wave 19.82 adopted: signature `| null` + honest null arms at every
 * caller (genesis guard steem-bridge, sbdMark guard giant/dex, oracle-honesty
 * market route). The ours-merge wipe class rewound ALL of it (measured live:
 * widening the signature alone exposes 8 un-armed sites → verify-fail 2→11,
 * the gate did its job). This compound cure re-applies the full adopted set,
 * each edit anchored + idempotent; drift → refuse (never blind edit).
 */
export function steemFeedNullableCure(root: string, _c: TsContract): CurePlan {
  const files = [
    "src/lib/steem-feed.ts",
    "src/lib/steem-bridge.ts",
    "src/app/api/giant/dex/route.ts",
    "src/app/api/dex/steem/market/route.ts",
  ];
  const replaceAnchored = (file: string, from: string, to: string, tolerateMissingAsCured: string | null): void => {
    const p = path.join(root, file);
    const src = fs.readFileSync(p, "utf8");
    if (src.includes(to)) return; // already cured (idempotent)
    if (!src.includes(from)) {
      if (tolerateMissingAsCured !== null && src.includes(tolerateMissingAsCured)) return;
      throw new Error(`steem-feed-nullable-truth: anchor not found in ${file} — file drifted, refusing blind edit`);
    }
    fs.writeFileSync(p, src.replace(from, to));
  };
  return {
    files,
    describe: "steem-feed honest-nullable adopted truth restored (agent-9 wave 19.82): signature |null + genesis guard !snap || + sbdMark snap && + market-route oracle honesty (snap?.oracle ?? null, snapshot: snap ?? null)",
    apply(root: string) {
      replaceAnchored(
        files[0],
        "export async function steemMarketSnapshot(): Promise<SteemMarketSnapshot> {",
        "export async function steemMarketSnapshot(): Promise<SteemMarketSnapshot | null> {",
        "Promise<SteemMarketSnapshot | null>",
      );
      replaceAnchored(
        files[1],
        "if (!snap.oracle.fresh || snap.oracle.steemUsds === null || snap.oracle.sbdUsds === null) {",
        "if (!snap || !snap.oracle.fresh || snap.oracle.steemUsds === null || snap.oracle.sbdUsds === null) {",
        "if (!snap || !snap.oracle.fresh",
      );
      replaceAnchored(
        files[2],
        "if (snap.oracle.sbdUsds !== null) sbdMark = snap.oracle.sbdUsds;",
        "if (snap && snap.oracle.sbdUsds !== null) sbdMark = snap.oracle.sbdUsds;",
        "if (snap && snap.oracle.sbdUsds !== null",
      );
      replaceAnchored(files[3], '["STEEM", snap.oracle.steemUsds],', '["STEEM", snap?.oracle.steemUsds ?? null],', "snap?.oracle.steemUsds ?? null");
      replaceAnchored(files[3], '["SBD", snap.oracle.sbdUsds],', '["SBD", snap?.oracle.sbdUsds ?? null],', "snap?.oracle.sbdUsds ?? null");
      replaceAnchored(files[3], "snapshot: snap,", "snapshot: snap ?? null,", "snapshot: snap ?? null");
    },
  };
}

/* ── C4: swallow-guard-cli readonly truth — the library returns frozen sets ──
 * detectSwallows() returns { swallows: readonly Swallow[]; alerts: readonly
 * ContentAlert[] } (Object.freeze — the file's own immutability law); the CLI
 * destructure declared mutable types → contract lie. The cure aligns the CLI
 * to the library's own signature truth (readonly), 1-line, idempotent.
 */
export function swallowGuardCliReadonlyCure(root: string, c: TsContract): CurePlan {
  return {
    files: [c.file],
    describe: `${c.file} destructure type aligned to library truth (readonly Swallow[] / readonly ContentAlert[]) — detectSwallows returns frozen sets by its own law`,
    apply(root: string) {
      const p = path.join(root, c.file);
      const src = fs.readFileSync(p, "utf8");
      const from = "{ swallows: Swallow[]; alerts: ContentAlert[] }";
      const to = "{ swallows: readonly Swallow[]; alerts: readonly ContentAlert[] }";
      if (src.includes(to)) return; // idempotent
      if (!src.includes(from)) throw new Error(`swallow-guard-cli-readonly: anchor not found in ${c.file} — refusing blind edit`);
      fs.writeFileSync(p, src.replace(from, to));
    },
  };
}

/* ── C3: bun:test ambient reference, file-scoped, idempotent ─────────────── */
export function bunTestReferenceCure(root: string, c: TsContract): CurePlan {
  return {
    files: [c.file],
    describe: `${c.file} += '/// <reference types="bun-types" />' — file-scoped ambient bun:test types (root sweep has no bun types; mini-services units carry their own tsconfig, src tests need the reference)`,
    apply(root: string) {
      const p = path.join(root, c.file);
      const src = fs.readFileSync(p, "utf8");
      const ref = '/// <reference types="bun-types" />';
      if (src.includes(ref)) return; // idempotent
      fs.writeFileSync(p, ref + "\n" + src);
    },
  };
}

/* ── the registry ─────────────────────────────────────────────────────────── */
function isCapitalLowLiquidity(c: TsContract): boolean {
  return (
    c.file === "src/lib/giant/capital.ts" &&
    c.code === "TS2322" &&
    c.message.includes('"LOW"') &&
    c.message.includes('"LOCKED-7D"')
  );
}

function isSteemFeedNull(c: TsContract): boolean {
  return (
    c.file === "src/lib/steem-feed.ts" &&
    c.code === "TS2322" &&
    c.message.includes("null") &&
    c.message.includes("SteemMarketSnapshot")
  );
}

function isBunTestImport(c: TsContract): boolean {
  return (
    c.code === "TS2307" &&
    c.message.includes("'bun:test'") &&
    c.file.endsWith(".test.ts")
  );
}

export const CURE_REGISTRY: Cure[] = [
  { id: "trunk-unit-boundary", matches: (_c) => false, build: trunkUnitBoundaryCure }, // invoked directly by cycle when rewind detected
  { id: "capital-liquidity-band", matches: isCapitalLowLiquidity, build: capitalLiquidityCure },
  { id: "steem-feed-nullable-truth", matches: isSteemFeedNull, build: steemFeedNullableCure },
  { id: "swallow-guard-cli-readonly", matches: isSwallowCliReadonly, build: swallowGuardCliReadonlyCure },
  { id: "buntest-file-reference", matches: isBunTestImport, build: bunTestReferenceCure },
];

function isSwallowCliReadonly(c: TsContract): boolean {
  return (
    c.file === "scripts/swallow-guard-cli.ts" &&
    c.code === "TS2322" &&
    c.message.includes("readonly") &&
    c.message.includes("Swallow")
  );
}

/** Pre-flight guard: adopted unit-boundary truth present? If rewound, the
 * boundary artifact floods the evidence (594 class) and buries real contracts.
 * Returns the boundary cure selection when a rewind is detected. */
export function boundaryRewindSelection(root: string): Selection | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")) as { exclude?: string[] };
    if (JSON.stringify(doc.exclude ?? []) !== JSON.stringify(["node_modules", "mini-services", "examples"])) {
      return {
        contract: { file: "tsconfig.json", line: 0, col: 0, code: "TS0000", message: "unit-boundary rewind detected (exclude drifted from adopted truth)" },
        cureId: "trunk-unit-boundary",
        cure: { id: "trunk-unit-boundary", matches: () => true, build: trunkUnitBoundaryCure },
      };
    }
  } catch {
    return null; // unparseable tsconfig → let the normal cycle run (its cures refuse honestly)
  }
  return null;
}
