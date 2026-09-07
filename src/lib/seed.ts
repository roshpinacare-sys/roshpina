/**
 * seed.ts — זריעה אידמפוטנטית של עולם-רושפינה.
 *
 * נקראת מ-src/instrumentation.ts בהרצת-השרת (ובפועל גם מ-POST handlers כשכבת-הגנה —
 * הקריאה זולה ואידמפוטנטית לאחר-הזריעה). נעולה עם Promise על globalThis כדי
 * שקריאות-מקבילות לא יזרעו פעמיים.
 *
 * מה נזרע:
 *   • חשבונות: אוצר + 3 עובדים + 2 לקוחות (מזהים יציבים ב-registry)
 *   • הנפקות-אשראי דרך האורקסטרטור (100 מיליארד µ¢ לאוצר, 10 מיליארד לכל-לקוח)
 *     → כל-הנפקה מייצרת רשומת-ביקורת חתומה + דרכון-פעולה
 *   • 4 מחזורי-הצבה: 2 released (עם לכידת-עמלה 5%), 1 disputed, 1 funded-open
 *   • 4 הזדמנויות שוק + ציטוטי-ספק לארביטראז'-עלויות
 *   • עלים ביומן-השקיפות (מרקל) + finalize לשורש ראשון
 *   • תמונת-מצב של מנוע-הפוטנציאל (ניתוח חד-פעמי; GET יקרא אותה בלבד)
 */

import {
  getKernel,
  TENANT,
  type PotentialSnapshot,
} from "./kernel";
import type { Opportunity } from "@kernel/potential/types";

const SEED_PROMISE_KEY = Symbol.for("roshpina.seed-promise.v1");

/** מבטיח זריעה בודדת — אידמפוטנטי, בטוח לקריאות-מקבילות ול-HMR. */
export async function ensureSeed(): Promise<void> {
  const k = getKernel();
  if (k.seedState.seeded) return;
  const g = globalThis as unknown as { [SEED_PROMISE_KEY]?: Promise<void> };
  if (!g[SEED_PROMISE_KEY]) {
    g[SEED_PROMISE_KEY] = doSeed().catch((err) => {
      // נכשל? נאפשר ניסיון-חוזה בקריאה הבאה.
      g[SEED_PROMISE_KEY] = undefined;
      throw err;
    });
  }
  await g[SEED_PROMISE_KEY];
}

async function doSeed(): Promise<void> {
  const k = getKernel();
  const T = TENANT;
  const mint = async (accountId: string, amount: bigint, memo: string) => {
    const res = await k.ledgerOrch.mint(T, accountId, amount, memo, "seed-operator");
    if (!res.ok) throw new Error(`seed mint failed: ${res.reason}`);
  };

  // ── 1. חשבונות ────────────────────────────────────────────────────────────
  const treasury = await k.ledgerOrch.createAccount(T, "platform", "asset", "אוצר רושפינה");
  const workerAda = await k.ledgerOrch.createAccount(T, "worker-ada", "asset", "עדה · קוד ותשתיות");
  const workerBron = await k.ledgerOrch.createAccount(T, "worker-bron", "asset", "ברון · עיצוב ותוכן");
  const workerCyber = await k.ledgerOrch.createAccount(T, "worker-cyber", "asset", "סייבר · אבטחה וניתוח");
  const clientX = await k.ledgerOrch.createAccount(T, "client-x", "asset", "לקוח X");
  const clientY = await k.ledgerOrch.createAccount(T, "client-y", "asset", "לקוח Y");

  k.registry.treasuryId = treasury.id;
  k.registry.workerIds = {
    "worker-ada": workerAda.id,
    "worker-bron": workerBron.id,
    "worker-cyber": workerCyber.id,
  };
  k.registry.clientIds = {
    "client-x": clientX.id,
    "client-y": clientY.id,
  };

  // ── 2. הנפקות דרך האורקסטרטור (guard→execute→audit→passport) ─────────────
  await mint(treasury.id, 100_000_000_000n, "הונא-פתיחה של האוצר הריבוני");
  await mint(clientX.id, 10_000_000_000n, "מטבע-פתיחה ללקוח X");
  await mint(clientY.id, 10_000_000_000n, "מטבע-פתיחה ללקוח Y");

  // ── 3. מחזורי-הצבה ───────────────────────────────────────────────────────
  // E1: client-x → worker-ada · מומנה ושוחררה (עמלה 5% נלכדת לחשבון-פלטפורמה)
  const e1 = await k.escrow.create({
    tenantId: T, opportunityId: "opp-website",
    payerAccountId: clientX.id, workerAccountId: workerAda.id,
    amount: 5_000_000_000n,
  });
  await k.escrow.fund(T, e1.id, "client-x");
  await k.escrow.release(T, e1.id, "client-x", {
    workerId: "worker-ada",
    statement: "האתר הושלם ונמסר לפי-מפרט",
    attestedAt: new Date().toISOString(),
    signature: "seed-attestation-e1",
    algorithm: "seed",
  });

  // E2: client-x → worker-bron · מומנה ושוחררה
  const e2 = await k.escrow.create({
    tenantId: T, opportunityId: "opp-logo",
    payerAccountId: clientX.id, workerAccountId: workerBron.id,
    amount: 2_500_000_000n,
  });
  await k.escrow.fund(T, e2.id, "client-x");
  await k.escrow.release(T, e2.id, "client-x", {
    workerId: "worker-bron",
    statement: "זהות ויזואלית נמסרה ואושרה",
    attestedAt: new Date().toISOString(),
    signature: "seed-attestation-e2",
    algorithm: "seed",
  });

  // E3: client-y → worker-cyber · מומנה ונתונה במחלוקת (הכסף קפוא — לא זז)
  const e3 = await k.escrow.create({
    tenantId: T, opportunityId: "opp-audit",
    payerAccountId: clientY.id, workerAccountId: workerCyber.id,
    amount: 8_000_000_000n,
  });
  await k.escrow.fund(T, e3.id, "client-y");
  await k.escrow.dispute(T, e3.id, "worker-cyber", "היקף-העבודה אינו ברור — ממתין לבוררות");

  // E4: client-y → worker-ada · מומנה ופתוחה (ממתינה להשלמת-עבודה)
  const e4 = await k.escrow.create({
    tenantId: T, opportunityId: "opp-data",
    payerAccountId: clientY.id, workerAccountId: workerAda.id,
    amount: 1_500_000_000n,
  });
  await k.escrow.fund(T, e4.id, "client-y");

  // ── 4. שוק: הזדמנויות + ציטוטי-ספק (ארביטראז'-עלויות) ────────────────────
  const opportunities: Opportunity[] = [
    {
      id: "opp-website", tenantId: T, title: "פיתוח אתר-תדמית",
      description: "אתר-תדמית רספונסיבי עם מערכת-תוכן קלה.",
      requiredStrengths: [{ category: "technical", minScore: 60 }],
      budget: 6_000_000_000n,
    },
    {
      id: "opp-logo", tenantId: T, title: "עיצוב זהות ולוגו",
      description: "זהות-ויזואלית מלאה: לוגו, פלטה וטיפוגרפיה.",
      requiredStrengths: [{ category: "creative", minScore: 55 }],
      budget: 2_000_000_000n,
    },
    {
      id: "opp-audit", tenantId: T, title: "סקירת-אבטחה שנתית",
      description: "סקירת-חוסן לתשתית: דוח סיכונים ותוכנית-תיקון.",
      requiredStrengths: [{ category: "security", minScore: 65 }],
      budget: 9_000_000_000n,
    },
    {
      id: "opp-data", tenantId: T, title: "ניתוח-נתונים ודוחות",
      description: "דוחות-שוטפים ותובנות מניב-הנתונים של הפלטפורמה.",
      requiredStrengths: [{ category: "analytical", minScore: 60 }],
      budget: 4_500_000_000n,
    },
  ];
  for (const opp of opportunities) {
    await k.catalog.create(opp);
  }
  k.vendorQuotes.set("opp-website", [
    { vendorId: "vendor-agile", estimatedCostMc: 5_400_000_000n },
    { vendorId: "vendor-nova", estimatedCostMc: 6_100_000_000n },
    { vendorId: "vendor-zoom", estimatedCostMc: 6_800_000_000n },
  ]);
  k.vendorQuotes.set("opp-logo", [
    { vendorId: "vendor-ink", estimatedCostMc: 1_600_000_000n },
    { vendorId: "vendor-art", estimatedCostMc: 2_100_000_000n },
  ]);
  k.vendorQuotes.set("opp-audit", [
    { vendorId: "vendor-shield", estimatedCostMc: 7_800_000_000n },
    { vendorId: "vendor-guard", estimatedCostMc: 9_200_000_000n },
    { vendorId: "vendor-lock", estimatedCostMc: 9_900_000_000n },
  ]);
  k.vendorQuotes.set("opp-data", [
    { vendorId: "vendor-pivot", estimatedCostMc: 4_100_000_000n },
    { vendorId: "vendor-chart", estimatedCostMc: 4_350_000_000n },
  ]);

  // ── 5. יומן-שקיפות: עיגון זנב-שרשרת-הביקורת כעלי-מרקל + שורש ראשון ────────
  const chain = k.audit.getChain(T);
  const tail = chain.slice(-8);
  for (const rec of tail) {
    await k.transparency.appendAuditRecord(T, rec);
  }
  await k.transparency.finalize(T);

  // ── 6. פוטנציאל: אותות-ידע לעובדים + ניתוח/ניתוב חד-פעמי ─────────────────
  const kg = [
    { userId: "worker-ada", nodeType: "skill", category: "technical", weight: 0.95 },
    { userId: "worker-ada", nodeType: "achievement", category: "technical", weight: 0.9 },
    { userId: "worker-ada", nodeType: "project", category: "analytical", weight: 0.8 },
    { userId: "worker-bron", nodeType: "skill", category: "creative", weight: 0.92 },
    { userId: "worker-bron", nodeType: "project", category: "creative", weight: 0.85 },
    { userId: "worker-bron", nodeType: "skill", category: "technical", weight: 0.5 },
    { userId: "worker-cyber", nodeType: "skill", category: "security", weight: 0.9 },
    { userId: "worker-cyber", nodeType: "achievement", category: "security", weight: 0.85 },
    { userId: "worker-cyber", nodeType: "skill", category: "analytical", weight: 0.82 },
  ];
  for (const s of kg) {
    k.kgSource.addSignal({ userId: s.userId, tenantId: T, nodeType: s.nodeType, category: s.category, weight: s.weight });
  }

  const workerDefs: Array<{ userId: string; displayName: string; analytics: Array<{ eventType: string; category: string; value: number }> }> = [
    { userId: "worker-ada", displayName: "עדה", analytics: [{ eventType: "task.completed", category: "technical", value: 0.9 }] },
    { userId: "worker-bron", displayName: "ברון", analytics: [{ eventType: "task.completed", category: "creative", value: 0.88 }] },
    { userId: "worker-cyber", displayName: "סייבר", analytics: [{ eventType: "workflow.run", category: "security", value: 0.86 }] },
  ];

  const catalogList = await k.catalog.list(T);
  const snapshot: PotentialSnapshot = { generatedAt: new Date().toISOString(), workers: [] };

  for (const w of workerDefs) {
    const analysis = await k.potential.analyze({
      userId: w.userId, tenantId: T, knowledgeSignals: [], analyticsSignals:
        w.analytics.map((a) => ({ userId: w.userId, tenantId: T, eventType: a.eventType, category: a.category, value: a.value })),
    });
    if (!analysis.ok) throw new Error(`seed potential.analyze failed: ${analysis.reason}`);
    const routing = await k.potential.route({
      userId: w.userId, tenantId: T, knowledgeSignals: [], analyticsSignals: [],
      opportunities: catalogList,
    });
    if (!routing.ok) throw new Error(`seed potential.route failed: ${routing.reason}`);

    snapshot.workers.push({
      userId: w.userId,
      displayName: w.displayName,
      strengths: routing.result.profile.strengths.map((s) => ({
        category: s.category, score: s.score, confidence: s.confidence, evidence: s.evidence,
      })),
      matches: routing.result.matches.map((m) => ({
        opportunityId: m.opportunity.id,
        title: m.opportunity.title,
        fitScore: m.fitScore,
        matchedStrengths: [...m.matchedStrengths],
        missingStrengths: m.missingStrengths.map((ms) => ({ category: ms.category, gap: ms.gap })),
        budgetMc: m.opportunity.budget ?? null,
      })),
    });
  }
  k.potentialSnapshot = snapshot;

  k.seedState = { seeded: true, seededAt: new Date().toISOString() };
}
