import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawnSync } from "node:child_process";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// GET /api/durability — לוח-העמידות: מה באמת שורד מחיקת-סנדבוקס, נמדד עכשיו.
// אפס-סודות בפלט (SHAs ושמות בלבד; הטוקן חי רק בתוך ה-URL של ls-remote ומעולם
// לא מודפס). כל-שכבה מדווחת מצב כנה: protected / stale / unknown — אף-פעם לא
// "ירוק" מתוך-תקווה.

const CP = "/home/z/my-project";
const RUNNER = `${CP}/mini-services/fleet-runner`;
const SNAP_DIR = `${CP}/state-snapshots`;
const REPO = "/home/z/repos/roshpina";
const TOKEN_FILE = process.env.FLEET_TOKEN_FILE ?? `${CP}/upload/pat.env`;

function readToken(): string {
  try {
    return existsSync(TOKEN_FILE)
      ? readFileSync(TOKEN_FILE, "utf8").match(/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/)?.[0] ?? ""
      : "";
  } catch {
    return "";
  }
}

function sh(cmd: string[], cwd?: string): string {
  try {
    // node:child_process — works under BOTH runtimes (next-server is Node; the
    // old Bun.spawnSync silently returned "" here and the board honestly said unknown)
    const p = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return `${p.stdout ?? ""}`.trim();
  } catch {
    return "";
  }
}

type LastJob = { status: string; at: string };

function lastJobFor(preset: string): LastJob | null {
  try {
    const lines = readFileSync(`${RUNNER}/data/jobs.jsonl`, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]) as { presetId?: string; preset?: string; status?: string; ranAt?: string; startedAt?: string; finishedAt?: string };
        if ((j.presetId ?? j.preset) === preset && j.status && j.status !== "running") {
          return { status: j.status, at: j.finishedAt ?? j.ranAt ?? j.startedAt ?? "" };
        }
      } catch {
        /* torn line — skip */
      }
    }
  } catch {
    /* no journal yet */
  }
  return null;
}

function ageMin(iso: string): number | null {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
}

type RemoteRefs = {
  reachable: boolean;
  estateBranch: string | null;
  controlPlaneBranch: string | null;
  workBranch: string | null;
  workArchiveTag: string | null;
  estateArchiveTag: string | null;
  controlPlaneArchiveTag: string | null;
  dailyAnchors: string[];
};

function remoteRefs(token: string): RemoteRefs {
  const empty: RemoteRefs = { reachable: false, estateBranch: null, controlPlaneBranch: null, workBranch: null, workArchiveTag: null, estateArchiveTag: null, controlPlaneArchiveTag: null, dailyAnchors: [] };
  if (!token) return empty;
  const out = sh(
    [
      "git", "ls-remote",
      `https://x-access-token:${token}@github.com/roshpinacare-sys/roshpina.git`,
      "refs/heads/agent4/estate-vault",
      "refs/heads/agent4/control-plane",
      "refs/heads/agent4/p2-sovereign-market",
      "refs/tags/archive/agent4/p2-sovereign-market",
      "refs/tags/archive/agent4/estate-vault",
      "refs/tags/archive/agent4/control-plane",
      "refs/tags/estate-daily/*",
    ],
    REPO
  );
  if (!out) return empty;
  const refs: RemoteRefs = { ...empty, reachable: true };
  const short = (s: string) => s.slice(0, 7);
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split(/\t/);
    if (!sha || !ref) continue;
    if (ref === "refs/heads/agent4/estate-vault") refs.estateBranch = short(sha);
    else if (ref === "refs/heads/agent4/control-plane") refs.controlPlaneBranch = short(sha);
    else if (ref === "refs/heads/agent4/p2-sovereign-market") refs.workBranch = short(sha);
    else if (ref === "refs/tags/archive/agent4/p2-sovereign-market") refs.workArchiveTag = short(sha);
    else if (ref === "refs/tags/archive/agent4/estate-vault") refs.estateArchiveTag = short(sha);
    else if (ref === "refs/tags/archive/agent4/control-plane") refs.controlPlaneArchiveTag = short(sha);
    else if (ref.startsWith("refs/tags/estate-daily/")) refs.dailyAnchors.push(ref.replace("refs/tags/estate-daily/", ""));
  }
  refs.dailyAnchors.sort();
  return refs;
}

function newestCapsule(): { name: string; ageMin: number; sizeKB: number } | null {
  try {
    const caps = readdirSync(SNAP_DIR).filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz")).sort();
    if (caps.length === 0) return null;
    const name = caps[caps.length - 1];
    const st = statSync(`${SNAP_DIR}/${name}`);
    return { name, ageMin: Math.max(0, Math.round((Date.now() - st.mtimeMs) / 60_000)), sizeKB: Math.round(st.size / 1024) };
  } catch {
    return null;
  }
}

type LayerStatus = "protected" | "stale" | "unknown";
type Layer = {
  id: string;
  label: string;
  what: string;
  status: LayerStatus;
  detail: string;
  remoteSha?: string | null;
  lastJob?: LastJob | null;
};

function jobOk(lj: LastJob | null): boolean {
  return !!lj && lj.status === "succeeded";
}

export async function GET() {
  const token = readToken();
  const remote = remoteRefs(token);
  const capsule = newestCapsule();

  const estateJob = lastJobFor("estate-vault");
  const cpJob = lastJobFor("control-plane-backup");
  const stateJob = lastJobFor("state-backup");
  const drillJob = lastJobFor("dr-drill");

  const estateAge = estateJob ? ageMin(estateJob.at) : null;
  const cpAge = cpJob ? ageMin(cpJob.at) : null;
  const drillAge = drillJob ? ageMin(drillJob.at) : null;

  // כנות-דו-כיוונית: הענפים ב-origin נמחקים-שוב-ושוב (wipe #1–7 נמדדו) — אבל תגי-ה-archive
  // שורדים ומחזיקים את-אותם-SHA-ים בדיוק. ענף-חסר + תג-קיים = הגנה מוכחת, לא unknown
  // (לא-לשקר למעלה ולא-להשפיל למטה — לדווח מה שיש).
  const estateProtected =
    (remote.reachable && remote.estateBranch && jobOk(estateJob) && estateAge !== null && estateAge <= 240) ||
    (remote.reachable && !remote.estateBranch && remote.estateArchiveTag && jobOk(estateJob));
  const estateStale = remote.estateBranch && jobOk(estateJob) && !estateProtected;
  const estateStatus: LayerStatus = estateProtected ? "protected" : estateStale ? "stale" : "unknown";
  const cpProtected =
    (remote.reachable && remote.controlPlaneBranch && jobOk(cpJob) && cpAge !== null && cpAge <= 1500) ||
    (remote.reachable && !remote.controlPlaneBranch && remote.controlPlaneArchiveTag && jobOk(cpJob));
  const cpStale = remote.controlPlaneBranch && jobOk(cpJob) && !cpProtected;
  const cpStatus: LayerStatus = cpProtected ? "protected" : cpStale ? "stale" : "unknown";
  const workStatus: LayerStatus = remote.reachable ? (remote.workArchiveTag ? "protected" : "unknown") : "unknown";
  const drillStatus: LayerStatus = jobOk(drillJob) ? "protected" : drillJob ? "stale" : "unknown";

  const layers: Layer[] = [
    {
      id: "code",
      label: "קוד מטוס-הבקרה",
      what: "ענף agent4/control-plane + תג-archive — כל-הקוד והסקריפטים, בלי סודות",
      status: cpStatus,
      detail: remote.controlPlaneBranch
        ? `remote @ ${remote.controlPlaneBranch}${cpJob ? ` · ריצה אחרונה ${cpJob.status} לפני ${cpAge ?? "?"} דק'` : ""}`
        : remote.controlPlaneArchiveTag
          ? `branch חסר-ב-origin (מחיקה-ידועה) — archive-tag @ ${remote.controlPlaneArchiveTag} מחזיק את-הקוד${cpJob ? ` · ריצה אחרונה ${cpJob.status} לפני ${cpAge ?? "?"} דק'` : ""}`
          : "remote לא נגיש — לא ניתן לאמת כרגע (כנות: unknown)",
      remoteSha: remote.controlPlaneBranch ?? remote.controlPlaneArchiveTag,
      lastJob: cpJob,
    },
    {
      id: "estate",
      label: "מצב-הכסף + ראיות",
      what: "ענף agent4/estate-vault — קפסולה חתוכת-טיפות + יומנים + DB + ראיות + worklog, מניפסט-SHA256",
      status: estateStatus,
      detail: [
        remote.estateBranch
          ? `remote @ ${remote.estateBranch}`
          : remote.estateArchiveTag
            ? `remote: branch חסר (מחיקה-ידועה) — archive-tag @ ${remote.estateArchiveTag} מחזיק הכל (קפסולה+מניפסט)`
            : "remote: לא נמצא (ענף נמחק? — התג-archive והעוגנים היומיים נשארים)",
        estateJob ? `ריצה אחרונה ${estateJob.status} לפני ${estateAge ?? "?"} דק'` : "אין ריצות",
        capsule ? `קפסולה: ${capsule.name} (${capsule.sizeKB}KB, בת ${capsule.ageMin} דק')` : "אין קפסולות מקומיות",
        remote.dailyAnchors.length ? `עוגנים-יומיים ב-origin: ${remote.dailyAnchors.length}` : "עוד אין עוגנים-יומיים",
      ].join(" · "),
      remoteSha: remote.estateBranch ?? remote.estateArchiveTag,
      lastJob: estateJob,
    },
    {
      id: "work",
      label: "ענף-העבודה (רושפינה)",
      what: "agent4/p2-sovereign-market — ההיסטוריה האמיתית של הקוד שהרשת כתבה; מוגן גם-כן בתג-archive",
      status: workStatus,
      detail: remote.workBranch
        ? `branch @ ${remote.workBranch} · archive-tag @ ${remote.workArchiveTag ?? "?"}`
        : `branch חסר-ב-origin (מחיקה-ידועה) — archive-tag @ ${remote.workArchiveTag ?? "לא נמצא"} מחזיק את הכל`,
      remoteSha: remote.workBranch ?? remote.workArchiveTag,
    },
    {
      id: "drill",
      label: "תרגיל-אסון חי",
      what: "dr-drill — קוד+מצב מ-origin בלבד מקימים שני-צמתי-כסף חיים ב-/tmp (שער-שלמות + verify:full)",
      status: drillStatus,
      detail: drillJob ? `ריצה אחרונה ${drillJob.status} לפני ${drillAge ?? "?"} דק'` : "עוד לא רץ מהרשת — הפעלה דרך המסוף (preset: dr-drill)",
      lastJob: drillJob,
    },
  ];

  const settlementAge = stateJob ? ageMin(stateJob.at) : null;

  return NextResponse.json(
    {
      ok: true,
      checkedAt: new Date().toISOString(),
      remote,
      capsule,
      layers,
      settlement: {
        label: "מראת-ההתיישבות (ledger-sync)",
        lastJob: stateJob,
        ageMin: settlementAge,
        detail: stateJob ? `ריצה אחרונה ${stateJob.status} לפני ${settlementAge ?? "?"} דק'` : "אין ריצות",
      },
      note: "מדוד חי מהיומן ומ-origin בזמן-אמת — אין-מצב-גדולה: שכבה שלא ניתן לאמת מדווחת unknown בכנות",
    },
    { headers: NO_STORE }
  );
}
