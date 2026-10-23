#!/usr/bin/env bun
/**
 * market-repair-evidence.ts — טבלאות-ראיה ותוכנית-תיקון לנזקי-העבר של נתיב-הכסף (Task 30).
 *
 * קריאה-בלבד. אפס-כתיבה לספרים. הפלט מחושב אך-ורק מהיומנים על-הדיסק
 * (market/usds/saos) — לא משום זיכרון, לא משום הערכה.
 *
 * אבחון-נזק (טקסונומיה):
 *   A delivery-owed — הקונה שילם (fee/q בספר) ואין רגל-b כלל.
 *   B pool-drain    — side=ask ורגל-b חויבה את escrow-base (באג 19a).
 *   C overcharge    — charged > lawful (באג 20), רק עם replay תואם.
 *   D over-refund   — סכום-החזרים לזמנה > הפקדון (באג 18).
 *   F fee-only      — fee בלי q ובלי b (הקונה שילם עמלה ולא קיבל דבר).
 *   E anomaly       — ראיה לא-חד-משמעית: מתועד, אפס-תזוזת-כסף (fail-closed).
 *
 * תוכנית-התיקון — מבוססת-רגליים בלבד (מה שבאמת זרם בספר), לא מפרמטרי-intent:
 *   rescind    — b חסר לגמרי ורגליים קיימות: המוכר מחזיר את רגל-q בפועל
 *                שקיבל, הפלטפורמה מחזירה את ה-fee בפועל. מכסה A, A∩C (העודף
 *                נמצא בתוך q) ו-F (רק fee). אפס-מנטה, אפס-שבירת-שימור.
 *   overcharge — b מלא ו-charged > lawful (replay תואם בלבד): המוכר מחזיר
 *                את העודף לקונה.
 *   pooldrain  — side=ask ו-b נחנב מ-escrow-base: המוכר מחזיר את הכמות
 *                למכסת-ה-escrow (side=bid מה-escrow — חוקי, זה המנעול שלו).
 *   overrefund — ההחזרים לזמנה עולים על הפקדון: המופקד מחזיר ל-escrow-quote.
 *   anomaly    — ראיה לא-חד-משמעית = אפס-תזוזת-כסף, מתועד בכנות.
 *
 * מזהי-trade מומשו בין-בוטים (לפני 8b148d5) — לכן לכל-tradeId נבחר ה-replay
 * שתואם לרגליים בפועל (הראיה המחייבת), ולא בהכרח הראשון.
 *
 * שימוש:
 *   bun market-repair-evidence.ts
 *   MARKET_DATA_DIR=... REPAIR_OUT=... bun market-repair-evidence.ts
 *
 * הפלט אינו מבצע כלום — הוא הקלט המחייב לנתיב-התיקון החתום (שלב הבא).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.MARKET_DATA_DIR ?? "/home/z/repos/roshpina/data/market-net";
const OUT_DIR = process.env.REPAIR_OUT ?? "/home/z/my-project/mini-services/fleet-runner/data/outputs";

type Js = Record<string, unknown>;

function readJsonl(p: string): { envs: Js[]; sha: string; lines: number } {
  const raw = readFileSync(p, "utf8");
  const sha = createHash("sha256").update(raw).digest("hex");
  const envs: Js[] = [];
  let lines = 0;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    lines++;
    try {
      envs.push(JSON.parse(s) as Js);
    } catch {
      // יומן-תקין לא מכיל שורות-פסולות; אם כן — זו ראיה בפני-עצמה
      envs.push({ t: "__PARSE_ERROR__", line: s.slice(0, 120) });
    }
  }
  return { envs, sha, lines };
}

const recOf = (env: Js): Js => (env.rec as Js) ?? env;
const idemOf = (env: Js): string => String(env.idemKey ?? recOf(env).idemKey ?? "");
const txOf = (env: Js): Js => ((recOf(env).tx as Js) ?? {});
const num = (v: unknown): bigint => BigInt(String(v ?? "0"));

async function main(): Promise<void> {
  const market = readJsonl(join(DATA_DIR, "market", "journal.jsonl"));
  const usds = readJsonl(join(DATA_DIR, "usds", "journal.jsonl"));
  const saos = readJsonl(join(DATA_DIR, "saos", "journal.jsonl"));

  // ── מפות-חשבונות מה-snapshots ──────────────────────────────────────────────
  const qSnap = JSON.parse(readFileSync(join(DATA_DIR, "usds", "snapshot.json"), "utf8")) as Js;
  const bSnap = JSON.parse(readFileSync(join(DATA_DIR, "saos", "snapshot.json"), "utf8")) as Js;
  const qAccounts = (qSnap.accounts as Js[]) ?? [];
  const bAccounts = (bSnap.accounts as Js[]) ?? [];
  const accName = (map: Map<string, string>, id: string): string => map.get(id) ?? id.slice(0, 8);
  const agentOf = (name: string): string => (name.includes(":") ? name.split(":")[1] : name);
  const qAcc = new Map<string, string>();
  const bAcc = new Map<string, string>();
  for (const a of qAccounts) qAcc.set(String(a.id), String(a.name));
  for (const a of bAccounts) bAcc.set(String(a.id), String(a.name));
  const escrowQuoteId = String(qAccounts.find((a) => a.name === "market-escrow-quote")?.id ?? "");
  const escrowBaseId = String(bAccounts.find((a) => a.name === "market-escrow-base")?.id ?? "");
  const feeAccountId = String(qAccounts.find((a) => a.name === "platform-fee")?.id ?? "");

  // ── market journal: fills (כל-ה-replays לכל-tradeId) ───────────────────────
  type Fill = {
    tradeId: string; price: bigint; amount: bigint; notional: bigint; remainder: bigint;
    makerId: string; takerId: string; side: string; seq: number;
  };
  const replaysByTrade = new Map<string, Fill[]>();
  const tradeDone = new Set<string>();
  for (const env of market.envs) {
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
    } else if (r.t === "trade_done") tradeDone.add(String(r.tradeId));
  }

  // ── ספרי-הכסף: רגלי-trade בפועל + מנעולים + החזרים ─────────────────────────
  type Leg = { amount: bigint; debit: string; credit: string; ts: string };
  const qFee = new Map<string, Leg>(); const qSettle = new Map<string, Leg>();
  const bDeliver = new Map<string, Leg>();
  const locks = new Map<string, bigint>();
  type Refund = { orderId: string; amount: bigint; credit: string; ts: string; idem: string };
  const refunds: Refund[] = [];
  const parseRefundIdem = (idem: string): string => {
    const rest = idem.slice("escrow-refund:".length);
    const parts = rest.split(":");
    // פורמט-מורש: escrow-refund:<ISO-ts>:<orderId> (ISO מכיל 2 נקודות-יין)
    if (parts.length >= 4 && /^\d{4}-\d{2}-\d{2}T/.test(parts[0])) return parts.slice(3).join(":") || parts[3];
    return rest;
  };
  for (const env of usds.envs) {
    const idem = idemOf(env); const tx = txOf(env);
    if (idem.startsWith("trade-")) {
      const leg: Leg = { amount: num(tx.amount), debit: String(tx.debitAccountId), credit: String(tx.creditAccountId), ts: String(env.ts ?? "") };
      if (idem.endsWith(":fee")) qFee.set(idem.slice(0, -4), leg);
      else if (idem.endsWith(":q")) qSettle.set(idem.slice(0, -2), leg);
    } else if (idem.startsWith("lock:")) {
      const oid = idem.slice(5);
      locks.set(oid, (locks.get(oid) ?? 0n) + num(tx.amount));
    } else if (idem.startsWith("escrow-refund:")) {
      refunds.push({ orderId: parseRefundIdem(idem), amount: num(tx.amount), credit: String(tx.creditAccountId), ts: String(env.ts ?? ""), idem });
    }
  }
  for (const env of saos.envs) {
    const idem = idemOf(env); const tx = txOf(env);
    if (idem.startsWith("trade-") && idem.endsWith(":b")) bDeliver.set(idem.slice(0, -2), { amount: num(tx.amount), debit: String(tx.debitAccountId), credit: String(tx.creditAccountId), ts: String(env.ts ?? "") });
  }

  // ── D: החזרי-יתר לפי זמנה (לפני תוכנית-התיקון — עצמאי ב-trades) ────────────
  const refundAgg = new Map<string, { total: bigint; lock: bigint; n: number; credit: string }>();
  for (const rf of refunds) {
    const e = refundAgg.get(rf.orderId) ?? { total: 0n, lock: locks.get(rf.orderId) ?? 0n, n: 0, credit: rf.credit };
    e.total += rf.amount; e.n++; e.credit = rf.credit;
    refundAgg.set(rf.orderId, e);
  }
  const overRefunds = [...refundAgg.entries()]
    .filter(([, e]) => e.total > e.lock)
    .map(([oid, e]) => ({ orderId: oid, locked: e.lock.toString(), refunded: e.total.toString(), over: (e.total - e.lock).toString(), refunds: e.n, agent: agentOf(accName(qAcc, e.credit)) }));

  // ── סיווג לכל-trade (בחירת-replay מתואמת-רגליים) ───────────────────────────
  type Row = {
    tradeId: string; side: string; buyer: string; seller: string;
    amount: string; notional: string; remainder: string;
    lawfulBuyerPays: string; actualCharged: string | null;
    delivered: string; classes: string[];
    replaySeq: number; note: string;
  };
  type Action =
    | { kind: "rescind"; tradeId: string; buyer: string; seller: string; qRefund: string; feeRefund: string }
    | { kind: "overcharge"; tradeId: string; buyer: string; seller: string; usds: string }
    | { kind: "pooldrain"; tradeId: string; seller: string; saos: string }
    | { kind: "overrefund"; orderId: string; agent: string; usds: string };
  const actions: Action[] = [];
  const rows: Row[] = [];
  const anomalies: string[] = [];

  for (const [tradeId, list] of [...replaysByTrade.entries()].sort((a, b) => a[1][0].seq - b[1][0].seq)) {
    const fee = qFee.get(tradeId); const q = qSettle.get(tradeId); const b = bDeliver.get(tradeId);
    const charged = fee != null && q != null ? fee.amount + q.amount : null;
    const conflicting = list.length > 1 && list.some((x) => x.price !== list[0].price || x.amount !== list[0].amount || x.notional !== list[0].notional || x.makerId !== list[0].makerId || x.takerId !== list[0].takerId || x.side !== list[0].side);

    // בחירת-replay: הראיה המחייבת היא הרגליים בספר. חוק-ישן: notional+remainder;
    // חוק-חדש: notional+(remainder>0?1:0). matchB: כמות-האספקה בפועל.
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
    if (conflicting && !matched) anomalies.push(`${tradeId}: רימיים סותרים (${list.length}) ואף-אחד לא תואם לרגליים — נשען על הראשון (seq ${f.seq})`);

    const lawfulBuyerPays = f.notional + (f.remainder > 0n ? 1n : 0n);
    const buyer = f.side === "bid" ? f.takerId : f.makerId;
    const seller = f.side === "bid" ? f.makerId : f.takerId;
    const classes: string[] = [];
    let note = "";

    if (charged != null) {
      if (charged > lawfulBuyerPays) { classes.push("C"); }
      else if (charged < lawfulBuyerPays) { classes.push("E"); note += "חיוב-חסר (ללא-replay תואם); "; }
    } else if (fee != null && q == null) { classes.push("F"); note += "שילם רק fee, q נכשל; "; }
    else if (q != null && fee == null) { classes.push("E"); note += "q בלי fee; "; }

    if (b != null) {
      if (b.amount < f.amount) { classes.push("A"); note += `אספקה חלקית ${b.amount}/${f.amount}; `; }
      if (f.side === "ask" && b.debit === escrowBaseId) classes.push("B");
    } else if (charged != null || fee != null) { classes.push("A"); }

    // ── תוכנית-התיקון (מבוססת-רגליים) ──
    if (b == null && (fee != null || q != null)) {
      // rescission: החזר מדויק של מה שזרם — ללא קשר לפרמטרי-intent.
      // מכסה A, F, ו-A∩C (העודף נמצא בתוך q — C נמנע כאן במפורש).
      if (q != null && q.amount > 0n) actions.push({ kind: "rescind", tradeId, buyer, seller, qRefund: q.amount.toString(), feeRefund: "0" });
      if (fee != null && fee.amount > 0n) actions.push({ kind: "rescind", tradeId, buyer, seller, qRefund: "0", feeRefund: fee.amount.toString() });
    } else {
      if (charged != null && charged > lawfulBuyerPays && matched) {
        actions.push({ kind: "overcharge", tradeId, buyer, seller, usds: (charged - lawfulBuyerPays).toString() });
      }
      if (b != null && f.side === "ask" && b.debit === escrowBaseId) {
        actions.push({ kind: "pooldrain", tradeId, seller, saos: f.amount.toString() });
      }
    }

    if (classes.length)
      rows.push({
        tradeId, side: f.side, buyer, seller,
        amount: f.amount.toString(), notional: f.notional.toString(), remainder: f.remainder.toString(),
        lawfulBuyerPays: lawfulBuyerPays.toString(),
        actualCharged: charged != null ? charged.toString() : null,
        delivered: (b?.amount ?? 0n).toString(),
        classes, replaySeq: f.seq, note,
      });
  }
  for (const o of overRefunds) {
    if (o.agent) actions.push({ kind: "overrefund", orderId: o.orderId, agent: o.agent, usds: o.over });
    else anomalies.push(`overrefund ${o.orderId}: לא נמצא חשבון-מופקד — מתועד ללא-תיקון`);
  }

  // ── חשבונות מצטברים של תוכנית-התיקון ───────────────────────────────────────
  const owes = new Map<string, { base: bigint; quote: bigint }>();
  const gets = new Map<string, { base: bigint; quote: bigint }>();
  const add = (m: Map<string, { base: bigint; quote: bigint }>, who: string, base: bigint, quote: bigint) => {
    const e = m.get(who) ?? { base: 0n, quote: 0n };
    e.base += base; e.quote += quote; m.set(who, e);
  };
  const fmt = (m: Map<string, { base: bigint; quote: bigint }>) =>
    [...m.entries()].sort((a, b) => (b[1].base + b[1].quote) > (a[1].base + a[1].quote) ? 1 : -1)
      .map(([who, v]) => ({ who, saos: v.base.toString(), usds: v.quote.toString() }));
  for (const a of actions) {
    if (a.kind === "rescind") {
      if (BigInt(a.qRefund) > 0n) { add(owes, a.seller, 0n, BigInt(a.qRefund)); add(gets, a.buyer, 0n, BigInt(a.qRefund)); }
      if (BigInt(a.feeRefund) > 0n) { add(owes, "platform-fee", 0n, BigInt(a.feeRefund)); add(gets, a.buyer, 0n, BigInt(a.feeRefund)); }
    } else if (a.kind === "overcharge") {
      add(owes, a.seller, 0n, BigInt(a.usds)); add(gets, a.buyer, 0n, BigInt(a.usds));
    } else if (a.kind === "pooldrain") {
      add(owes, a.seller, BigInt(a.saos), 0n); add(gets, "market-escrow-base", BigInt(a.saos), 0n);
    } else {
      add(owes, a.agent, 0n, BigInt(a.usds)); add(gets, "market-escrow-quote", 0n, BigInt(a.usds));
    }
  }

  const planSummary = {
    rescind: actions.filter((a) => a.kind === "rescind").length,
    rescindQ: actions.filter((a) => a.kind === "rescind").reduce((s, a) => s + BigInt((a as { qRefund: string }).qRefund), 0n).toString(),
    rescindFees: actions.filter((a) => a.kind === "rescind").reduce((s, a) => s + BigInt((a as { feeRefund: string }).feeRefund), 0n).toString(),
    overcharge: actions.filter((a) => a.kind === "overcharge").length,
    overchargeUsds: actions.filter((a) => a.kind === "overcharge").reduce((s, a) => s + BigInt((a as { usds: string }).usds), 0n).toString(),
    pooldrain: actions.filter((a) => a.kind === "pooldrain").length,
    pooldrainSaos: actions.filter((a) => a.kind === "pooldrain").reduce((s, a) => s + BigInt((a as { saos: string }).saos), 0n).toString(),
    overrefund: actions.filter((a) => a.kind === "overrefund").length,
    overrefundUsds: actions.filter((a) => a.kind === "overrefund").reduce((s, a) => s + BigInt((a as { usds: string }).usds), 0n).toString(),
  };

  const evidence = {
    generatedAt: new Date().toISOString(),
    inputs: {
      market: { lines: market.lines, sha256: market.sha },
      usds: { lines: usds.lines, sha256: usds.sha },
      saos: { lines: saos.lines, sha256: saos.sha },
    },
    scope: { distinctTrades: replaysByTrade.size, tradeDone: tradeDone.size, refunds: refunds.length },
    accounts: { escrowQuoteId, escrowBaseId, feeAccountId },
    totals: {
      A_deliveryOwed: { fills: rows.filter((r) => r.classes.includes("A")).length },
      B_poolDrain: { fills: rows.filter((r) => r.classes.includes("B")).length },
      C_overcharge: { fills: rows.filter((r) => r.classes.includes("C")).length },
      F_feeOnly: { fills: rows.filter((r) => r.classes.includes("F")).length },
      D_overRefund: { orders: overRefunds.length },
      E_anomalies: rows.filter((r) => r.classes.includes("E")).length,
    },
    repairPlan: planSummary,
    bills: { owes: fmt(owes), gets: fmt(gets) },
    overRefunds,
    anomalies: anomalies.slice(0, 50),
    actions,
    rows,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "market-repair-evidence.json");
  writeFileSync(out, JSON.stringify(evidence, null, 2));

  console.log("=== market-repair-evidence (read-only) ===");
  console.log(`trades: ${replaysByTrade.size} distinct / ${tradeDone.size} done-marked / refunds ${refunds.length}`);
  console.log(`plan: rescind ${planSummary.rescind} legs (q=${planSummary.rescindQ} µ¢, fees=${planSummary.rescindFees} µ¢)`);
  console.log(`      overcharge ${planSummary.overcharge} legs (${planSummary.overchargeUsds} µ¢)`);
  console.log(`      pooldrain ${planSummary.pooldrain} legs (${planSummary.pooldrainSaos} µ-SAOS → escrow)`);
  console.log(`      overrefund ${planSummary.overrefund} orders (${planSummary.overrefundUsds} µ¢ → escrow)`);
  console.log(`E anomalies: ${rows.filter((r) => r.classes.includes("E")).length} (documented, zero-action)`);
  console.log(`evidence → ${out}`);
}

await main();
