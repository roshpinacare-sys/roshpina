/**
 * lib/potential/potential-engine.ts — PotentialEngine.
 *
 * The core vision of TFA: identify user potential and route to success.
 *
 * Every operation is an AUTONOMOUS action routed through TfaOrchestrator:
 *   • analyze()  → action type "potential.analyze" (isAutonomous: true)
 *   • route()    → action type "potential.route"   (isAutonomous: true)
 *
 * Because isAutonomous = true, the fail-closed rule applies:
 *   NO POLICIES = DENY. The engine will not run without at least one guard policy.
 *
 * Phase C — Autonomous Agent under Delegation + Policy:
 *   When `agentSourceId` is provided, the engine runs as a named agent identity.
 *   Pair with `requireValidDelegation(identityStore)` as a guard policy to
 *   enforce that the engine's source has a valid human-rooted delegation chain.
 *
 *   When `passportOpts.signer` is provided, every successful analyze() / route()
 *   call automatically issues an ActionPassport anchored on the audit record.
 *   The passport is attached to the result as `passport` and emitted to the
 *   optional `onPassport(passport)` hook.
 *
 * Backward compatible: existing callers (no agentSourceId, no signer) work as before.
 *
 * Usage (autonomous + delegation + passport):
 * ```ts
 * const store = new InMemoryIdentityStore();
 * store.create({ id: "human-1", tenantId, type: "human", parentId: null, createdAt: "..." });
 * store.create({ id: "engine-agent", tenantId, type: "agent", parentId: "human-1", createdAt: "..." });
 *
 * const signer = new HmacSigner("secret");
 * const engine = new PotentialEngine(
 *   [requireValidDelegation(store)],
 *   undefined,
 *   { signer, identityStore: store },
 *   "engine-agent",   // agentSourceId: the engine's registered identity
 * );
 *
 * const result = await engine.analyze({ userId, tenantId, ... });
 * if (result.ok) {
 *   console.log(result.passport?.passportId); // signed proof
 * }
 * ```
 *
 * Zero external dependencies — node:crypto only (via TfaOrchestrator + issuePassport).
 */

import { randomUUID } from "node:crypto";
import { TfaOrchestrator } from "../orchestrator/orchestrator";
import { StrengthMapper } from "./strength-mapper";
import { OpportunityRouter } from "./opportunity-router";
import { issuePassport } from "../passport/passport";
import type { ActionPassport } from "../passport/types";
import type { GuardPolicy, AuditStore, Signer } from "../orchestrator/types";
import type { IdentityStore } from "../agent-identity/types";
import type {
  AnalysisInput,
  RoutingInput,
  StrengthProfile,
  RoutingDecision,
  PotentialEngineResult,
  KnowledgeGraphSource,
} from "./types";

// ─── Passport wiring ──────────────────────────────────────────────────────────

/**
 * Optional passport-issuance wiring for PotentialEngine.
 *
 * When `signer` is provided, every successful analyze() / route() call
 * automatically issues an ActionPassport anchored on the audit record.
 * The passport is:
 *   • attached to the PotentialEngineResult as `passport`
 *   • emitted to the optional `onPassport(passport)` hook
 *
 * Fail-safe: a passport-issuance error never suppresses the engine result;
 * it surfaces as a thrown error so callers / tests notice immediately.
 */
export interface PassportIssuanceOptions {
  signer?: Signer;
  identityStore?: IdentityStore;
  onPassport?: (passport: ActionPassport) => void;
}

// ─── PotentialEngine ──────────────────────────────────────────────────────────

export class PotentialEngine {
  private readonly orchestrator: TfaOrchestrator;
  private readonly mapper: StrengthMapper;
  private readonly router: OpportunityRouter;
  private readonly passportOpts: PassportIssuanceOptions;
  /** The engine's registered agent identity id. Used as Action.source. */
  private readonly agentSourceId: string;
  /** Optional real Knowledge Graph source for fetching signals (v79). */
  private readonly kgSource?: KnowledgeGraphSource;

  /**
   * @param policies       Guard policies. At least one required for autonomous actions.
   *                       With zero policies, analyze() and route() will always deny.
   *                       Tip: include `requireValidDelegation(identityStore)` to
   *                       enforce a valid human-rooted delegation chain.
   * @param auditStore     Optional audit store. Defaults to InMemoryAuditStore.
   * @param passportOpts   Optional passport-issuance wiring (Phase C).
   *                       When `signer` is present, every successful operation
   *                       produces a signed ActionPassport on the result.
   * @param agentSourceId  The engine's registered agent identity id (Phase C).
   *                       Used as Action.source for autonomous actions.
   *                       Defaults to "PotentialEngine" (backward compat).
   * @param kgSource       Optional KnowledgeGraphSource (v79). When provided,
   *                       analyze() and route() fetch real KG signals and merge
   *                       them with any input signals before mapping.
   */
  constructor(
    policies: GuardPolicy[],
    auditStore?: AuditStore,
    passportOpts: PassportIssuanceOptions = {},
    agentSourceId = "PotentialEngine",
    kgSource?: KnowledgeGraphSource,
  ) {
    this.orchestrator = new TfaOrchestrator(policies, auditStore);
    this.mapper = new StrengthMapper();
    this.router = new OpportunityRouter();
    this.passportOpts = passportOpts;
    this.agentSourceId = agentSourceId;
    this.kgSource = kgSource;
  }

  /** Direct access to the audit store for inspection, proofs, and chain verification. */
  get audit(): AuditStore {
    return this.orchestrator.audit;
  }

  // ── Passport issuance (auto, on every successful operation) ────────────────

  /**
   * Issue an ActionPassport for a successful operation, if a signer is configured.
   * Returns null when no signer is wired (backward compat).
   */
  private maybeIssuePassport(
    tenantId: string,
    auditId: string,
  ): ActionPassport | null {
    const { signer, identityStore, onPassport } = this.passportOpts;
    if (!signer) return null;
    const passport = issuePassport({
      auditId,
      auditStore: this.orchestrator.audit,
      signer,
      identityStore,
      expectedTenantId: tenantId,
    });
    if (onPassport) onPassport(passport);
    return passport;
  }

  // ── Input enrichment ───────────────────────────────────────────────────────

  /**
   * Merge input signals with signals fetched from the real Knowledge Graph source.
   * If no kgSource is configured, returns the input unchanged (backward compat).
   * The StrengthMapper will filter by (userId, tenantId) downstream.
   *
   * Generic over T so RoutingInput (which adds `opportunities`) is preserved
   * when called from route() — fixing a type regression introduced in v79.
   */
  private async enrichInput<T extends AnalysisInput>(input: T): Promise<T> {
    if (!this.kgSource) return input;
    const kgSignals = await this.kgSource.fetchSignals(input.userId, input.tenantId);
    return {
      ...input,
      knowledgeSignals: [...input.knowledgeSignals, ...kgSignals],
    };
  }

  // ── Core engine operations ─────────────────────────────────────────────────

  /**
   * Analyze a user's strengths from Knowledge Graph and Analytics signals.
   *
   * Runs through TfaOrchestrator: guard → StrengthMapper.map() → audit.
   * Fail-closed: requires at least one guard policy (isAutonomous = true).
   *
   * Phase C: if a signer is wired, the result carries a signed ActionPassport.
   *
   * v79: When a KnowledgeGraphSource is configured, real KG signals are fetched
   * and merged with input signals before mapping.
   *
   * The StrengthMapper filters signals by (userId, tenantId) before computation —
   * cross-tenant signals are silently discarded.
   */
  async analyze(input: AnalysisInput): Promise<PotentialEngineResult<StrengthProfile>> {
    const enriched = await this.enrichInput(input);
    const action = {
      id: randomUUID(),
      tenantId: enriched.tenantId,
      type: "potential.analyze",
      payload: enriched,
      source: this.agentSourceId,
      isFinancial: false,
      isAutonomous: true,
      requestedAt: new Date().toISOString(),
    };

    const orchResult = await this.orchestrator.run(action, async (a) => {
      return this.mapper.map(a.payload);
    });

    if (orchResult.ok) {
      const passport = this.maybeIssuePassport(enriched.tenantId, orchResult.auditId);
      const out: PotentialEngineResult<StrengthProfile> = {
        ok: true,
        result: orchResult.result,
        auditId: orchResult.auditId,
      };
      if (passport) out.passport = passport;
      return out;
    }
    return { ok: false, reason: orchResult.reason, auditId: orchResult.auditId };
  }

  /**
   * Route a user to matching opportunities based on their strength profile.
   *
   * Runs through TfaOrchestrator: guard → analyze + match → audit.
   * Fail-closed: requires at least one guard policy (isAutonomous = true).
   *
   * Phase C: if a signer is wired, the result carries a signed ActionPassport.
   *
   * v79: When a KnowledgeGraphSource is configured, real KG signals are fetched
   * and merged with input signals before mapping.
   *
   * The router filters opportunities by tenantId — cross-tenant opportunities
   * are silently discarded.
   */
  async route(input: RoutingInput): Promise<PotentialEngineResult<RoutingDecision>> {
    const enriched = await this.enrichInput(input);
    const action = {
      id: randomUUID(),
      tenantId: enriched.tenantId,
      type: "potential.route",
      payload: enriched,
      source: this.agentSourceId,
      isFinancial: false,
      isAutonomous: true,
      requestedAt: new Date().toISOString(),
    };

    const orchResult = await this.orchestrator.run(action, async (a) => {
      const profile = this.mapper.map(a.payload);
      const matches = this.router.route(profile, a.payload.opportunities);
      const decision: RoutingDecision = {
        userId: a.payload.userId,
        tenantId: a.payload.tenantId,
        profile,
        matches,
        decidedAt: new Date().toISOString(),
      };
      return decision;
    });

    if (orchResult.ok) {
      const passport = this.maybeIssuePassport(enriched.tenantId, orchResult.auditId);
      const out: PotentialEngineResult<RoutingDecision> = {
        ok: true,
        result: orchResult.result,
        auditId: orchResult.auditId,
      };
      if (passport) out.passport = passport;
      return out;
    }
    return { ok: false, reason: orchResult.reason, auditId: orchResult.auditId };
  }
}
