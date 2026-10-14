#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_i38.py — roshpina's focused sovereign-invariant machine (I38 + R-D4).

DNA: Sandbox ops/sovereign-invariants/check_invariants.py (D3 budgets, D4
silent-push) — the semantics are transplanted VERBATIM (same regexes, same
contracts) so the two machines speak ONE law. Sharpenings beyond the Sandbox
original:
  • REVERSE DRIFT — a budgets.json entry naming a workflow file that does not
    exist is RED (ghost coverage lies); Sandbox D3 checks only the forward
    direction.
  • FORMAT IS LAW — a malformed budgets.json is RED even when no cron exists.
  • DOGFOOD BY CONSTRUCTION — the machine's own CI (sovereign-invariants-i38.yml)
    is a scheduled workflow carrying its budget inline, so the law always has
    at least one real subject; never vacuous-by-construction.

Laws:
  I38  — every scheduled workflow (.github/workflows/*.{yml,yaml} containing
         "schedule:") declares a budget ceiling: inline "# budget: max=N" or
         ops/sovereign-invariants/budgets.json {"workflows": {fn: {"max": int≥0}}}.
  R-D4 — no silenced push: in .github/workflows/* + scripts/ + agents/ (when
         present), a "git push" segment may not hide its failure (/dev/null in
         the segment, "|| true" swallow, or a retry-loop without a loud landing
         gate). D4 semantics verbatim.

Exit: 0 = GREEN, 1 = RED (law violated), 2 = machine error. Never silent.
Run:  python3 ops/sovereign-invariants/check_i38.py [repo-root]
"""

import json
import os
import re
import sys

WF_DIR = os.path.join(".github", "workflows")
BUDGETS_REL = os.path.join("ops", "sovereign-invariants", "budgets.json")
SCAN_SUBDIRS = ("scripts", "agents")  # scanned only when they exist
TEXT_EXT = (".yml", ".yaml", ".sh", ".py", ".mjs", ".cjs", ".js")

# THE contract constants — the law doc (I38.md) names these verbatim; doc/code
# drift between them is itself a finding for the next sharpening pass.
BUDGET_INLINE_RE = re.compile(r"#\s*budget:\s*max=(\d+)")

SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", "coverage"}


class Report:
    def __init__(self):
        self.lines = []

    def ok(self, law, msg):
        self.lines.append(f"OK   {law}  {msg}")

    def fail(self, law, msg):
        self.lines.append(f"FAIL {law}  {msg}")

    def verdict(self):
        bad = any(l.startswith("FAIL") for l in self.lines)
        if bad:
            self.lines.append("VERDICT: RED  (any FAIL above = a law violated; fix or document, never silence)")
        else:
            self.lines.append("VERDICT: GREEN")
        return not bad


def load_text(path):
    try:
        with open(path, encoding="utf-8", errors="strict") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


# ---------------- I38: budget ceilings for scheduled workflows ----------------
def i38_budgets(root, rep):
    wf_dir = os.path.join(root, WF_DIR)
    budgets = {}
    btxt = load_text(os.path.join(root, BUDGETS_REL))
    if btxt is not None:
        try:
            parsed = json.loads(btxt)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("workflows", {}), dict):
                rep.fail("I38", f"{BUDGETS_REL} — מבנה שגוי (נדרש {{\"workflows\": {{…}}}})")
                return
            budgets = parsed["workflows"]
            for fn, entry in budgets.items():
                if not (isinstance(entry, dict) and isinstance(entry.get("max"), int) and not isinstance(entry.get("max"), bool) and entry["max"] >= 0):
                    rep.fail("I38", f"{BUDGETS_REL} — {fn}: תקרה שאינה מספר-שלם ≥0")
                    return
        except json.JSONDecodeError as e:
            rep.fail("I38", f"{BUDGETS_REL} אינו JSON תקין: {e}")
            return

    scheduled = []
    unbudgeted = []
    if os.path.isdir(wf_dir):
        for fn in sorted(os.listdir(wf_dir)):
            if not fn.endswith((".yml", ".yaml")):
                continue
            txt = load_text(os.path.join(wf_dir, fn))
            if txt is None or "schedule:" not in txt:
                continue
            scheduled.append(fn)
            if BUDGET_INLINE_RE.search(txt):
                continue
            entry = budgets.get(fn)
            if isinstance(entry, dict) and isinstance(entry.get("max"), int) and entry["max"] >= 0:
                continue
            unbudgeted.append(fn)

    ghosts = [fn for fn in budgets if not os.path.isfile(os.path.join(wf_dir, fn))]
    if unbudgeted:
        rep.fail("I38", f"{len(unbudgeted)} workflows מתוזמנים בלי תקרת-תקציב מוצהרת: {', '.join(unbudgeted[:6])}")
    elif ghosts:
        rep.fail("I38", f"{len(ghosts)} רשומות-תקציב ל-workflows שאינם קיימים (כיסוי-רפאים משקר): {', '.join(ghosts[:6])}")
    else:
        rep.ok("I38", f"{len(scheduled)} workflows מתוזמנים — לכולם תקרת-תקציב (inline או budgets.json); {len(budgets)} רשומות-תקציב, 0 רפאים")


# ---------------- R-D4: no silenced push (D4 semantics, verbatim) ----------------
def rd4_silent_push(root, rep):
    scan_files = []
    wf_dir = os.path.join(root, WF_DIR)
    if os.path.isdir(wf_dir):
        scan_files += [os.path.join(wf_dir, fn) for fn in sorted(os.listdir(wf_dir)) if fn.endswith((".yml", ".yaml"))]
    for sub in SCAN_SUBDIRS:
        d = os.path.join(root, sub)
        if os.path.isdir(d):
            for dirpath, dirnames, filenames in os.walk(d):
                dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS]
                scan_files += [os.path.join(dirpath, fn) for fn in filenames if fn.endswith(TEXT_EXT)]

    violations = []
    push_sites = 0
    for p in scan_files:
        txt = load_text(p)
        if not txt or "git push" not in txt:
            continue
        rel = os.path.relpath(p, root)
        push_sites += 1
        for i, line in enumerate(txt.splitlines(), 1):
            if "git push" not in line:
                continue
            toks = re.split(r"(\|\||&&|;)", line)
            for j, seg in enumerate(toks):
                if "git push" not in seg:
                    continue
                if "/dev/null" in seg:
                    violations.append(f"{rel}:{i} — git-push מוסתר-ל-/dev/null")
                    break
                if j + 2 < len(toks) and toks[j + 1] == "||" and toks[j + 2].strip() == "true":
                    violations.append(f"{rel}:{i} — git-push עם ||-true (כישלון-נבלע)")
                    break
        has_loop = re.search(r"git push[^\n]*break \|\|", txt) is not None
        has_loud = (re.search(r"git push[^\n]*\|\|\s*\{[^\n]*exit 1", txt) is not None) or ("ls-remote" in txt)
        if has_loop and not has_loud:
            violations.append(f"{rel} — לולאת-ניסיונות-push בלי שער-נחיתה מצטעק (כישלון-כל-הניסיונות = ירוק-שקט)")

    if violations:
        tail = f" (+{len(violations)-5} נוספים)" if len(violations) > 5 else ""
        rep.fail("R-D4", f"{len(scan_files)} קבצים/{push_sites} אתרי-push; " + "; ".join(violations[:5]) + tail)
    else:
        rep.ok("R-D4", f"{len(scan_files)} קבצים נסרקו, {push_sites} אתרי-push — אפס דחיפה-שקטה")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    if not os.path.isdir(root):
        print(f"MACHINE-ERROR: root '{root}' אינו קיים", file=sys.stderr)
        sys.exit(2)
    rep = Report()
    try:
        i38_budgets(root, rep)
        rd4_silent_push(root, rep)
    except Exception as e:  # machine errors are loud, exit 2 — never mistaken for GREEN
        print(f"MACHINE-ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    for line in rep.lines:
        print(line)
    sys.exit(0 if rep.verdict() else 1)


if __name__ == "__main__":
    main()
