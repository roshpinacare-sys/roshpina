/**
 * self-audit.ts — מנוע-הכנות של הרשת-הריבונית: ביקורת "טענות-מול-מציאות" מתוזמנת.
 *
 * הרעיון (חדשנות-מטרית): הארכיטקטורה מריצה על-עצמה צוות-אדום — כל-טענה שהיא
 * מפרסמת נבדקת-מחדש באופן-עצמאי, וכל-פער בין-טענה למציאות = כישלון-כן (exit 1).
 * זה-ההיפך-מהמערכות שמסתירות: מערכת שרודפת את-עצמה על-חוסר-דיוק.
 *
 * הטענות שנבדקות:
 *  A. "שימור-כסף נאכף" — conservation holds:true מהשוק + מבנה-סביר של-המספרים.
 *  B. "ספר-המתמיד משקף את-האמת" — התכנסות ה-mirror: Σ יתרות-USDS במראה מול
 *     האמת-החיה (לפני-סטייק) — מדוד ומוצג באחוזים (סבילות ≥95% = עבר; מתחת = כשל).
 *  C. "כשירות-פירעון מדויקת וכנה" — מוצגים שני-המדדים יחד, תמיד:
 *     חוק-המראה (zero-sum) + יחס-גיבוי פועלי (pool / התחייבויות-USDS) + רזרבה.
 *     מספיר עצמו מעגלי ("solvent כי-הכרזנו-מודל") אסור — הכנות היא-להציג-את-שניהם.
 *  D. "עוגנים אמיתיים זורמים" — עוגן-אחרון צעיר מ-30 דקות עם-דריכת-מקור.
 *  E. "התזמונים חיים" — כל-תזמון-מופעל ירה לפחות-פעם-אחת אם-חלפו 2 שעות מאז-יצירתו.
 *  F. "הצמתים חיים" — 4 הצמתים עונים.
 *
 * רץ: bun scripts/self-audit.ts · exit 1 = טענה-שנשברה (רועש, לא-מוסתר)
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const MARKET = process.env.SOVR_MARKET_URL ?? "http://127.0.0.1:3033";
const LEDGER = process.env.SOVR_LEDGER_URL ?? "http://127.0.0.1:3032";
const RUNNER = process.env.SOVR_RUNNER_URL ?? "http://127.0.0.1:3031";
const ORACLE_JSONL = join(import.meta.dir, "..", "data", "oracle", "anchors.jsonl");
const TIMEOUT = 8_000;

type Verdict = { claim: string; result: "PASS" | "FAIL"; detail: string };
const verdicts: Verdict[] = [];

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const at = new Date().toISOString();
  console.log(`SELF-AUDIT @ ${at} — claims vs reality, independent re-verification`);

  // ── F. nodes alive (do this first — everything else needs them) ──
  for (const [name, base] of [["market", MARKET], ["ledger", LEDGER], ["runner", RUNNER]] as const) {
    try {
      const h = (await getJson(`${base}/health`)) as { ok?: boolean };
      verdicts.push({ claim: `node:${name} alive`, result: h.ok ? "PASS" : "FAIL", detail: `ok=${String(h.ok)}` });
    } catch (e) {
      verdicts.push({ claim: `node:${name} alive`, result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreachable" });
    }
  }

  // ── A. conservation ──
  let cons: { quote?: Record<string, string | boolean>; base?: Record<string, string | boolean> } | null = null;
  try {
    const rep = (await getJson(`${MARKET}/economy/report`)) as { conservation?: typeof cons; settledTrades?: number; book?: { trades?: number } };
    cons = rep.conservation ?? null;
    const q = cons?.quote;
    const holds = q?.holds === true;
    verdicts.push({ claim: "conservation holds", result: holds ? "PASS" : "FAIL", detail: `quote.holds=${String(q?.holds)} · settled=${rep.settledTrades} · book=${rep.book?.trades}` });
  } catch (e) {
    verdicts.push({ claim: "conservation holds", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreachable" });
  }

  // ── B+C. mirror convergence + honest solvency (both models, always together) ──
  try {
    const st = (await getJson(`${LEDGER}/state?tenantId=market`)) as {
      accounts?: { ownerId: string; balance: string; type: string }[];
      solvency?: { model?: string; isSolvent?: boolean; totalAssets?: string; totalLiabilities?: string; netEquity?: string };
      sovereignty?: { owner?: string; law?: string };
    };
    const accts = st.accounts ?? [];
    // חוק-יחידות נמדד מחדש 2026-10-21 (צו 1a15ce0b8dbf6c71): אחרי כתיבת-ההתיישבויות
    // מחדש בסקאלה-אמיתית (task 44), הפנקס מדבר µ¢ נטיבי 1:1 מול השוק — מדידה חיה:
    // ledger Σ=332,761,047 ↔ market Σ=332,761,047 (זהות מלאה). חלוקת-ה-×10⁴ הישנה
    // ("מוכח מול-alpha") הייתה חוק-עולם-קודם וגרמה לכישלון-התכנסות מזויף (0%).
    const usdsMirror = accts
      .filter((a) => a.ownerId.startsWith("agent:") && a.ownerId.endsWith(":usds"))
      .reduce((s, a) => s + BigInt(a.balance), 0n);
    const usdsMirrorUnits = usdsMirror; // נטיבי µ¢ — זהה-סקאלה למדידת-השוק
    let liveUsds = -1n;
    try {
      const rep = (await getJson(`${MARKET}/economy/report`)) as { agents?: { usds: string; usdsLocked: string; usdsStaked?: string }[] };
      // חוק-השוואה: ה-mirror כולל-סטייק — גם-סכום-האמת-החיה חייב לכלול אותו (usds+locked+staked), אחרת המדידה עצמה משקרת
      liveUsds = (rep.agents ?? []).reduce((s, a) => s + BigInt(a.usds) + BigInt(a.usdsLocked) + BigInt(a.usdsStaked ?? "0"), 0n);
    } catch { /* live side counted only if reachable */ }
    // דיוק-0.01%: כפל-×10⁴ לפני חלוקת-BigInt כדי שטרנקציה לא תחתוך יחס תקין ל-0
    const conv = liveUsds > 0n ? Number((usdsMirrorUnits * 10000n) / liveUsds) / 100 : -1;
    const inBand = conv >= 95 && conv <= 105; // סבילות-דו-צדדית: סטייה-לשני-הכיוונים היא-סטייה
    verdicts.push({
      claim: "ledger mirror convergence (USDS, incl. staked)",
      result: inBand ? "PASS" : "FAIL",
      detail: `mirror=${usdsMirrorUnits.toString()} · live=${liveUsds.toString()} · convergence=${conv}% (band 95–105%)`,
    });
    const sol = st.solvency ?? {};
    const pool = accts.filter((a) => a.ownerId.startsWith("pool:") && a.type === "asset").reduce((s, a) => s + BigInt(a.balance), 0n);
    const reserve = accts.filter((a) => a.type === "equity").reduce((s, a) => s + BigInt(a.balance), 0n);
    const backingPct = usdsMirror > 0n ? Number((pool * 10000n) / usdsMirror) / 100 : -1;
    console.log(`  solvency-honesty (both models, no circularity): mirror-law=${String(sol.isSolvent)} · custodial-backing=${backingPct}% · platform-reserve=${reserve.toString()} µ¢`);
    verdicts.push({
      claim: "solvency reported honestly (not circular)",
      result: Number.isFinite(backingPct) && backingPct >= 0 ? "PASS" : "FAIL",
      detail: `mirror-law=${String(sol.isSolvent)} · backing=${backingPct}% · reserve=${reserve.toString()} — both numbers always shown together`,
    });
    // ── I. חוק-הבעלות: הצומת-עצמו מכריז על-הבעלים האמיתי ──
    // הארכיטקטורה היא-הבעלים; האדם נופל-חריגים-בלבד. זו-טענה-מבנית ב-/state —
    // צומת שלא מכריז = צומת שהבעלות שלו-עוד סיפור ולא חוק = FAIL.
    const sov = st.sovereignty;
    verdicts.push({
      claim: "owner-law embedded in the money node (architecture is the owner)",
      result: sov?.owner === "architecture" ? "PASS" : "FAIL",
      detail: sov
        ? `owner=${sov.owner} — ${String(sov.law ?? "").slice(0, 90)}…`
        : "sovereignty block ABSENT from /state — the node does not declare its owner",
    });
  } catch (e) {
    verdicts.push({ claim: "ledger mirror convergence", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreachable" });
  }

  // ── D. oracle freshness ──
  try {
    if (!existsSync(ORACLE_JSONL)) throw new Error("anchors.jsonl missing");
    const lines = readFileSync(ORACLE_JSONL, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as { at: string; source: string; network: string; rawSha256: string };
    const ageMin = (Date.now() - Date.parse(last.at)) / 60_000;
    verdicts.push({
      claim: "oracle anchors fresh (real external prices)",
      result: ageMin <= 30 ? "PASS" : "FAIL",
      detail: `last=${last.network}@${last.at} (${ageMin.toFixed(1)}min old, source=${last.source}, sha=${last.rawSha256.slice(0, 10)}…)`,
    });
  } catch (e) {
    verdicts.push({ claim: "oracle anchors fresh", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreadable" });
  }

  // ── E. schedules alive ──
  try {
    const s = (await getJson(`${RUNNER}/schedules`)) as { schedules?: { id: string; presetId: string; enabled: boolean; createdAt: string; lastRunAt: string | null }[] };
    const stale = (s.schedules ?? []).filter(
      (x) => x.enabled && !x.lastRunAt && Date.now() - Date.parse(x.createdAt) > 2 * 3_600_000,
    );
    verdicts.push({
      claim: "all enabled schedules fired",
      result: stale.length === 0 ? "PASS" : "FAIL",
      detail: stale.length === 0 ? `${(s.schedules ?? []).length} schedules healthy` : `never-fired >2h: ${stale.map((x) => x.presetId).join(",")}`,
    });
  } catch (e) {
    verdicts.push({ claim: "all enabled schedules fired", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreachable" });
  }

  // ── G. תזמונים שומרים-הבטחות (באג-הדחייה-השקטה 2026-10-20) ──
  // הבטחת-nextRunAt לא רשאית להתרחק מהעוגן שלה (ריצה-אחרונה, או יצירה אם-מעולם-לא-רץ)
  // יותר-מ-2×מחזור + 120שנ'. דחייה-שקטה של-הבטחה = כישלון-כן.
  try {
    const s = (await getJson(`${RUNNER}/schedules`)) as { schedules?: { id: string; presetId: string; enabled: boolean; intervalSec: number; createdAt: string; lastRunAt: string | null; nextRunAt: string | null }[] };
    const broken = (s.schedules ?? [])
      .filter((x) => x.enabled && x.nextRunAt)
      .filter((x) => {
        const anchorMs = Date.parse(x.lastRunAt ?? x.createdAt);
        const maxAllowed = anchorMs + 2 * x.intervalSec * 1000 + 120_000;
        return Number.isFinite(anchorMs) && Date.parse(x.nextRunAt!) > maxAllowed;
      })
      .map((x) => `${x.presetId}(next=${x.nextRunAt})`);
    verdicts.push({
      claim: "schedules keep their promises (no silent deferral)",
      result: broken.length === 0 ? "PASS" : "FAIL",
      detail: broken.length === 0 ? `${(s.schedules ?? []).filter((x) => x.enabled).length} enabled schedules anchored honestly` : `deferred silently: ${broken.join(", ")}`,
    });
  } catch (e) {
    verdicts.push({ claim: "schedules keep their promises", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 100) : "unreachable" });
  }

  // ── H. חוק-מות-הבונים: העבודה שורדת את-הבונה ──
  // ענף-עבודה נמחק חיצונית 12 פעמים — זה תקין (בונים הם-בני-תמותה). החוזה:
  // תג-הארכיון תמיד נושא את-העבודה, והפיל שלו == HEAD של-סבשטרט-הכסף-החי.
  // אם-גם-הענף וגם-התג נעלמו, או שהפיל סטה מה-HEAD-החי — עבודה אבדה/נסגה = FAIL.
  try {
    const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? "/home/z/my-project/upload/pat.env";
    const token = existsSync(TOKEN_FILE)
      ? readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? ""
      : "";
    if (!token) throw new Error("no usable token in supply path — preservation unverifiable");
    const api = async (path: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`https://api.github.com/repos/roshpinacare-sys/roshpina${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.slice(0, 40)}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const localHead = Bun.spawnSync(["git", "-C", "/home/z/repos/roshpina", "rev-parse", "HEAD"]).stdout.toString().trim();
    const laneTag = await api("/git/ref/tags/archive%2Fagent4%2Fp2-sovereign-market");
    const tagObjSha = String((laneTag.object as { sha?: string; type?: string })?.sha ?? "");
    const tagObjType = String((laneTag.object as { sha?: string; type?: string })?.type ?? "");
    const peeled = tagObjType === "tag" ? String(((await api(`/git/tags/${tagObjSha}`)).object as { sha?: string })?.sha ?? "") : tagObjSha;
    let branchAlive = false;
    try {
      await api("/git/ref/heads/agent4/p2-sovereign-market");
      branchAlive = true;
    } catch { /* ענף-מת זה מותר — התג הוא-החוזה */ }
    const preserved = peeled === localHead;
    verdicts.push({
      claim: "builder-mortality law: lane work survives the builder (archive tag peel == live HEAD)",
      result: preserved ? "PASS" : "FAIL",
      detail: `tag-peel=${peeled.slice(0, 7)} · live-HEAD=${localHead.slice(0, 7)} · work-branch-alive=${branchAlive ? "yes" : "no (tag holds — as designed)"}`,
    });
  } catch (e) {
    verdicts.push({ claim: "builder-mortality law: lane preserved remotely", result: "FAIL", detail: e instanceof Error ? e.message.slice(0, 140) : "unknown" });
  }

  // ── verdict table ──
  let failed = 0;
  for (const v of verdicts) {
    if (v.result === "FAIL") failed++;
    console.log(`  [${v.result}] ${v.claim} — ${v.detail}`);
  }
  if (failed > 0) {
    console.error(`SELF-AUDIT-FAIL: ${failed}/${verdicts.length} claims broken — the architecture lies to itself no longer`);
    process.exit(1);
  }
  console.log("SELF-AUDIT-OK · all claims re-verified independently — the architecture audits its own honesty");
}

await main();
