/**
 * kernel.ts — רושפינה קרנל: סינגלטון-הפלטפורמה מעל "TFA Sovereign Trust-as-a-Service".
 *
 * מרכיב את כל-מודולי-הקרנל לעץ-אחד (zero-dependency כלכלה ריבונית):
 *
 *   Ed25519Signer        — חתימת-ביקורת + דרכוני-פעולה (Ed25519, kid ציבורי)
 *   InMemoryAuditStore   — שרשרת-ביקורת hash-linked חתומה, פר-טננט
 *   TfaOrchestrator      — עמוד-השדרה: guard (fail-closed) → execute → audit
 *   InMemoryLedger       — ספר כפול-כניסה, BigInt µ¢
 *   LedgerOrchestrator   — שער-יחיד לכל-פעולה פיננסית + הנפקת-דרכון אוטומטית
 *   EscrowService        — ההצבה: created→funded→released/refunded/disputed + דמי-תיאום 5%
 *   InMemoryTransparencyLog — יומן-שקיפות מרקל (שורשים תקופתיים)
 *   KeyRing              — רישום-מפתחות אימות (kid → key) לדרכונים ניידים
 *   PotentialEngine      — אינטליגנציה: חוזקות → הזדמנויות (דרך האורקסטרטור)
 *   InMemoryOpportunityCatalog — קטלוג-הזדמנויות פר-טננט
 *
 * הכל נבנה בעצלתיים (lazy) ונשמר על globalThis עם Symbol.for — שורד HMR.
 * מדיניות-ה-guard: allowAll + spend-budget (fail-closed עם תקציב מוגדר).
 */

import { InMemoryLedger } from "@kernel/ledger/in-memory-ledger";
import type { Account } from "@kernel/ledger/types";
import { LedgerOrchestrator } from "@kernel/ledger-orchestrator/ledger-orchestrator";
import { TfaOrchestrator } from "@kernel/orchestrator/orchestrator";
import { allowAll } from "@kernel/orchestrator/guard";
import { InMemoryAuditStore } from "@kernel/orchestrator/audit";
import { Ed25519Signer, generateAuditKeyPair } from "@kernel/orchestrator/signer";
import { EscrowService, InMemoryEscrowStore } from "@kernel/escrow/escrow";
import type { EscrowAgreement } from "@kernel/escrow/types";
import { InMemoryTransparencyLog } from "@kernel/transparency-log/receipt-anchor";
import { KeyRing } from "@kernel/passport/key-ring";
import type { ActionPassport } from "@kernel/passport/types";
import { PotentialEngine } from "@kernel/potential/potential-engine";
import { InMemoryKnowledgeGraphSource } from "@kernel/potential/in-memory-kg-source";
import { InMemoryOpportunityCatalog } from "@kernel/marketplace/catalog";
import { SpendBudgetGuard } from "@kernel/policy/spend-budget-guard";
import { spendBudgetPolicy } from "@kernel/policy/spend-budget-policy";
import type { VendorQuote } from "@kernel/marketplace/cost-arbitrage";

/** הטננט הריבוני של רושפינה. */
export const TENANT = "roshpina";

/** דמי-התיאום של הפלטפורמה — מנוע-הרווח על כל-שחרור הצבה (500bps = 5%). */
export const PLATFORM_FEE_BASIS_POINTS = 500;

/** מערך-ציטוטי-ספק להזדמנות (לארביטראז'-עלויות של השוק). */
export type VendorQuotes = Map<string, VendorQuote[]>;

/** רישום-חשבונות הזרע — מזהי-החשבונות הקבועים שהפלטפורמה יודעת לזהות. */
export interface AccountRegistry {
  treasuryId: string;
  workerIds: Record<string, string>; // worker-ada | worker-bron | worker-cyber
  clientIds: Record<string, string>; // client-x | client-y
}

/** תוצר-ניתוח-הפוטנציאל המצטבר (נבנה בזריעה; GET קורא בלבד). */
export interface PotentialSnapshot {
  generatedAt: string;
  workers: Array<{
    userId: string;
    displayName: string;
    strengths: Array<{ category: string; score: number; confidence: number; evidence: string[] }>;
    matches: Array<{
      opportunityId: string;
      title: string;
      fitScore: number;
      matchedStrengths: string[];
      missingStrengths: Array<{ category: string; gap: number }>;
      budgetMc: bigint | null;
    }>;
  }>;
}

/** תמונת-המצב של הזריעה (ל-/api/health). */
export interface SeedState {
  seeded: boolean;
  seededAt: string | null;
}

export interface RoshpinaKernel {
  bootedAt: number;
  signer: Ed25519Signer;
  publicKeyPem: string;
  audit: InMemoryAuditStore;
  orchestrator: TfaOrchestrator;
  spendBudget: SpendBudgetGuard;
  ledger: InMemoryLedger;
  ledgerOrch: LedgerOrchestrator;
  escrow: EscrowService;
  escrowStore: InMemoryEscrowStore;
  transparency: InMemoryTransparencyLog;
  keyRing: KeyRing;
  potential: PotentialEngine;
  kgSource: InMemoryKnowledgeGraphSource;
  catalog: InMemoryOpportunityCatalog;
  /** דרכוני-פעולה שהונפקו (hook — חיץ-מקסימלי). */
  passports: ActionPassport[];
  /** ציטוטי-ספק להזדמנויות (ארביטראז'-עלויות). */
  vendorQuotes: VendorQuotes;
  registry: AccountRegistry;
  potentialSnapshot: PotentialSnapshot | null;
  seedState: SeedState;
}

const KERNEL_KEY = Symbol.for("roshpina.kernel.v1");
const PASSPORT_CAP = 400;

function buildKernel(): RoshpinaKernel {
  const bootedAt = Date.now();

  // ── זהות קריפטוגרפית: זוג-מפתחות Ed25519 לחתימת-ביקורת ודרכונים ───────────
  const pair = generateAuditKeyPair();
  const signer = new Ed25519Signer(pair.privateKey, pair.publicKey);

  // ── ביקורת: שרשרת hash-linked חתומה (פר-טננט) ────────────────────────────
  const audit = new InMemoryAuditStore(signer);

  // ── Guard: fail-closed — allowAll בסיסי + מגבלת-הוצל"פ מצטברת ──────────────
  // התקציב גדול-במכוון אך קיים: כל-פעולה פיננסית נבדקת ומוקלדת (commit) בהצלחה.
  const spendBudget = new SpendBudgetGuard();
  spendBudget.setBudget(TENANT, {
    limitMicroCents: 1_000_000_000_000_000n, // ₪1,000,000,000 בחלון
    windowMs: 24 * 60 * 60 * 1000,
  });
  const orchestrator = new TfaOrchestrator(
    [allowAll("roshpina-console"), spendBudgetPolicy(spendBudget, { requireBudget: true })],
    audit,
    signer,
    undefined,
    undefined,
    spendBudget,
  );

  // ── ספר + שער-פיננסי עם הנפקת-דרכון אוטומטית ──────────────────────────────
  const ledger = new InMemoryLedger();
  const passports: ActionPassport[] = [];
  const ledgerOrch = new LedgerOrchestrator(ledger, orchestrator, {
    signer,
    onPassport: (p) => {
      passports.push(p);
      if (passports.length > PASSPORT_CAP) {
        passports.splice(0, passports.length - PASSPORT_CAP);
      }
    },
  });

  // ── ההצבה: חנות-בעלות שלנו (כדי ש-GET יוכל לרשום) + דמי-תיאום 5% ───────────
  const escrowStore = new InMemoryEscrowStore();
  const escrow = new EscrowService(ledgerOrch, escrowStore, undefined, {
    basisPoints: PLATFORM_FEE_BASIS_POINTS,
  });

  // ── שקיפות: יומן-מרקל (שורש כל-4 עלים — נבנה כבר-בזריעה) ──────────────────
  const transparency = new InMemoryTransparencyLog(4);

  // ── KeyRing: מפתח-הקרנל רשום לאימות-דרכונים ניידים (kid → key) ────────────
  const keyRing = new KeyRing();
  keyRing.register({
    kid: signer.kid,
    algorithm: "ed25519",
    publicKey: pair.publicKey,
    status: "active",
    createdAt: new Date().toISOString(),
  });

  // ── אינטליגנציה: מנוע-פוטנציאל דרך האורקסטרטור (autonomous — fail-closed) ──
  const kgSource = new InMemoryKnowledgeGraphSource();
  const catalog = new InMemoryOpportunityCatalog();
  const potential = new PotentialEngine(
    [allowAll("roshpina-potential")],
    audit,
    {
      signer,
      onPassport: (p) => {
        passports.push(p);
        if (passports.length > PASSPORT_CAP) {
          passports.splice(0, passports.length - PASSPORT_CAP);
        }
      },
    },
    "roshpina-potential-engine",
    kgSource,
  );

  return {
    bootedAt,
    signer,
    publicKeyPem: pair.publicKey,
    audit,
    orchestrator,
    spendBudget,
    ledger,
    ledgerOrch,
    escrow,
    escrowStore,
    transparency,
    keyRing,
    potential,
    kgSource,
    catalog,
    passports,
    vendorQuotes: new Map<string, VendorQuote[]>(),
    registry: { treasuryId: "", workerIds: {}, clientIds: {} },
    potentialSnapshot: null,
    seedState: { seeded: false, seededAt: null },
  };
}

/** גישה עצלה לסינגלטון — בטוח ל-HMR (Symbol.for על globalThis). */
export function getKernel(): RoshpinaKernel {
  const g = globalThis as unknown as { [KERNEL_KEY]?: RoshpinaKernel };
  if (!g[KERNEL_KEY]) g[KERNEL_KEY] = buildKernel();
  return g[KERNEL_KEY];
}

/** עזר: שליפת-חשבון לפי-מזהה מתוך הטננט. */
export async function getAccount(accountId: string): Promise<Account | null> {
  try {
    return await getKernel().ledger.getAccount(TENANT, accountId);
  } catch {
    return null;
  }
}

/** עזר: רשימת-הסכמי-ההצבה של הטננט. */
export async function listAgreements(): Promise<EscrowAgreement[]> {
  return getKernel().escrowStore.list(TENANT);
}
