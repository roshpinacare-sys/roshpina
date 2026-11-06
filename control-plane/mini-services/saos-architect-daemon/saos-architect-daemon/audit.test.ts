/**
 * audit.test.ts — TDD (§5 zero-slop executive audit).
 * The scan consumes the CANON law byte-mirrored from the quality-gate core;
 * these fixtures lock the mirror (a divergence from the canon is a defect
 * of audit.ts, never a licence to "fix" the canon).
 */
import { describe, test, expect } from "bun:test";
import { scanSlop, SLOP_PATTERNS, isSlopExemptPath, type SourceFile } from "./audit";

const f = (path: string, content: string): SourceFile => ({ path, content });

describe("canon mirror law", () => {
  test("pattern list mirrors the quality-gate canon ids in order", () => {
    expect(SLOP_PATTERNS.map((p) => p.id)).toEqual([
      "TODO", "FIXME", "XXX", "HACK", "PLACEHOLDER-COMMENT",
      "STUB", "MOCK-RETURN", "NOT-IMPLEMENTED", "UNIMPLEMENTED", "TO-BE-DONE",
    ]);
  });

  test("canon exemptions hold (lockfiles, build, state, db, git)", () => {
    expect(isSlopExemptPath("bun.lock")).toBe(true);
    expect(isSlopExemptPath("a/node_modules/x.ts")).toBe(true);
    expect(isSlopExemptPath(".next/x.ts")).toBe(true);
    expect(isSlopExemptPath("db/live.json")).toBe(true);
    expect(isSlopExemptPath("state/architect-daemon-receipts.jsonl")).toBe(true);
    expect(isSlopExemptPath("src/lib/real.ts")).toBe(false);
  });
});

describe("scanSlop", () => {
  test("flags bare TODO in production file", () => {
    const out = scanSlop([f("src/lib/x.ts", "export const a = 1; // TODO fix\n")]);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("TODO");
    expect(out[0].line).toBe(1);
  });

  test("flags canonical violation families", () => {
    const out = scanSlop([
      f("a.ts", "// placeholder implementation goes here\n"),
      f("b.ts", "throw new Error('not implemented');\n"),
      f("c.ts", "// FIXME later\n"),
      f("d.ts", "// stub returns until wired\n"),
      f("e.ts", "// mocked response will be replaced\n"),
      f("g.ts", "// to be done next sprint\n"),
    ]);
    expect(out.map((v) => v.pattern).sort()).toEqual(
      ["FIXME", "NOT-IMPLEMENTED", "PLACEHOLDER-COMMENT", "STUB", "MOCK-RETURN", "TO-BE-DONE"].sort(),
    );
  });

  test("React/Tailwind placeholder attribute is NOT slop (canon: comment-form only)", () => {
    const out = scanSlop([
      f("src/components/ui/textarea.tsx", '"border-input placeholder:text-muted-foreground"\n'),
      f("src/components/hq/OperatorDrawer.tsx", '<Input placeholder="מפתח מנהל" />\n'),
    ]);
    expect(out).toHaveLength(0);
  });

  test("test files exempt from STUB/MOCK-RETURN families only", () => {
    const out = scanSlop([f("a.test.ts", "// stub returns are fine here\n// mocked response ok\n")]);
    expect(out).toHaveLength(0);
  });

  test("test files NOT exempt from TODO/FIXME (canon law)", () => {
    const out = scanSlop([f("a.test.ts", "// TODO finish the matrix\n")]);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("TODO");
  });

  test("harness/ paths are test-law paths (canon isTestPath)", () => {
    const out = scanSlop([f("harness/gen.ts", "// stub ok in harness\n")]);
    expect(out).toHaveLength(0);
  });

  test("clean production file yields zero violations", () => {
    const out = scanSlop([f("src/lib/clean.ts", "export const ok = 'honest measured truth';\nconst methodical = 1;\n")]);
    expect(out).toHaveLength(0);
  });

  test("determinism: same input → same output order", () => {
    const files = [f("z.ts", "// TODO z\n"), f("a.ts", "// TODO a\n")];
    expect(scanSlop(files)).toEqual(scanSlop(files));
  });

  test("one line = one violation (first pattern in canon order wins)", () => {
    const out = scanSlop([f("x.ts", "// TODO and FIXME on one line\n")]);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("TODO");
  });
});
