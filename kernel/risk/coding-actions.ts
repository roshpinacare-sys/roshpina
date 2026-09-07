/**
 * lib/risk/coding-actions.ts — Coding-agent action taxonomy (DATA + classifier).
 *
 * WHY THIS EXISTS
 * ---------------
 * `action-risk.ts` maps *TFA-internal* action types (ledger.mint, marketplace.claim,
 * etc.) to risk classes. But the MANIFEST's primary wedge is **TFA as Trust Gate
 * for coding agents** (Claude Code / Cursor / OpenHands / MCP) — and those agents
 * name actions in their own vocabulary: `delete_file`, `shell_exec`, `git_push`,
 * `db_migration`, `edit_env`, etc.
 *
 * Without server-side classification of THESE action types, `riskClass` in an
 * `ActionIntent` from an agent is client-supplied and unverified — the central
 * security blind spot flagged in MANIFEST "החסר הבא" #1.
 *
 * This module defines:
 *   1. `CODING_ACTION_TYPES` — the canonical vocabulary of coding agent actions as DATA.
 *   2. `CODING_ACTION_RISK_MAP` — maps every coding action type to a risk class.
 *   3. `classifyCodingAction(actionType)` — server-side classifier.
 *      FAIL-CLOSED: an unmapped / unknown action type returns MOST_RESTRICTIVE_RISK_CLASS
 *      ("irreversible") — never silently treated as safe.
 *   4. `isCodingAction(actionType)` — predicate: is this a known coding action type?
 *   5. `CODING_ACTION_METADATA` — human-readable description + danger rationale per type
 *      (for MCP tool responses, UI, and audit receipts).
 *
 * DESIGN INVARIANTS
 * -----------------
 * • Taxonomy is DATA (plain objects/constants), not code paths. Changing the risk
 *   of an action type requires only a map change — no control-flow rewrites.
 * • server-side: the adapter (`lib/adapter/agent-adapter.ts`) calls this BEFORE
 *   trusting the client's `riskClass`. If the action type is known here, the
 *   server-derived class overrides the client's claim.
 * • Zero external dependencies.
 * • Coverage: every value in CODING_ACTION_TYPES must appear in CODING_ACTION_RISK_MAP.
 *   `tests/risk/coding-actions.test.ts` enforces this as a fail-closed test.
 *
 * EXTENSION GUIDE
 * ---------------
 * Adding a new action type: (1) add to CODING_ACTION_TYPES; (2) add to
 * CODING_ACTION_RISK_MAP with a deliberate risk class; (3) add to
 * CODING_ACTION_METADATA; (4) the coverage test will fail until all three are done,
 * preventing silent omissions.
 */

import type { ActionRiskClass } from "../orchestrator/types";
import { MOST_RESTRICTIVE_RISK_CLASS } from "./action-risk";

// ─── Canonical vocabulary ────────────────────────────────────────────────────

/**
 * CODING_ACTION_TYPES — every action type a coding agent can declare.
 * Values are the canonical strings used in ActionIntent.toolId / action.type.
 *
 * Naming convention: `<domain>.<verb>` using underscores, no spaces.
 * A coding agent MUST use these exact strings for server-side classification to
 * apply; anything else is treated as the most-restrictive risk class.
 */
export const CODING_ACTION_TYPES = {
  // ── File system ─────────────────────────────────────────────────────────
  /** Read a file without modification. Safe. */
  READ_FILE: "file.read",
  /** Create a new file (path must not exist). Low risk. */
  CREATE_FILE: "file.create",
  /** Modify an existing file's contents. */
  EDIT_FILE: "file.edit",
  /** Delete a file or directory. Destructive. */
  DELETE_FILE: "file.delete",
  /** Move or rename a file / directory. */
  MOVE_FILE: "file.move",
  /** Copy a file without modifying the source. */
  COPY_FILE: "file.copy",

  // ── Shell / execution ────────────────────────────────────────────────────
  /** Execute an arbitrary shell command. High risk — can do anything. */
  SHELL_EXEC: "shell.exec",
  /** Run a process and capture its stdout/stderr (read-only). */
  PROCESS_READ: "process.read",
  /** Send a signal to a running process (kill, pause, etc.). */
  PROCESS_SIGNAL: "process.signal",

  // ── Version control ──────────────────────────────────────────────────────
  /** Read git status / log / diff — no state change. */
  GIT_READ: "git.read",
  /** Stage file changes for commit (`git add`). */
  GIT_STAGE: "git.stage",
  /** Create a commit in the local repository. */
  GIT_COMMIT: "git.commit",
  /** Push commits to a remote repository. Irreversible (public after push). */
  GIT_PUSH: "git.push",
  /** Force-push (rewriting remote history). Irreversible. */
  GIT_PUSH_FORCE: "git.push_force",
  /** Merge branches. Can cause conflicts and history loss. */
  GIT_MERGE: "git.merge",
  /** Rebase — rewrites commit history. Destructive. */
  GIT_REBASE: "git.rebase",

  // ── Package / dependency management ─────────────────────────────────────
  /** Install or update package dependencies. */
  PACKAGE_INSTALL: "package.install",
  /** Remove a package from dependencies. */
  PACKAGE_REMOVE: "package.remove",
  /** Publish a package to a registry. Irreversible (public). */
  PACKAGE_PUBLISH: "package.publish",

  // ── Network / HTTP ───────────────────────────────────────────────────────
  /** Read-only HTTP GET request to an external service. */
  NETWORK_READ: "network.read",
  /** HTTP write (POST/PUT/PATCH) to an external service — state change. */
  NETWORK_WRITE: "network.write",
  /** HTTP DELETE to an external service. */
  NETWORK_DELETE: "network.delete",
  /** Open a persistent connection (WebSocket, SSE). */
  NETWORK_CONNECT: "network.connect",

  // ── Database ─────────────────────────────────────────────────────────────
  /** Read (SELECT) from a database. */
  DB_READ: "db.read",
  /** Non-destructive data write (INSERT, UPDATE). */
  DB_WRITE: "db.write",
  /** Delete rows from a database. */
  DB_DELETE: "db.delete",
  /** DDL change — schema migration. Very high risk (can lose data). */
  DB_MIGRATION: "db.migration",
  /** Drop a table or database. Irreversible. */
  DB_DROP: "db.drop",

  // ── Environment / secrets ────────────────────────────────────────────────
  /** Read an environment variable or secret. Privacy-sensitive. */
  ENV_READ: "env.read",
  /**
   * Write / update an environment variable or secret.
   * High risk: can change application behavior or expose credentials.
   */
  ENV_WRITE: "env.write",
  /** Delete an environment variable or secret. Destructive. */
  ENV_DELETE: "env.delete",

  // ── Infrastructure / cloud ───────────────────────────────────────────────
  /** Read cloud resource metadata. */
  INFRA_READ: "infra.read",
  /** Provision a new cloud resource. */
  INFRA_CREATE: "infra.create",
  /** Modify an existing cloud resource. */
  INFRA_UPDATE: "infra.update",
  /** Destroy a cloud resource. Irreversible. */
  INFRA_DESTROY: "infra.destroy",
  /** Apply an IaC plan (Terraform apply, CDK deploy, etc.). Very high risk. */
  INFRA_APPLY: "infra.apply",

  // ── CI/CD ────────────────────────────────────────────────────────────────
  /** Read pipeline logs or status. */
  CI_READ: "ci.read",
  /** Trigger a new pipeline run. */
  CI_TRIGGER: "ci.trigger",
  /** Approve a pipeline gate (production deploy, etc.). */
  CI_APPROVE: "ci.approve",

  // ── Code review / PR ─────────────────────────────────────────────────────
  /** Read a pull request or review. */
  PR_READ: "pr.read",
  /** Create or update a pull request. */
  PR_WRITE: "pr.write",
  /** Merge a pull request into the target branch. */
  PR_MERGE: "pr.merge",

  // ── DeFi / on-chain (M3) ─────────────────────────────────────────────────
  /**
   * Swap tokens on a DEX (e.g. Uniswap, 1inch).
   * Moves value and may include slippage/MEV risk.
   */
  TOKEN_SWAP: "token.swap",
  /**
   * Provide or remove liquidity from a DEX pool (LP position).
   * Irreversible in the sense that impermanent loss may occur and exact
   * amounts returned depend on pool state at withdrawal time.
   */
  LIQUIDITY_PROVIDE: "liquidity.provide",
  /**
   * Bridge tokens cross-chain (e.g. Optimism bridge, LayerZero).
   * Irreversible once submitted to source chain; destination chain delivery
   * is out of TFA's control and may fail silently.
   */
  BRIDGE_TRANSFER: "bridge.transfer",
  /**
   * ERC-20 approve / permit — grants a spender contract unlimited (or bounded)
   * allowance over the wallet's tokens. A compromised or malicious contract
   * can drain funds after approval.
   */
  TOKEN_APPROVE: "token.approve",
} as const;

export type CodingActionType = typeof CODING_ACTION_TYPES[keyof typeof CODING_ACTION_TYPES];

// ─── Risk classification map ─────────────────────────────────────────────────

/**
 * CODING_ACTION_RISK_MAP — every coding action type mapped to its risk class.
 *
 * Governance-as-DATA: replacing this object changes risk policy without code edits.
 * Coverage test (`tests/risk/coding-actions.test.ts`) asserts EVERY value in
 * CODING_ACTION_TYPES has an entry here — silent omissions are caught at test-time.
 */
export const CODING_ACTION_RISK_MAP: Readonly<Record<CodingActionType, ActionRiskClass>> = {
  // ── File system ─────────────────────────────────────────────────────────
  "file.read":   "read_only",
  "file.create": "write_safe",
  "file.edit":   "write_safe",
  "file.delete": "write_destructive",
  "file.move":   "write_safe",
  "file.copy":   "write_safe",

  // ── Shell / execution ────────────────────────────────────────────────────
  // shell.exec can run rm -rf / exfiltrate secrets / network calls → irreversible
  "shell.exec":      "irreversible",
  "process.read":    "read_only",
  "process.signal":  "write_destructive",

  // ── Version control ──────────────────────────────────────────────────────
  "git.read":        "read_only",
  "git.stage":       "write_safe",
  "git.commit":      "write_safe",
  // After push, changes are public and can be seen by others even if force-deleted
  "git.push":        "write_destructive",
  "git.push_force":  "irreversible",
  // Merge/rebase can silently drop commits
  "git.merge":       "write_destructive",
  "git.rebase":      "irreversible",

  // ── Package management ───────────────────────────────────────────────────
  "package.install": "write_safe",
  "package.remove":  "write_destructive",
  // Publishing is public and largely irreversible (npm doesn't allow unpublish after 72h)
  "package.publish": "irreversible",

  // ── Network ──────────────────────────────────────────────────────────────
  "network.read":    "read_only",
  // External state change — can trigger webhooks, charges, etc.
  "network.write":   "write_destructive",
  "network.delete":  "write_destructive",
  "network.connect": "write_safe",

  // ── Database ─────────────────────────────────────────────────────────────
  "db.read":      "read_only",
  "db.write":     "write_safe",
  "db.delete":    "write_destructive",
  // Schema migration can corrupt data for all tenants
  "db.migration": "irreversible",
  "db.drop":      "irreversible",

  // ── Environment / secrets ────────────────────────────────────────────────
  // env.read can expose credentials → privacy_sensitive
  "env.read":    "privacy_sensitive",
  "env.write":   "write_destructive",
  "env.delete":  "write_destructive",

  // ── Infrastructure ───────────────────────────────────────────────────────
  "infra.read":    "read_only",
  "infra.create":  "write_safe",
  "infra.update":  "write_destructive",
  "infra.destroy": "irreversible",
  // infra.apply can create costs and destroy prod resources
  "infra.apply":   "irreversible",

  // ── CI/CD ────────────────────────────────────────────────────────────────
  "ci.read":    "read_only",
  "ci.trigger": "write_safe",
  // ci.approve sends to production
  "ci.approve": "write_destructive",

  // ── Code review / PR ─────────────────────────────────────────────────────
  "pr.read":  "read_only",
  "pr.write": "write_safe",
  // pr.merge changes the main branch
  "pr.merge": "write_destructive",

  // ── DeFi / on-chain (M3) ─────────────────────────────────────────────────
  // token.swap moves value on-chain — slippage, MEV, irreversible on confirmation
  "token.swap":       "value_moving",
  // liquidity.provide locks tokens in a pool; impermanent loss; bridge risk on multi-chain pools
  "liquidity.provide": "irreversible",
  // bridge.transfer crosses to another chain: destination delivery unverifiable, bridging contracts have been exploited
  "bridge.transfer":  "irreversible",
  // token.approve grants allowance — a malicious/hacked contract can drain the wallet later
  "token.approve":    "write_destructive",
} as const;

// ─── Human-readable metadata ─────────────────────────────────────────────────

export interface CodingActionMeta {
  /** One-line description of what this action does. */
  description: string;
  /** Why this specific risk class was assigned (audit / UI rationale). */
  rationale: string;
}

/**
 * CODING_ACTION_METADATA — human-readable per-type metadata for MCP tool
 * responses, dashboard UI, and audit receipts. Not used in policy evaluation.
 */
export const CODING_ACTION_METADATA: Readonly<Record<CodingActionType, CodingActionMeta>> = {
  "file.read":    { description: "Read file contents", rationale: "No state change; safe for auto-approval." },
  "file.create":  { description: "Create a new file", rationale: "Creates state but reversible (file can be deleted)." },
  "file.edit":    { description: "Modify an existing file", rationale: "Overwrites content; reversible via git, but may break builds." },
  "file.delete":  { description: "Delete a file or directory", rationale: "Data loss without git recovery; requires human review." },
  "file.move":    { description: "Move or rename a file", rationale: "Reversible rename; low risk." },
  "file.copy":    { description: "Copy a file", rationale: "Non-destructive duplication." },

  "shell.exec":     { description: "Execute an arbitrary shell command", rationale: "Unrestricted: can exfiltrate data, delete files, or make network calls. Always requires review." },
  "process.read":   { description: "Read process output (stdout/stderr)", rationale: "Read-only observation of running processes." },
  "process.signal": { description: "Send a signal to a process", rationale: "Can kill a process; destructive but local." },

  "git.read":       { description: "Read git history / status", rationale: "No state change." },
  "git.stage":      { description: "Stage changes for commit", rationale: "Intermediate step; reversible via git reset." },
  "git.commit":     { description: "Create a local commit", rationale: "Local change only; reversible with git reset --hard." },
  "git.push":       { description: "Push commits to remote", rationale: "Public after push; others may pull; requires confirmation." },
  "git.push_force": { description: "Force-push to remote (rewrite history)", rationale: "Permanently rewrites remote history; can destroy teammates' work." },
  "git.merge":      { description: "Merge branches", rationale: "Can silently drop commits or create merge conflicts in CI." },
  "git.rebase":     { description: "Rebase (rewrite commit history)", rationale: "Destroys old SHAs; breaks any existing PRs against the branch." },

  "package.install": { description: "Install or update packages", rationale: "Introduces new code to the project; supply-chain risk." },
  "package.remove":  { description: "Remove a package", rationale: "Can break dependents; reversible but disruptive." },
  "package.publish": { description: "Publish to a package registry", rationale: "Public and largely irreversible after 72 h (npm policy)." },

  "network.read":    { description: "HTTP GET to an external service", rationale: "Read-only; may trigger rate limits or expose IP." },
  "network.write":   { description: "HTTP POST/PUT/PATCH to external service", rationale: "External state change; can trigger webhooks, charges, emails." },
  "network.delete":  { description: "HTTP DELETE to external service", rationale: "Permanently removes remote resources." },
  "network.connect": { description: "Open a persistent connection (WS/SSE)", rationale: "Low-risk channel establishment; data transfer is separate." },

  "db.read":      { description: "Read from a database", rationale: "No state change; may expose sensitive data (use with privacy policy)." },
  "db.write":     { description: "Insert or update rows", rationale: "Modifies data; reversible with backups but requires review." },
  "db.delete":    { description: "Delete rows from a database", rationale: "Data loss; needs explicit approval." },
  "db.migration": { description: "Apply a database schema migration", rationale: "Can corrupt or destroy data for all tenants; extremely high risk." },
  "db.drop":      { description: "Drop a table or database", rationale: "Irreversible data destruction." },

  "env.read":    { description: "Read an environment variable or secret", rationale: "Can expose API keys, passwords, or credentials to the model." },
  "env.write":   { description: "Write or update an environment variable", rationale: "Changes runtime behavior; can inject malicious values." },
  "env.delete":  { description: "Delete an environment variable", rationale: "Can crash the application by removing required config." },

  "infra.read":    { description: "Read cloud resource metadata", rationale: "No state change; may reveal architecture/costs." },
  "infra.create":  { description: "Provision a new cloud resource", rationale: "Creates cost and attack surface; reversible by destroy." },
  "infra.update":  { description: "Modify a cloud resource", rationale: "Can change security groups, IAM, or configs affecting prod." },
  "infra.destroy": { description: "Destroy a cloud resource", rationale: "Permanent data loss; requires senior approval." },
  "infra.apply":   { description: "Apply an IaC plan (Terraform/CDK)", rationale: "Executes all pending changes atomically; can destroy prod." },

  "ci.read":    { description: "Read pipeline logs or status", rationale: "No state change; may expose secrets in logs." },
  "ci.trigger": { description: "Trigger a new pipeline run", rationale: "Starts compute; can run arbitrary code in CI environment." },
  "ci.approve": { description: "Approve a pipeline gate", rationale: "Sends to production; requires human confirmation." },

  "pr.read":  { description: "Read a pull request or code review", rationale: "No state change." },
  "pr.write": { description: "Create or update a pull request", rationale: "Adds code to review; reversible by closing the PR." },
  "pr.merge": { description: "Merge a pull request to target branch", rationale: "Changes the main branch; may trigger auto-deployments." },

  // ── DeFi / on-chain (M3) ─────────────────────────────────────────────────
  "token.swap": {
    description: "Swap tokens on a decentralised exchange (DEX)",
    rationale: "Moves on-chain value; slippage and MEV risk; transaction is irreversible once mined. Requires explicit approval.",
  },
  "liquidity.provide": {
    description: "Provide or remove liquidity from a DEX pool (LP position)",
    rationale: "Locks tokens in a smart contract; impermanent loss risk; exact amounts returned depend on pool state. Treat as irreversible commitment.",
  },
  "bridge.transfer": {
    description: "Bridge tokens cross-chain (e.g. Optimism, LayerZero, Wormhole)",
    rationale: "Cross-chain transfers are irreversible once submitted to the source chain. Destination delivery is out of TFA control; bridge contracts have suffered >$2B in exploits.",
  },
  "token.approve": {
    description: "ERC-20 approve / permit — grant a contract spending allowance",
    rationale: "A compromised or malicious spender contract can drain wallet funds after approval. Always require human confirmation; prefer bounded allowances.",
  },
} as const;

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * classifyCodingAction — server-side risk classification for coding-agent action types.
 *
 * This is the key primitive that makes TFA a Trust Gate (not just a router):
 * the SERVER classifies the risk, not the client. An agent that sends
 * `riskClass: "read_only"` for a `shell.exec` action will have its claim
 * overridden to `"irreversible"` by this function.
 *
 * FAIL-CLOSED: any unknown / unmapped action type returns
 * MOST_RESTRICTIVE_RISK_CLASS ("irreversible"). When in doubt, treat as dangerous.
 */
export function classifyCodingAction(actionType: string): ActionRiskClass {
  if (typeof actionType !== "string" || actionType.length === 0) {
    return MOST_RESTRICTIVE_RISK_CLASS;
  }
  const mapped = (CODING_ACTION_RISK_MAP as Record<string, ActionRiskClass>)[actionType];
  return mapped ?? MOST_RESTRICTIVE_RISK_CLASS;
}

/**
 * Precomputed Set of all known coding action types.
 * Computed once at module load; O(1) `.has()` on every hot-path call to
 * `isCodingAction`, replacing the per-call `hasOwnProperty` probe.
 */
const CODING_ACTION_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(CODING_ACTION_RISK_MAP));

/** True iff `actionType` has an explicit entry in CODING_ACTION_RISK_MAP. */
export function isCodingAction(actionType: string): boolean {
  return CODING_ACTION_TYPE_SET.has(actionType);
}

/**
 * classifyActionServerSide — resolve the authoritative risk class for an intent.
 *
 * Priority: (1) coding-action taxonomy; (2) general action-risk taxonomy;
 *           (3) fail-closed default if neither recognises the type.
 *
 * Use this in the adapter / route handler to override any client-supplied riskClass.
 * The client's claim is logged (for audit) but not trusted for policy decisions.
 */
import { classifyRisk, isClassified } from "./action-risk";

export function classifyActionServerSide(actionType: string): {
  riskClass: ActionRiskClass;
  source: "coding_taxonomy" | "general_taxonomy" | "fail_closed_default";
} {
  if (isCodingAction(actionType)) {
    return { riskClass: classifyCodingAction(actionType), source: "coding_taxonomy" };
  }
  if (isClassified(actionType)) {
    return { riskClass: classifyRisk(actionType), source: "general_taxonomy" };
  }
  return { riskClass: MOST_RESTRICTIVE_RISK_CLASS, source: "fail_closed_default" };
}
