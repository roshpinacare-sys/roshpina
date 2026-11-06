/**
 * git-sweep.ts — real state of every repo in /home/z/repos:
 * current branch, uncommitted files count, last commit.
 * This is what the fleet actually looks like on disk right now.
 */

import { readdirSync } from "fs";
import { join } from "path";

const ROOT = "/home/z/repos";

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function git(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return p.stdout.toString().trim();
}

console.log(`fleet git sweep — ${new Date().toISOString()}`);
console.log("");
console.log(`  ${"repo".padEnd(34)} ${"branch".padEnd(28)} ${"dirty".padStart(5)}  last-commit`);
console.log(`  ${"-".repeat(34)} ${"-".repeat(28)} ${"-".repeat(5)}  ${"-".repeat(18)}`);

for (const name of dirs) {
  const cwd = join(ROOT, name);
  const isRepo = git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  if (!isRepo) {
    console.log(`  ${name.padEnd(34)} ${"(not a git repo)".padEnd(28)}`);
    continue;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || "?";
  const dirty = git(["status", "--porcelain"], cwd).split("\n").filter(Boolean).length;
  const last = git(["log", "--oneline", "-1"], cwd).slice(0, 18);
  console.log(`  ${name.padEnd(34)} ${branch.padEnd(28)} ${String(dirty).padStart(5)}  ${last}`);
}

const total = dirs.length;
console.log("");
console.log(`scanned ${total} repos under ${ROOT}`);
