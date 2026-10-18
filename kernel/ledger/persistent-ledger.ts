/**
 * kernel/ledger/persistent-ledger.ts — P1: append-only persistence for the
 * sovereign ledger (2026-10-17, agent4/p1-ledger-persistence).
 *
 * הבעיה-שנמדדה (ביקורת Phase-0): "אין התמדה כלל (in-memory)" — כל-קריסה
 * מוחקת את הספר. זה התיקון: המנוע החי הוא InMemoryLedger המוכח (אפס-שינוי
 * בלוגיקה הקיימת — רק restore/exportState נוספו), ומסביבו:
 *
 *   1. יומן append-only (journal.jsonl) — כל-פעולה = שורה-אחת-אטומית עם
 *      hash-chain (sha256 על canonicalJson, שורש GENESIS), fsync בכל-כתיבה.
 *   2. snapshot.json — תמונת-מצב אטומית (tmp+rename) להאצת-אתחול; היומן
 *      לעולם לא נמחק (חוק append-only) — ה-snapshot הוא קיצור-דרך בלבד.
 *   3. אתחול = אימות שרשרת-ה-hash המלאה + fold עם בדיקת-שימור לכל-עסקה
 *      (debit==credit==tx.amount, חשבונות-תואמים) + שחזור InMemoryLedger.
 *      verify:"full" (ברירת-מחדל) מצליב fold-מלא מול נתיב-ה-snapshot ומפיל
 *      את-האתחול על-כל-אי-התאמה.
 *   4. idempotency בתוך שורת-הפעולה עצמה (idemKey) — אין חלון-קריסה בין
 *      "בוצע" ל"נרשם": ניסיון-חוזר עם אותו-מפתח מחזיר את-התוצאה המקורית,
 *      גם-אחרי-הפעלה-מחדש.
 *
 * גבולות-כנים (phase-1): תהליך-כותב-יחיד (lock רב-תהליכי = phase-2);
 * fsync-תיקייה אחרי-rename אינו מבוצע; היומן לא חתום-חוץ (עוגן = phase-2,
 * transparency-log). קריסה-אחרי-עיבוד-לפני-כתיבה = פעולה-שלא-אושרה-ללקוח
 * ולא-נשמרה: סמנטיקת at-least-ack'd — לעולם לא כפילות-חיוב.
 *
 * כל-הכמויות: BigInt μ¢ בזיכרון; ביומן/ב-snapshot — מחרוזת-עשרונית מפורשת
 * (ערוץ-ה-JSON לעולם לא רואה float).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical-json";
import { InMemoryLedger, LedgerError } from "./in-memory-ledger";
import type {
  Account,
  AccountType,
  JournalEntry,
  LedgerTransaction,
  MicroCents,
  PaymentProvider,
  SolvencyProof,
} from "./types";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class JournalError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

// ─── Serialized shapes (JSON channel: BigInt ↔ decimal-string, explicit) ────

type SAccount = Omit<Account, "balance"> & { balance: string };
type STx = Omit<LedgerTransaction, "amount"> & { amount: string };
type SEntry = Omit<JournalEntry, "amount"> & { amount: string };

const sAccount = (a: Account): SAccount => ({ ...a, balance: a.balance.toString() });
const sTx = (t: LedgerTransaction): STx => ({ ...t, amount: t.amount.toString() });
const sEntry = (e: JournalEntry): SEntry => ({ ...e, amount: e.amount.toString() });

function intStr(s: string, ctx: string): bigint {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) {
    throw new JournalError(`${ctx}: "${String(s)}" is not an integer μ¢ string (JSON channel never carries floats)`, "FOLD_BAD_NUMBER");
  }
  return BigInt(s);
}

function account(o: SAccount): Account {
  return { ...(o as Omit<SAccount, "balance">), balance: intStr(o.balance, "account") };
}
function txOf(o: STx): LedgerTransaction {
  return { ...(o as Omit<STx, "amount">), amount: intStr(o.amount, `tx ${o.id}`) };
}
function entryOf(o: SEntry): JournalEntry {
  return { ...(o as Omit<SEntry, "amount">), amount: intStr(o.amount, `entry ${o.id}`) };
}

// ─── Journal records (one line per logical op) ───────────────────────────────

type OpRecord = {
  t: "op";
  /** Accounts first seen by this op (lazy reserve included). */
  accounts: SAccount[];
  /** The resulting transaction, if the op is financial. */
  tx: STx | null;
  /** The two entries the op wrote (double-entry law). */
  entries: SEntry[];
  /** Idempotency key bound INTO the same atomic line (no crash window). */
  idemKey: string | null;
  /** Full result replayed to retries (immutable after commit). */
  idemResponse: { kind: "tx"; tx: STx } | { kind: "account"; account: SAccount } | null;
};

type JournalRecord = OpRecord;

export interface Envelope<REC = unknown> {
  seq: number;
  prevHash: string;
  hash: string;
  ts: string;
  rec: REC;
}

const GENESIS = "GENESIS";

// ─── The journal: append + verify ────────────────────────────────────────────

export class Journal<REC = unknown> {
  readonly dir: string;
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private readonly metaPath: string;
  private fd: number | null = null;
  private head = GENESIS;
  /** Records appended to the CURRENT journal file (journal-relative). */
  private seq = 0;
  /** Global seq offset — non-zero after a snapshot-anchored restart/rebase.
   *  A running process can lose its data dir (sandbox resets do exactly that):
   *  the old fd keeps writing into a vanished inode and mutations throw ENOENT
   *  on new files. The journal heals honestly: re-anchor the chain on the
   *  latest snapshot instead of pretending nothing happened. */
  private baseSeq = 0;
  private rebaseFlag = false;

  constructor(dir: string) {
    this.dir = dir;
    this.journalPath = path.join(dir, "journal.jsonl");
    this.snapshotPath = path.join(dir, "snapshot.json");
    this.metaPath = path.join(dir, "journal.meta.json");
  }

  /** GLOBAL sequence (base + journal-relative) — the number the rest of the world sees. */
  get sequence(): number {
    return this.baseSeq + this.seq;
  }
  get chainHead(): string {
    return this.head;
  }
  get base(): number {
    return this.baseSeq;
  }

  /** Consume the rebase flag: true if the journal was re-anchored since the last
   *  call — the ledger must write a snapshot NOW so the disk state matches the
   *  new chain segment. */
  consumeRebaseFlag(): boolean {
    const was = this.rebaseFlag;
    this.rebaseFlag = false;
    return was;
  }

  /** Open (create if absent) and verify the FULL hash chain. Fail-closed.
   *  Chain verification is offset-aware: after a rebase, envelope seqs are
   *  global (baseSeq + line index + 1) and the chain restarts at GENESIS. */
  open(): { records: Envelope<REC>[] } {
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadMeta();
    const records: Envelope[] = [];
    if (fs.existsSync(this.journalPath)) {
      const raw = fs.readFileSync(this.journalPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      let prev = GENESIS;
      for (let i = 0; i < lines.length; i++) {
        let env: Envelope;
        try {
          env = JSON.parse(lines[i]) as Envelope;
        } catch {
          throw new JournalError(
            `journal line ${i + 1} is not valid JSON — refusing to boot on a corrupt ledger (fail-closed)`,
            "JOURNAL_CORRUPT",
          );
        }
        if (env.seq !== this.baseSeq + i + 1) {
          throw new JournalError(
            `journal line ${i + 1}: seq mismatch (${env.seq} ≠ ${this.baseSeq + i + 1}, baseSeq=${this.baseSeq})`,
            "JOURNAL_SEQ_GAP",
          );
        }
        if (env.prevHash !== prev) {
          throw new JournalError(
            `journal line ${i + 1}: chain break (prevHash ${String(env.prevHash).slice(0, 12)}… ≠ computed ${prev.slice(0, 12)}…)`,
            "JOURNAL_CHAIN_BREAK",
          );
        }
        const computed = Journal.hashOf(env);
        if (computed !== env.hash) {
          throw new JournalError(
            `journal line ${i + 1}: hash mismatch — record tampered (fail-closed)`,
            "JOURNAL_TAMPERED",
          );
        }
        prev = env.hash;
        records.push(env);
      }
      this.head = prev;
      this.seq = records.length;
    }
    this.fd = fs.openSync(this.journalPath, "a");
    return { records };
  }

  private loadMeta(): void {
    this.baseSeq = 0;
    if (!fs.existsSync(this.metaPath)) return;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as { baseSeq?: unknown };
      this.baseSeq =
        typeof meta.baseSeq === "number" && Number.isSafeInteger(meta.baseSeq) && meta.baseSeq >= 0
          ? meta.baseSeq
          : 0;
    } catch {
      this.baseSeq = 0; // unreadable meta = pre-rebase journal
    }
  }

  static hashOf(env: { seq: number; prevHash: string; ts: string; rec: unknown }): string {
    return createHash("sha256")
      .update(canonicalJson({ seq: env.seq, prevHash: env.prevHash, ts: env.ts, rec: env.rec }))
      .digest("hex");
  }

  /** Append one record atomically (single line) and fsync. */
  append(rec: REC): Envelope<REC> {
    if (this.fd === null) throw new JournalError("journal not open", "JOURNAL_CLOSED");
    this.healIfVanished();
    const env: { seq: number; prevHash: string; ts: string; rec: REC } = {
      seq: this.baseSeq + this.seq + 1,
      prevHash: this.head,
      ts: new Date().toISOString(),
      rec,
    };
    const hash = Journal.hashOf(env);
    fs.writeSync(this.fd, JSON.stringify({ ...env, hash }) + "\n");
    fs.fsyncSync(this.fd);
    this.head = hash;
    this.seq++; // journal-relative count (env.seq is global)
    return { ...env, hash };
  }

  /** Atomic snapshot (tmp + rename). The journal is NEVER truncated.
   *  mkdir first: the dir can vanish under a running process — the snapshot
   *  must recreate it, not die with ENOENT (that was the live bug). */
  writeSnapshot(state: { accounts: Account[]; entries: JournalEntry[]; transactions: LedgerTransaction[] }): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const snap = {
      at: new Date().toISOString(),
      seq: this.baseSeq + this.seq,
      head: this.head,
      accounts: state.accounts.map(sAccount),
      entries: state.entries.map(sEntry),
      transactions: state.transactions.map(sTx),
    };
    const tmp = this.snapshotPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, this.snapshotPath);
  }

  /** The journal file was deleted under the running process (dir vanished).
   *  Silent writes into a vanished inode = data loss — heal honestly:
   *  recreate the file, re-anchor the chain at the current global seq, and
   *  flag the ledger to snapshot immediately so disk regains the truth. */
  private healIfVanished(): void {
    if (fs.existsSync(this.journalPath)) return;
    const oldFd = this.fd;
    fs.mkdirSync(this.dir, { recursive: true });
    this.fd = fs.openSync(this.journalPath, "a");
    fs.closeSync(oldFd);
    this.baseSeq = this.baseSeq + this.seq; // ops already appended live only in memory
    this.seq = 0;
    this.head = GENESIS;
    this.rebaseFlag = true;
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ baseSeq: this.baseSeq, rebasedAt: new Date().toISOString(), reason: "journal-file-vanished-mid-run" }),
    );
  }

  /** Public disk verification — call periodically (external actors delete data
   *  dirs in this sandbox; a deletion during an append-gap used to go unnoticed
   *  until boot, silently reverting the ledger to its last snapshot). Returns
   *  true if a heal happened. */
  diskCheck(): boolean {
    if (fs.existsSync(this.journalPath)) return false;
    this.healIfVanished();
    return true;
  }

  /** Snapshot-anchored restart: the journal file is empty but a verified
   *  snapshot carries the state. The new chain segment continues AFTER the
   *  snapshot's global seq (recorded in meta so future boots verify it). */
  rebase(baseSeq: number): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.fd = fs.openSync(this.journalPath, "w"); // fresh, empty
    this.baseSeq = baseSeq;
    this.seq = 0;
    this.head = GENESIS;
    this.rebaseFlag = true;
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ baseSeq: this.baseSeq, rebasedAt: new Date().toISOString(), reason: "snapshot-anchored-restart" }),
    );
  }

  readSnapshot():
    | { at: string; seq: number; head: string; accounts: SAccount[]; entries: SEntry[]; transactions: STx[] }
    | null {
    if (!fs.existsSync(this.snapshotPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    } catch {
      return null; // snapshot is a fast-path ONLY — a corrupt snapshot folds from zero
    }
  }

  close(): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

// ─── Fold: verified records → trusted state (with conservation checks) ──────

export interface FoldedState {
  accounts: Map<string, Account>;
  entries: JournalEntry[];
  transactions: LedgerTransaction[];
}

export function fold(records: Envelope<JournalRecord>[]): FoldedState {
  return foldOnto(records, { accounts: [], entries: [], transactions: [] });
}

/** Continuation fold: apply records ON TOP of an existing trusted state
 *  (snapshot-anchored tail replay). Same laws, same failures. */
export function foldOnto(
  records: Envelope<JournalRecord>[],
  base: { accounts: Account[]; entries: JournalEntry[]; transactions: LedgerTransaction[] },
): FoldedState {
  const accounts = new Map<string, Account>();
  const entries: JournalEntry[] = [...base.entries];
  const transactions: LedgerTransaction[] = [...base.transactions];
  for (const a of base.accounts) {
    if (accounts.has(a.id)) throw new JournalError(`fold: duplicate account ${a.id}`, "FOLD_DUPLICATE_ACCOUNT");
    accounts.set(a.id, a);
  }

  const applyOp = (op: OpRecord): void => {
    for (const sa of op.accounts) {
      if (accounts.has(sa.id)) {
        throw new JournalError(`fold: duplicate account ${sa.id}`, "FOLD_DUPLICATE_ACCOUNT");
      }
      accounts.set(sa.id, account(sa));
    }
    if (op.tx) {
      const t = txOf(op.tx);
      if (op.entries.length !== 2) {
        throw new JournalError(
          `fold: tx ${t.id} has ${op.entries.length} entries — double-entry requires exactly 2`,
          "FOLD_ENTRY_COUNT",
        );
      }
      const [d, c] = op.entries.map(entryOf);
      if (d.type !== "debit" || c.type !== "credit") {
        throw new JournalError(`fold: tx ${t.id} entry types are ${d.type}/${c.type} — illegal`, "FOLD_ENTRY_TYPES");
      }
      if (!(d.amount === t.amount && c.amount === t.amount)) {
        throw new JournalError(
          `fold: tx ${t.id} amounts do not conserve (${d.amount}/${c.amount} vs ${t.amount})`,
          "FOLD_CONSERVATION",
        );
      }
      if (d.accountId !== t.debitAccountId || c.accountId !== t.creditAccountId) {
        throw new JournalError(`fold: tx ${t.id} entries do not match tx accounts`, "FOLD_ENTRY_ACCOUNT");
      }
      const da = accounts.get(d.accountId);
      const ca = accounts.get(c.accountId);
      if (!da || !ca) {
        throw new JournalError(`fold: tx ${t.id} references unknown account(s)`, "FOLD_UNKNOWN_ACCOUNT");
      }
      da.balance -= d.amount;
      ca.balance += c.amount;
      entries.push(d, c);
      transactions.push(t);
    }
  };

  for (const env of records) {
    if (env.rec.t !== "op") {
      throw new JournalError(`fold: unknown record type ${(env.rec as { t: string }).t}`, "FOLD_UNKNOWN_RECORD");
    }
    applyOp(env.rec);
  }
  return { accounts, entries, transactions };
}

// ─── Idempotency payload (persisted inside the op line) ──────────────────────

type IdemHit =
  | { kind: "tx"; tx: LedgerTransaction }
  | { kind: "account"; account: Account };

// ─── PersistentLedger — PaymentProvider with a verified journal ──────────────

export interface OpenOptions {
  /** "full" (default): fold the entire journal and cross-check the snapshot path. */
  verify?: "full" | "fast";
  /** Ops between snapshots (default 100). */
  snapshotEvery?: number;
}

export class PersistentLedger implements PaymentProvider {
  private inner: InMemoryLedger;
  private journal: Journal<JournalRecord>;
  private idem = new Map<string, IdemHit>();
  private knownAccounts = new Set<string>();
  private opsSinceSnapshot = 0;
  private snapshotEvery: number;
  bootedAt: string;
  private fullFoldDone = false;
  private bootBaseSeq = 0;

  private constructor(inner: InMemoryLedger, journal: Journal, opts: OpenOptions) {
    this.inner = inner;
    this.journal = journal;
    this.snapshotEvery = opts.snapshotEvery ?? 100;
    this.bootedAt = new Date().toISOString();
  }

  /** Boot: open journal → verify chain → snapshot/tail/full-fold/anchored → restore.
   *  Handles honestly the case where the data dir vanished under a running
   *  process: empty journal + valid snapshot = snapshot-anchored restart. */
  static async open(dir: string, opts: OpenOptions = {}): Promise<PersistentLedger> {
    const journal = new Journal<JournalRecord>(dir);
    const { records } = journal.open(); // throws on any chain/tamper issue

    let inner: InMemoryLedger;
    const snap = journal.readSnapshot();
    const base = journal.base;

    let didFullFold = false;
    if (records.length === 0 && snap) {
      // Snapshot-anchored restart: the journal file is empty (vanished mid-run
      // or rebased away) but the snapshot carries the verified state.
      inner = InMemoryLedger.restore({
        accounts: snap.accounts.map(account),
        entries: snap.entries.map(entryOf),
        transactions: snap.transactions.map(txOf),
      });
      journal.rebase(snap.seq);
      console.warn(
        `[persistent-ledger] journal empty — snapshot-anchored restart at global seq ${snap.seq} (state restored, chain re-anchored)`,
      );
    } else if (records.length === 0 && base > 0) {
      // Meta claims a re-anchored history but no snapshot carries it — the
      // anchor is broken. Silently starting fresh would hide the loss.
      throw new JournalError(
        `boot: journal re-anchored at seq ${base} but no snapshot holds that state — refusing (fail-closed)`,
        "BOOT_UNANCHORED",
      );
    } else if (records.length === 0) {
      inner = InMemoryLedger.restore({ accounts: [], entries: [], transactions: [] });
    } else if (snap && snap.seq === base + records.length && snap.head === records[records.length - 1].hash) {
      // Fast path: snapshot sits exactly at the journal head.
      inner = InMemoryLedger.restore({
        accounts: snap.accounts.map(account),
        entries: snap.entries.map(entryOf),
        transactions: snap.transactions.map(txOf),
      });
      if ((opts.verify ?? "full") === "full" && base === 0) {
        // Full-history cross-check is only possible on a complete chain.
        const folded = fold(records);
        const full = InMemoryLedger.restore({
          accounts: [...folded.accounts.values()],
          entries: folded.entries,
          transactions: folded.transactions,
        });
        const hashOf = (rows: Account[]) =>
          createHash("sha256").update(canonicalJson(rows.map(sAccount))).digest("hex");
        if (hashOf(full.exportState().accounts) !== hashOf(inner.exportState().accounts)) {
          throw new JournalError(
            "boot: snapshot path and full-fold path disagree — refusing (fail-closed)",
            "BOOT_DISAGREE",
          );
        }
        didFullFold = true;
      }
    } else if (base > 0) {
      // Re-anchored chain (rebase/heal): the journal carries only the records
      // after its anchor. The snapshot covers everything up to its own global
      // seq — restore it and fold only the tail after it.
      if (!snap) {
        throw new JournalError(
          `boot: re-anchored journal (base ${base}) without a matching snapshot — refusing (fail-closed)`,
          "BOOT_UNANCHORED",
        );
      }
      if (snap.seq > base + records.length) {
        throw new JournalError(
          `boot: snapshot seq ${snap.seq} is ahead of the journal head ${base + records.length} — refusing (fail-closed)`,
          "BOOT_DISAGREE",
        );
      }
      if (snap.seq < base) {
        throw new JournalError(
          `boot: snapshot seq ${snap.seq} predates the re-anchor ${base} — refusing (fail-closed)`,
          "BOOT_UNANCHORED",
        );
      }
      const cut = snap.seq - base;
      if (cut === records.length && snap.head !== records[records.length - 1].hash) {
        throw new JournalError(
          "boot: snapshot claims the journal head but the chain disagrees — refusing (fail-closed)",
          "BOOT_DISAGREE",
        );
      }
      const tail = foldOnto(records.slice(cut), {
        accounts: snap.accounts.map(account),
        entries: snap.entries.map(entryOf),
        transactions: snap.transactions.map(txOf),
      });
      inner = InMemoryLedger.restore({
        accounts: [...tail.accounts.values()],
        entries: tail.entries,
        transactions: tail.transactions,
      });
      console.warn(
        `[persistent-ledger] tail replay: ${records.length - cut} records applied on snapshot @${snap.seq} (re-anchored chain)`,
      );
    } else {
      const folded = fold(records);
      inner = InMemoryLedger.restore({
        accounts: [...folded.accounts.values()],
        entries: folded.entries,
        transactions: folded.transactions,
      });
      if (snap) console.warn("[persistent-ledger] snapshot stale/foreign — folded entire journal");
    }

    const led = new PersistentLedger(inner, journal, opts);
    led.fullFoldDone = didFullFold;
    led.bootBaseSeq = base;
    for (const env of records) {
      const r = env.rec;
      if (r.t === "op" && r.idemKey && r.idemResponse) {
        led.idem.set(
          r.idemKey,
          r.idemResponse.kind === "tx"
            ? { kind: "tx", tx: txOf(r.idemResponse.tx) }
            : { kind: "account", account: account(r.idemResponse.account) },
        );
      }
    }
    for (const a of inner.exportState().accounts) led.knownAccounts.add(a.id);
    return led;
  }

  stats(): { seq: number; head: string; accounts: number; bootAt: string; fullFold: boolean; baseSeq: number } {
    return {
      seq: this.journal.sequence,
      head: this.journal.chainHead,
      accounts: this.knownAccounts.size,
      bootAt: this.bootedAt,
      fullFold: this.fullFoldDone,
      baseSeq: this.bootBaseSeq,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private journalNewAccounts(tenantId: string): SAccount[] {
    const fresh: SAccount[] = [];
    for (const a of this.inner.exportState().accounts) {
      if (a.tenantId === tenantId && !this.knownAccounts.has(a.id)) {
        this.knownAccounts.add(a.id);
        // Event-sourcing law: a FIRST-SEEN account is journaled with its
        // CREATION balance (always 0 by construction — createAccount and the
        // lazy reserve both start at 0n). The op's own entries are then
        // applied by fold on top. Journaling the POST-op balance here would
        // double-apply the op during replay (measured: reserve −10.00 twice —
        // caught by the boot cross-check, BOOT_DISAGREE, exactly as designed).
        fresh.push({ ...sAccount(a), balance: "0" });
      }
    }
    return fresh;
  }

  private recordAndMaybeSnapshot(rec: JournalRecord): void {
    this.journal.append(rec);
    this.opsSinceSnapshot++;
    // A re-anchored chain (rebase/heal) MUST snapshot on the next op — until
    // then the disk has no state that matches the new chain segment.
    if (this.opsSinceSnapshot >= this.snapshotEvery || this.journal.consumeRebaseFlag()) {
      this.writeSnapshotNow();
    }
  }

  private writeSnapshotNow(): void {
    this.journal.writeSnapshot(this.inner.exportState());
    this.opsSinceSnapshot = 0;
  }

  private idemReplay(key: string): IdemHit | null {
    return this.idem.get(key) ?? null;
  }

  /** Trusted-state export (backup / verification / tests). */
  exportState(): { accounts: Account[]; entries: JournalEntry[]; transactions: LedgerTransaction[] } {
    return this.inner.exportState();
  }

  /** Periodic disk maintenance: if the journal file vanished under the running
   *  process, heal now (re-anchor) and snapshot immediately — the loss window
   *  shrinks from "until the next append" to the maintenance interval.
   *  Returns true if a heal happened. */
  diskMaintenance(): boolean {
    const healed = this.journal.diskCheck();
    if (healed) this.writeSnapshotNow();
    return healed;
  }

  // ─── PaymentProvider (delegate → journal → return) ─────────────────────────

  async createAccount(tenantId: string, ownerId: string, type: AccountType, name: string, idem?: string): Promise<Account> {
    const hit = idem ? this.idemReplay(idem) : null;
    if (hit) {
      if (hit.kind !== "account") throw new LedgerError("idempotency key bound to a transaction, not an account", "IDEM_KIND_MISMATCH");
      return { ...hit.account };
    }
    const acc = await this.inner.createAccount(tenantId, ownerId, type, name);
    this.knownAccounts.add(acc.id);
    this.recordAndMaybeSnapshot({
      t: "op",
      accounts: [sAccount(acc)],
      tx: null,
      entries: [],
      idemKey: idem ?? null,
      idemResponse: { kind: "account", account: sAccount(acc) },
    });
    if (idem) this.idem.set(idem, { kind: "account", account: acc });
    return acc;
  }

  async getAccount(tenantId: string, accountId: string): Promise<Account> {
    return this.inner.getAccount(tenantId, accountId);
  }

  async listAccounts(tenantId: string): Promise<Account[]> {
    return this.inner.listAccounts(tenantId);
  }

  async guardMint(tenantId: string, toAccountId: string, amount: MicroCents, memo: string, initiatedBy: string, idem?: string): Promise<LedgerTransaction> {
    const hit = idem ? this.idemReplay(idem) : null;
    if (hit) {
      if (hit.kind !== "tx") throw new LedgerError("idempotency key bound to an account, not a transaction", "IDEM_KIND_MISMATCH");
      return { ...hit.tx };
    }
    const t = await this.inner.guardMint(tenantId, toAccountId, amount, memo, initiatedBy);
    this.recordAndMaybeSnapshot({
      t: "op",
      accounts: this.journalNewAccounts(tenantId),
      tx: sTx(t),
      entries: this.lastEntriesFor(t),
      idemKey: idem ?? null,
      idemResponse: { kind: "tx", tx: sTx(t) },
    });
    if (idem) this.idem.set(idem, { kind: "tx", tx: t });
    return t;
  }

  async guardWithdraw(tenantId: string, fromAccountId: string, amount: MicroCents, memo: string, initiatedBy: string, idem?: string): Promise<LedgerTransaction> {
    const hit = idem ? this.idemReplay(idem) : null;
    if (hit) {
      if (hit.kind !== "tx") throw new LedgerError("idempotency key bound to an account, not a transaction", "IDEM_KIND_MISMATCH");
      return { ...hit.tx };
    }
    const t = await this.inner.guardWithdraw(tenantId, fromAccountId, amount, memo, initiatedBy);
    this.recordAndMaybeSnapshot({
      t: "op",
      accounts: this.journalNewAccounts(tenantId),
      tx: sTx(t),
      entries: this.lastEntriesFor(t),
      idemKey: idem ?? null,
      idemResponse: { kind: "tx", tx: sTx(t) },
    });
    if (idem) this.idem.set(idem, { kind: "tx", tx: t });
    return t;
  }

  async transfer(tenantId: string, fromAccountId: string, toAccountId: string, amount: MicroCents, memo: string, initiatedBy: string, idem?: string): Promise<LedgerTransaction> {
    const hit = idem ? this.idemReplay(idem) : null;
    if (hit) {
      if (hit.kind !== "tx") throw new LedgerError("idempotency key bound to an account, not a transaction", "IDEM_KIND_MISMATCH");
      return { ...hit.tx };
    }
    const t = await this.inner.transfer(tenantId, fromAccountId, toAccountId, amount, memo, initiatedBy);
    this.recordAndMaybeSnapshot({
      t: "op",
      accounts: this.journalNewAccounts(tenantId),
      tx: sTx(t),
      entries: this.lastEntriesFor(t),
      idemKey: idem ?? null,
      idemResponse: { kind: "tx", tx: sTx(t) },
    });
    if (idem) this.idem.set(idem, { kind: "tx", tx: t });
    return t;
  }

  async getTransactions(tenantId: string, accountId: string): Promise<LedgerTransaction[]> {
    return this.inner.getTransactions(tenantId, accountId);
  }

  async proofOfSolvency(tenantId: string): Promise<SolvencyProof> {
    return this.inner.proofOfSolvency(tenantId);
  }

  /** The two entries this tx wrote (they are the tail of each account's list). */
  private lastEntriesFor(t: LedgerTransaction): SEntry[] {
    const state = this.inner.exportState();
    const d = [...state.entries].reverse().find((e) => e.transactionId === t.id && e.accountId === t.debitAccountId);
    const c = [...state.entries].reverse().find((e) => e.transactionId === t.id && e.accountId === t.creditAccountId);
    if (!d || !c) {
      throw new JournalError(`internal: entries for tx ${t.id} not found`, "INTERNAL_ENTRY_MISS");
    }
    return [sEntry(d), sEntry(c)];
  }

  close(): void {
    this.journal.close();
  }
}

// ─── Decimal → μ¢ (never float) ──────────────────────────────────────────────

/** Parse a decimal string like "1.23" into exact BigInt μ¢ (12300n). */
export function parseMicroCents(s: string): MicroCents {
  if (typeof s !== "string" || !/^\d+(\.\d{1,4})?$/.test(s)) {
    throw new LedgerError(
      `amount must be a decimal string with ≤4 digits after the point (got ${JSON.stringify(s)})`,
      "INVALID_AMOUNT_FORMAT",
    );
  }
  const [int, frac = ""] = s.split(".");
  const frac4 = (frac + "0000").slice(0, 4);
  return BigInt(int) * 10000n + BigInt(frac4);
}

/** μ¢ → decimal string, exact. */
export function microCentsToString(v: MicroCents): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / 10000n;
  const frac = (abs % 10000n).toString().padStart(4, "0");
  return (neg ? "-" : "") + int.toString() + "." + frac;
}
