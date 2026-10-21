# CHANNEL-AUDIT 2026-10-21 — AutoHedge + agency-agents (R43)

Trace: 1a15cbc35c98d5b9 · Lane: agent4/p2-sovereign-market · Auditor: agent-4

Operator directive (verbatim anchors): "תבחן כיצד ומה נוכל לנצל מפה … בחן את אלו ונצל מה
שניתן בהתאמה לריבונות האוטונומית שלנו שיביא לנו ערך ככל הניתן בחן תכנן בצע דחוף
github.com/The-Swarm-Corporation/AutoHedge · https://github.com/msitarzewski/agency-agents"

Method (R43): both repos cloned and read from source at
`/home/z/my-project/third-party/{AutoHedge,agency-agents}` — primary evidence, no README-trust.

---

## 1. The-Swarm-Corporation/AutoHedge (Python, 633 LOC core)

**What it actually is (measured from `autohedge/main.py`, `workers.py`, `prompts.py`):**
an autonomous hedge-fund pipeline — Director → {Sentiment, Quant, Risk, Execution} —
with structured outputs: quant = technical/volume/trend scores (0-1) + key levels;
risk = position size, max drawdown, exposure, risk score; execution = order type,
quantity, entry/stop/TP, TIF. Risk-first: no order without a risk verdict.

**ADOPT (channeled natively — zero new deps, by R43):**
- **A1 — four-gate discipline** (thesis → quant → risk → execution) recorded as the
  mandatory review lens for ANY future change to desk parameters (span/step/levels).
  A change proposal must carry: direction, confidence, invalidation condition,
  risk verdict, kill criteria — the AutoHedge schema, in TS types, enforced by review.
- **A2 — risk-first ordering is now explicit law for the market lane**: no desk
  mutation without a risk verdict (max inventory %, drawdown halt, kill switch).
- **A3 — structured-JSON outputs** for council decisions (sovereign-decisions already
  journal JSON; the AutoHedge field names are adopted for money-path decisions).

**REJECT:**
- Python/`swarms` runtime (zero-new-deps law; our rails are Bun/TS).
- LLM in the money path (gpt-4.1 agents issuing orders) — money gates stay deterministic.
- Solana/Jupiter venue — our venue is :3033; SAOS is sovereign.

**DEFER (designed here, implemented as its own golden-tested unit):**
- **D1 — strategy-tuner**: deterministic thesis-gated adaptation of mm-grid parameters
  from venue prints + vol-regime (AutoHedge's loop, minus the LLM): quant scores from
  our own EMA/prints bus, risk gate from inventory caps, execution via existing desk
  config with kill switch + invalidation auto-revert. Not built this unit — the money
  unit went to the ×10,000 settlement defect (below); building a tuner on top of a
  just-healed book the same hour would violate fail-closed judgment.

## 2. msitarzewski/agency-agents (markdown role roster, 81 personas + divisions.json)

**What it actually is:** a curated roster of agent role cards (frontmatter + identity +
mission + critical rules), organized in divisions (finance, security, strategy…).

**ADOPT (4 cards adapted natively to `sovereignty/roles/`):**
Each card is stripped of persona theater and bound to REAL owner assets + a verdict
command — a role here is something the network can actually execute and audit:
- `risk-manager.md` → owns capability-audit verdicts + era-correction acknowledgment.
- `blockchain-security-auditor.md` → owns secrets-gate verdicts + R11 sweep.
- `incident-responder.md` → owns watchdog/resume-money/start-nodes runbooks (proven live).
- `compliance-auditor.md` → owns chain-audit + channel-audit cadence (this document).
- Registry: `sovereignty/roles/registry.json` — wired into owner-memory (councilRoles).

**REJECT:**
- Installing the full 81-roster (noise > signal; every role must own a measurable asset).
- The desktop app / installers (outside our rails).

## 3. Sibling alignment (the operator's "שניישר קו ושלא יהיו חסימות מיותרות")

- ls-remote: only `agent4/*` branches + `main` + estate-daily tags exist — NO sibling
  lane branches to collide with; worklog scanned: latest sibling entries predate Task 41.
- Reserved names documented in LIQUIDITY-DESK-2026-10-21.md (mm-*) remain ours.
- Block audit (activate-everything directive): all 20 schedules armed & enabled; the 3
  "failed" were (a) ledger-sync crash-loop — ROOT-CAUSED AND FIXED this unit, (b)
  ai-sentinel/ai-architect — provider-side 503/404 (nano rate-limit + dead super),
  transient, fail-closed held. No self-imposed unnecessary blocks found: every gate
  that remains (quiesce, vault-seal, secrets-gate, 25% era guard) is a proven
  safety property, documented as such — none removed.

## 4. THE UNIT'S REAL WORK — the ×10,000 settlement defect (found, fixed, proven)

The desks' fresh zero-mirrors unmasked a latent unit bug: the market reports RAW µ¢
integers ("49995100") while ledger-sync parsed them as decimal USDS (parseMicroCents)
→ ×10,000 inflation of every delta. Both sides inflated identically = self-hiding for
eras; the fee delta finally outran the pool (feeDelta +14,431 USDS vs pool 13,897) →
INSUFFICIENT_FUNDS crash-loop since 04:23 (3 schedules red).

Fix (this unit): `lib-ledger-sync.ts` (pure: parseMarketMicroCents + computeDeltas +
planSettlements with floor law) + ledger-sync rewired + laws 6/7 in the header.
Golden: **15/15** (incl. the exact 04:23 crash scenario — now caps and drifts, never
crashes). Live run: 25 settles, round 2 converged ("הספר משקף את השוק במדויק"), era
corrections wrote down 332,882.44 USDS + 486,568.72 SAOS dead-era backing (operator-
signed per R45 standing approval), pool=0 both currencies, steady-state re-run = 0
transfers exit 0, chain-audit green (1,047 records, head 285a23b9…).

Honest residue: the mirrors' historical ×10,000 scale means PAST ledger displays were
inflated units — the book now speaks true µ¢ 1:1 with the market; conservation is
exact (verified by the sync's final-verification block, drift=none).
