/**
 * kernel/market/repair-plan.ts — Task 30: the historical-damage repair plan.
 *
 * טהור: יומנים + מצב-חשבונות חי בקלט → תוכנית בפלט. אפס-כתיבה.
 *
 * עקרונות:
 *  1. הראיה המחייבת היא הרגליים בספרי-הכסף (usds/saos) — לא פרמטרי-intent.
 *  2. Rescission ל-fill שלא נמסר: המוכר מחזיר את רגל-q בפועל שקיבל, הפלטפורמה
 *     מחזירה את ה-fee בפועל. אפס-מנטה — שימור-מלא, תיקון-חוזי נקי.
 *  3. Overcharge (באג 20) רק עם replay תואם לחוק (ישן/חדש) ועל fill שנמסר
 *     במלואו (על fill שלא נמסר — העודף כבר בתוך ה-rescission).
 *  4. Pool-drain (באג 19a): taker-sell שרגל-ה-b שלו חויבה את המכסה-המשותפת —
 *     המוכר מחזיר את הכמות ל-escrow-base.
 *  5. Over-refund (באג 18): סכום-ההחזרים לזמנה מעל פקדונה — המופקד מחזיר
 *     ל-escrow-quote.
 *  6. ראיה לא-חד-משמעית = אנומליה מתועדת, אפס-תזוזת-כסף (fail-closed).
 *  7. סימולציה-סדרתית: payable = min(owed − paid, יתרה-רצה) — התוכנית אף-פעם
 *     לא דורשת יותר ממה שיש; היתרה הרצה מקבלת גם קבלות בדרך.
 *  8. idem דטרמיניסטי לכל-רגל (repair:<kind>:<ref>) — ריצה-חוזרת היא no-op
 *     מדויק; ה-paid נסרק מהיומן ומופחת מהחוב.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Js = Record<string, unknown>;

export interface LiveAccount { id: string; name: string; balance: string }

export interface RepairPlanInput {
  dataDir: string;
  usdsAccounts: LiveAccount[];
  saosAccounts: LiveAccount[];
}

export type RepairAction = {
  kind: "rescind-q" | "rescind-fee" | "overcharge" | "pooldrain" | "overrefund";
  idem: string;
  ledger: "usds" | "saos";
  debitName: string;
  creditName: string;
  owed: string;      // חוב-ראיה נטו (אחרי-ניכוי-ששולם-כבר)
  payable: string;   // min(owed, יתרה-רצה) — הסימולציה הסדרתית
  shortfall: string; // owed − payable
  ref: string;       // tradeId או orderId
  memo: string;
};

export interface RepairPlan {
  planSha256: string;
  generatedAt: string;
  actions: RepairAction[];
  summary: { kind: string; count: number; owed: string; payable: string; shortfall: string }[];
  anomalies: string[];
  scope: { distinctTrades: number; refunds: number; unsettledTrades: number };
}

const num = (v: unknown): bigint => BigInt(String(v ?? "0"));
const recOf = (env: Js): Js => (env.rec as Js) ?? env;
const idemOf = (env: Js): string => String(env.idemKey ?? recOf(env).idemKey ?? "");
const txOf = (env: Js): Js => ((recOf(env).tx as Js) ?? {});

function readJsonl(p: string): Js[] {
  const raw = readFileSync(p, "utf8");
  const out: Js[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as Js);
    } catch {
      out.push({ t: "__PARSE_ERROR__", line: s.slice(0, 120) });
    }
  }
  return out;
}

const tradeNo = (tradeId: string): number => {
  const m = /^trade-(\d+)$/.exec(tradeId);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

export function computeHistoricalRepairPlan(input: RepairPlanInput): RepairPlan {
  const { dataDir } = input;

  // ── מפות-חשבונות חיות (id→name; יתרות לפי שם) ──────────────────────────────
  const qName = new Map<string, string>();
  const bName = new Map<string, string>();
  const usdsBal = new Map<string, bigint>();
  const saosBal = new Map<string, bigint>();
  for (const a of input.usdsAccounts) {
    qName.set(a.id, a.name);
    usdsBal.set(a.name, BigInt(a.balance));
  }
  for (const a of input.saosAccounts) {
    bName.set(a.id, a.name);
    saosBal.set(a.name, BigInt(a.balance));
  }
  const escrowQuoteId = [...qName.entries()].find(([, n]) => n === "market-escrow-quote")?.[0] ?? "";
  const escrowBaseId = [...bName.entries()].find(([, n]) => n === "market-escrow-base")?.[0] ?? "";
  const feeAccountId = [...qName.entries()].find(([, n]) => n === "platform-fee")?.[0] ?? "";

  // ── market journal: fills ──────────────────────────────────────────────────
  type Fill = {
    tradeId: string; price: bigint; amount: bigint; notional: bigint; remainder: bigint;
    makerId: string; takerId: string; side: string; seq: number;
  };
  const replaysByTrade = new Map<string, Fill[]>();
  const doneTrades = new Set<string>();
  let unsettledTrades = 0;
  for (const env of readJsonl(join(dataDir, "market", "journal.jsonl"))) {
    const r = recOf(env);
    const seq = Number(env.seq ?? 0);
    if (r.t === "trade_intent") {
      const f = r.fill as Js;
      const id = String(f.tradeId);
      const cand: Fill = {
        tradeId: id, price: num(f.price), amount: num(f.amount),
        notional: num(f.notional), remainder: num(f.remainder),
        makerId: String(f.makerId), takerId: String(f.takerId), side: String(f.side),
        seq,
      };
      const list = replaysByTrade.get(id) ?? [];
      list.push(cand);
      replaysByTrade.set(id, list);
    } else if (r.t === "trade_done") doneTrades.add(String(r.tradeId));
  }

  // ── ספרי-הכסף: רגליים + מנעולים + החזרים + מה-שכבר-שולם-בתיקון ──────────────
  type Leg = { amount: bigint; debit: string; credit: string };
  const qFee = new Map<string, Leg>();
  const qSettle = new Map<string, Leg>();
  const bDeliver = new Map<string, Leg>();
  const locks = new Map<string, bigint>();
  type Refund = { orderId: string; amount: bigint; credit: string };
  const refunds: Refund[] = [];
  const paid = new Map<string, bigint>(); // idem → amount (repair idems קיימים)
  const parseRefundIdem = (idem: string): string => {
    const rest = idem.slice("escrow-refund:".length);
    const parts = rest.split(":");
    if (parts.length >= 4 && /^\d{4}-\d{2}-\d{2}T/.test(parts[0])) return parts.slice(3).join(":") || parts[3];
    return rest;
  };
  for (const env of readJsonl(join(dataDir, "usds", "journal.jsonl"))) {
    const idem = idemOf(env); const tx = txOf(env);
    if (idem.startsWith("trade-")) {
      const leg: Leg = { amount: num(tx.amount), debit: String(tx.debitAccountId), credit: String(tx.creditAccountId) };
      if (idem.endsWith(":fee")) qFee.set(idem.slice(0, -4), leg);
      else if (idem.endsWith(":q")) qSettle.set(idem.slice(0, -2), leg);
    } else if (idem.startsWith("lock:")) {
      const oid = idem.slice(5);
      locks.set(oid, (locks.get(oid) ?? 0n) + num(tx.amount));
    } else if (idem.startsWith("escrow-refund:")) {
      refunds.push({ orderId: parseRefundIdem(idem), amount: num(tx.amount), credit: String(tx.creditAccountId) });
    } else if (idem.startsWith("repair:")) {
      paid.set(idem, (paid.get(idem) ?? 0n) + num(tx.amount));
    }
  }
  for (const env of readJsonl(join(dataDir, "saos", "journal.jsonl"))) {
    const idem = idemOf(env); const tx = txOf(env);
    if (idem.startsWith("trade-") && idem.endsWith(":b")) bDeliver.set(idem.slice(0, -2), { amount: num(tx.amount), debit: String(tx.debitAccountId), credit: String(tx.creditAccountId) });
    else if (idem.startsWith("repair:")) paid.set(idem, (paid.get(idem) ?? 0n) + num(tx.amount));
  }

  // סריקת-ששולם מודעת-גבול: הבסיס `repair:<kind>:<ref>` נספר במדויק + הניסיונות
  // `…:pN` (שאריות). ללא-גבול ה-'#', `trade-3` היה טוען לעצמו את תשלומי `trade-37`.
  const paidFor = (base: string): { total: bigint; attempts: number } => {
    let total = 0n; let attempts = 0;
    const bp = `${base}:`;
    for (const [k, v] of paid) {
      if (k === base || k.startsWith(bp)) { total += v; attempts++; }
    }
    return { total, attempts };
  };
  // idem דטרמיניסטי פר-ניסיון: הניסיון הראשון נושא את הבסיס הקנוני; כל-שארית
  // מקבלת `:pN` חדש — רגל-חלקית לא שורפת-את-ה-idem של השארית שלה.
  const attemptIdem = (base: string, attempts: number): string => (attempts === 0 ? base : `${base}:p${attempts}`);

  // ── ניתוח לכל-trade: דגלי-נזק + חובות-גולמיים ──────────────────────────────
  type Owed = {
    kind: RepairAction["kind"]; ref: string; ledger: "usds" | "saos";
    debitName: string; creditName: string; amount: bigint; memo: string;
  };
  const owedQ: Owed[] = [];   // rescind-q + overcharge (usds)
  const owedB: Owed[] = [];   // pooldrain (saos)
  const anomalies: string[] = [];
  for (const [tradeId, list] of [...replaysByTrade.entries()].sort((a, b) => tradeNo(a[0]) - tradeNo(b[0]) || a[0].localeCompare(b[0]))) {
    const fee = qFee.get(tradeId); const q = qSettle.get(tradeId); const b = bDeliver.get(tradeId);
    const charged = fee != null && q != null ? fee.amount + q.amount : null;
    if (fee == null && q == null && b == null) { unsettledTrades++; continue; }

    const conflicting = list.length > 1 && list.some((x) => x.price !== list[0].price || x.amount !== list[0].amount || x.notional !== list[0].notional || x.makerId !== list[0].makerId || x.takerId !== list[0].takerId || x.side !== list[0].side);
    let f = list[0];
    let matched = false;
    if (charged != null) {
      for (const cand of list) {
        const oldLaw = cand.notional + cand.remainder;
        const newLaw = cand.notional + (cand.remainder > 0n ? 1n : 0n);
        if ((charged === oldLaw || charged === newLaw) && (b == null || b.amount === cand.amount)) { f = cand; matched = true; break; }
      }
      if (!matched && b != null) {
        for (const cand of list) if (b.amount === cand.amount) { f = cand; matched = true; break; }
      }
    } else if (b != null) {
      for (const cand of list) if (b.amount === cand.amount) { f = cand; matched = true; break; }
    }
    if (conflicting && !matched) anomalies.push(`${tradeId}: replays סותרים (${list.length}) ללא-התאמה לרגליים`);

    const lawfulBuyerPays = f.notional + (f.remainder > 0n ? 1n : 0n);
    const buyer = f.side === "bid" ? f.takerId : f.makerId;
    const seller = f.side === "bid" ? f.makerId : f.takerId;
    const sellerQuoteName = `agent:${seller}:usds`;
    const sellerBaseName = `agent:${seller}:saos`;
    const buyerQuoteName = `agent:${buyer}:usds`;

    if (b == null && (fee != null || q != null)) {
      // Rescission מבוסס-רגליים — החזרת מה-שזרם-בפועל:
      //   הכסף ישב אצל המוכר (רגל-q זיכתה אותו) ואצל הפלטפורמה (fee) —
      //   החיוב הוא המחזיק-הנוכחי, הזיכוי הוא המשלם-המקורי (הקונה — גם כשהמקור
      //   היה המנעול שלו ב-escrow; המנעול מת, החזר-חייב להגיע לחשבון-החי שלו).
      if (q != null && q.amount > 0n) {
        const base = `repair:rescind-q:${tradeId}`;
        const pf = paidFor(base);
        owedQ.push({ kind: "rescind-q", ref: tradeId, ledger: "usds", debitName: sellerQuoteName, creditName: buyerQuoteName, amount: q.amount - pf.total, memo: `repair rescind-q ${tradeId}: seller refunds undelivered proceeds to buyer`, idem: attemptIdem(base, pf.attempts) });
      }
      if (fee != null && fee.amount > 0n) {
        const base = `repair:rescind-fee:${tradeId}`;
        const pf = paidFor(base);
        owedQ.push({ kind: "rescind-fee", ref: tradeId, ledger: "usds", debitName: "platform-fee", creditName: buyerQuoteName, amount: fee.amount - pf.total, memo: `repair rescind-fee ${tradeId}: platform refunds fee for undelivered trade`, idem: attemptIdem(base, pf.attempts) });
      }
    } else {
      // fill נמסר (מלא או חלקית): overcharge רק עם replay תואם (fail-closed)
      if (charged != null && charged > lawfulBuyerPays && matched) {
        const base = `repair:overcharge:${tradeId}`;
        const pf = paidFor(base);
        owedQ.push({ kind: "overcharge", ref: tradeId, ledger: "usds", debitName: sellerQuoteName, creditName: buyerQuoteName, amount: (charged - lawfulBuyerPays) - pf.total, memo: `repair overcharge ${tradeId}: seller refunds exactCeil overcharge`, idem: attemptIdem(base, pf.attempts) });
      }
      if (b != null && f.side === "ask" && b.debit === escrowBaseId) {
        const base = `repair:pooldrain:${tradeId}`;
        const pf = paidFor(base);
        owedB.push({ kind: "pooldrain", ref: tradeId, ledger: "saos", debitName: sellerBaseName, creditName: "market-escrow-base", amount: f.amount - pf.total, memo: `repair pooldrain ${tradeId}: seller restitutes pool-funded delivery`, idem: attemptIdem(base, pf.attempts) });
      }
    }
    void seller; void buyer;
  }

  // ── D: over-refund ─────────────────────────────────────────────────────────
  const refundAgg = new Map<string, { total: bigint; lock: bigint; credit: string }>();
  for (const rf of refunds) {
    const e = refundAgg.get(rf.orderId) ?? { total: 0n, lock: locks.get(rf.orderId) ?? 0n, credit: rf.credit };
    e.total += rf.amount; e.credit = rf.credit;
    refundAgg.set(rf.orderId, e);
  }
  const owedR: Owed[] = [];
  for (const [oid, e] of [...refundAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.total <= e.lock) continue;
    const agentName = qName.get(e.credit) ?? "";
    const base = `repair:overrefund:${oid}`;
    const pf = paidFor(base);
    if (!agentName.startsWith("agent:")) {
      anomalies.push(`overrefund ${oid}: חשבון-מופקד לא-מזוהה (${agentName || e.credit}) — מתועד ללא-תיקון`);
      continue;
    }
    owedR.push({ kind: "overrefund", ref: oid, ledger: "usds", debitName: agentName, creditName: "market-escrow-quote", amount: (e.total - e.lock) - pf.total, memo: `repair overrefund ${oid}: deposit refunded above its lock — claw back to escrow`, idem: attemptIdem(base, pf.attempts) });
  }

  // ── סימולציה-סדרתית: payable = min(owed, יתרה-רצה); קבלות נזקפות בדרך ──────
  const cap = (o: Owed, bal: Map<string, bigint>): RepairAction => {
    const have = bal.get(o.debitName) ?? 0n;
    const payable = o.amount > 0n && have > 0n ? (o.amount < have ? o.amount : have) : 0n;
    if (payable > 0n) {
      bal.set(o.debitName, have - payable);
      bal.set(o.creditName, (bal.get(o.creditName) ?? 0n) + payable);
    }
    return {
      kind: o.kind, idem: o.idem, ledger: o.ledger,
      debitName: o.debitName, creditName: o.creditName,
      owed: o.amount.toString(), payable: payable.toString(),
      shortfall: (o.amount - payable).toString(),
      ref: o.ref, memo: o.memo,
    };
  };
  const actions: RepairAction[] = [
    ...owedQ.filter((o) => o.kind === "rescind-q").map((o) => cap(o, usdsBal)),
    ...owedQ.filter((o) => o.kind === "rescind-fee").map((o) => cap(o, usdsBal)),
    ...owedQ.filter((o) => o.kind === "overcharge").map((o) => cap(o, usdsBal)),
    ...owedR.map((o) => cap(o, usdsBal)),
    ...owedB.map((o) => cap(o, saosBal)),
  ];

  const kinds = ["rescind-q", "rescind-fee", "overcharge", "overrefund", "pooldrain"];
  const summary = kinds.map((k) => {
    const xs = actions.filter((a) => a.kind === k);
    return {
      kind: k, count: xs.length,
      owed: xs.reduce((s, a) => s + BigInt(a.owed), 0n).toString(),
      payable: xs.reduce((s, a) => s + BigInt(a.payable), 0n).toString(),
      shortfall: xs.reduce((s, a) => s + BigInt(a.shortfall), 0n).toString(),
    };
  });

  // ── sha של התוכנית (המפעיל מאשר גרסה זו במדויק) ────────────────────────────
  const canonical = JSON.stringify({
    actions: actions.map((a) => ({ kind: a.kind, idem: a.idem, ledger: a.ledger, debitName: a.debitName, creditName: a.creditName, owed: a.owed, payable: a.payable, shortfall: a.shortfall, ref: a.ref })),
    anomalies: [...anomalies].sort(),
  });
  const planSha256 = createHash("sha256").update(canonical).digest("hex");

  return {
    planSha256,
    generatedAt: new Date().toISOString(),
    actions,
    summary,
    anomalies,
    scope: { distinctTrades: replaysByTrade.size, refunds: refunds.length, unsettledTrades },
  };
}
