'use client'

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SovereigntyCard } from "@/components/SovereigntyCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Activity, BookOpenText, BrainCircuit, CalendarClock, CheckCircle2, Clock3, Coins, FileText, Hammer, KeyRound, Loader2, PenLine, Radio, RefreshCw, Server, ShieldCheck, Terminal, Trash2, UserPlus, XCircle, AlertTriangle } from "lucide-react";
import { ownerHeaders, isOwnerDenied, setOwnerToken, clearOwnerToken, getOwnerToken } from "@/lib/owner-gate";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ─── Types ───────────────────────────────────────────────────────────────────

interface NodeProbe {
  id: string;
  name: string;
  port: number;
  kind: string;
  up: boolean;
  httpStatus: number;
  latencyMs: number;
  body: Record<string, unknown> | null;
  error?: string;
}

interface Preset {
  id: string;
  label: string;
  description: string;
  timeoutMs: number;
}

interface JobSummary {
  id: string;
  preset: string;
  label: string;
  status: "running" | "succeeded" | "failed" | "timeout";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  trigger?: "manual" | "schedule";
}

interface Schedule {
  id: string;
  presetId: string;
  intervalSec: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastStatus: string | null;
  nextRunAt: string;
  runCount: number;
  failCount: number;
  skippedCount: number;
}

interface JobFull extends JobSummary {
  cwd: string;
  cmd: string[];
  stdout: string;
  stderr: string;
  truncated: boolean;
  restored?: boolean;
}

interface EconOp {
  kind: string;
  epoch: string;
  agentId: string;
  amount: string;
}

interface EconReport {
  settledTrades: number;
  treasury?: { usds: string };
  epochOps?: EconOp[];
  conservation: { quote: { holds: boolean; fees: string; staked: string }; base: { holds: boolean } };
  agents: { agentId: string; usds: string; usdsLocked: string; usdsStaked: string }[];
}

interface RunnerHealth {
  ok?: boolean;
  uptimeSec?: number;
  jobsTotal?: number;
  schedulesCount?: number;
  tickCount?: number;
  watchdog?: { healCount?: number; lastCheckAt?: string; lastResult?: string };
  presets?: string[];
}

interface BuildTask {
  id: string;
  title: string;
  why?: string;
  action: string;
  detail?: string;
}

interface BuildReport {
  builtAt: string;
  cycle: number;
  live: Record<string, unknown>;
  stats: { trades: number; ledgerSeq: number; agents: number; jobsTotal: number; schedulesGreen: number; schedulesEnabled: number };
  whatWasBuilt: string[];
  plan: { generatedAt: string | null; model: string | null; mission: string | null; tasks: BuildTask[] } | null;
  insight: { at: string | null; model: string | null; text: string } | null;
  commits: { roshpina: string[]; control: string[] };
}

interface BuildStatus {
  report: BuildReport | null;
  plan: { generatedAt?: string; model?: string; mission?: string; tasks?: BuildTask[] } | null;
  cycles: number | null;
}

interface InsightRec {
  taskId: string;
  planGeneratedAt: string;
  title: string;
  why: string;
  action: string;
  mission: string;
  body: string;
  model: string;
  executedAt: string;
  cycle: number;
}

interface InsightsStatus {
  insights: InsightRec[];
  plan: { generatedAt?: string; mission?: string; model?: string; tasks?: number } | null;
  progress: { done: number; total: number; executedTotal: number };
}

interface NetItem {
  id: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
}

interface NetStatus {
  items: NetItem[];
  exists: boolean;
  invalid?: boolean;
  publishedAt?: string | null;
}

type DurabilityStatus = "protected" | "stale" | "unknown";

interface DurabilityLayer {
  id: string;
  label: string;
  what: string;
  status: DurabilityStatus;
  detail: string;
  remoteSha?: string | null;
}

interface DurabilityData {
  ok: boolean;
  checkedAt: string;
  remote: {
    reachable: boolean;
    estateBranch: string | null;
    controlPlaneBranch: string | null;
    workBranch: string | null;
    workArchiveTag: string | null;
    dailyAnchors: string[];
  };
  capsule: { name: string; ageMin: number; sizeKB: number } | null;
  layers: DurabilityLayer[];
  settlement: { label: string; detail: string; ageMin: number | null };
}

const DURABILITY_META: Record<DurabilityStatus, { label: string; cls: string }> = {
  protected: { label: "מוגן", cls: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" },
  stale: { label: "מיושן", cls: "border-orange-300 text-orange-700" },
  unknown: { label: "לא ניתן לאימות", cls: "border-zinc-300 text-zinc-500" },
};

const NET_KIND_META: Record<string, { label: string; cls: string }> = {
  broadcast: { label: "שידור", cls: "border-teal-300 text-teal-700" },
  note: { label: "פתק", cls: "border-zinc-300 text-zinc-600" },
  milestone: { label: "אבן-דרך", cls: "border-emerald-300 text-emerald-700" },
  commitment: { label: "מחויבות", cls: "border-amber-300 text-amber-700" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; cls: string }> = {
  running: { label: "רץ כעת", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  succeeded: { label: "הצליח", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  failed: { label: "נכשל", cls: "bg-red-100 text-red-800 border-red-200" },
  timeout: { label: "פסק-זמן", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  skipped: { label: "דולג (runner עסוק)", cls: "bg-zinc-100 text-zinc-700 border-zinc-200" },
};

function nodeDetail(n: NodeProbe): string {
  if (!n.up || !n.body) return n.error ? n.error.slice(0, 60) : `http ${n.httpStatus}`;
  switch (n.id) {
    case "runner":
      return `uptime ${n.body.uptimeSec}s · ${n.body.jobsTotal} jobs`;
    case "ledger":
      return `seq ${n.body.seq} · ${n.body.accounts} accounts · ${Number(n.body.operatorKeys) === 0 ? "fail-closed" : "operator-keys"}`;
    case "market":
      return `${n.body.trades} trades · book ${n.body.bids}×${n.body.asks}`;
    default:
      return `http ${n.httpStatus}`;
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("he-IL", { hour12: false });
}

function fmtInterval(sec: number): string {
  if (sec % 3600 === 0) return `כל ${sec / 3600} שע'`;
  if (sec % 60 === 0) return `כל ${sec / 60} דק'`;
  return `כל ${sec} שנ'`;
}

function fmtCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s} שנ'`;
}

interface AiStatus {
  vault: { unsealed: boolean; sealedBlob: boolean; entries: { name: string; algorithm: string; sha256: string; sealedAt: string; sizeBytes: number }[]; passphraseHolder: string | null };
  latest: { generatedAt: string; model: string; latencyMs: number; analysis: string; vaultSealed: boolean } | null;
}

// ─── Page ────────────────────────────────────────────────────────────────────

const KIND_META: Record<string, { label: string; cls: string }> = {
  payroll: { label: "שכר", cls: "bg-emerald-100 text-emerald-800" },
  tax: { label: "מס", cls: "bg-amber-100 text-amber-800" },
  reward: { label: "תגמול-סטייק", cls: "bg-violet-100 text-violet-800" },
  stake: { label: "סטייק", cls: "bg-zinc-200 text-zinc-800" },
  unstake: { label: "שחרור-סטייק", cls: "bg-zinc-100 text-zinc-600" },
  correction: { label: "תיקון-ספר", cls: "bg-sky-100 text-sky-800" },
};

export default function Home() {
  const { toast } = useToast();
  const [nodes, setNodes] = useState<NodeProbe[] | null>(null);
  const [probedAt, setProbedAt] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [runs, setRuns] = useState<JobSummary[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [currentJob, setCurrentJob] = useState<JobFull | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runnerUp, setRunnerUp] = useState(true);
  const termRef = useRef<HTMLDivElement>(null);

  // scheduler state
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedPreset, setSchedPreset] = useState("");
  const [schedInterval, setSchedInterval] = useState("300");
  const [schedBusy, setSchedBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [econ, setEcon] = useState<EconReport | null>(null);

  // sovereignty scorecard + self-licensing state
  const [runnerHealth, setRunnerHealth] = useState<RunnerHealth | null>(null);
  const [licName, setLicName] = useState("");
  const [licBusy, setLicBusy] = useState(false);

  // AI sentinel (NVIDIA NIM brain) state
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  // autonomous build (the network that builds, not only checks)
  const [build, setBuild] = useState<BuildStatus | null>(null);

  // sovereign knowledge journal (the network that writes itself)
  const [insights, setInsights] = useState<InsightsStatus | null>(null);
  const [selectedInsight, setSelectedInsight] = useState<InsightRec | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  const [netData, setNetData] = useState<NetStatus | null>(null);
  const [durability, setDurability] = useState<DurabilityData | null>(null);

  // owner gate (vault-backed, deny-by-default on mutations)
  const [ownerToken, setOwnerTokenState] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState("");

  useEffect(() => {
    setOwnerTokenState(getOwnerToken());
  }, []);

  const ownerDeniedToast = (data: unknown): boolean => {
    if (!isOwnerDenied(data)) return false;
    setUnlockOpen(true);
    toast({ title: "נדרש אימות-בעלים", description: "הפעולה נחסמה (deny-by-default) — פתח באמצעות סיסמת-הכספת", variant: "destructive" });
    return true;
  };

  const unlockOwner = async () => {
    setUnlockBusy(true);
    setUnlockError("");
    try {
      const res = await fetch("/api/owner/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: unlockInput }),
      });
      const data = await res.json();
      if (res.ok && typeof data.token === "string") {
        setOwnerToken(data.token);
        setOwnerTokenState(data.token);
        setUnlockInput("");
        setUnlockOpen(false);
        toast({ title: "מצב-בעלים פתוח", description: "כל-פעולות-השינוי זמינות בכרטיסייה זו" });
      } else if (res.status === 401) {
        setUnlockError("סיסמה שגויה");
      } else {
        setUnlockError(String(data.error ?? "שגיאה"));
      }
    } catch {
      setUnlockError("שירות-הפתיחה לא נגיש");
    } finally {
      setUnlockBusy(false);
    }
  };

  const lockOwner = () => {
    clearOwnerToken();
    setOwnerTokenState("");
    toast({ title: "מצב-בעלים ננעל", description: "פעולות-השינוי חסומות מחדש (deny-by-default)" });
  };

  // ── polling: network probe every 6s ──
  const refreshNodes = useCallback(async () => {
    try {
      const res = await fetch("/api/network", { cache: "no-store" });
      const data = await res.json();
      if (data.nodes) {
        setNodes(data.nodes);
        setProbedAt(data.probedAt);
        setRunnerUp(true);
      } else {
        setRunnerUp(false);
      }
    } catch {
      setRunnerUp(false);
    }
  }, []);

  // ── polling: runs list every 5s ──
  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.jobs)) setRuns(data.jobs);
      if (Array.isArray(data.presets)) setPresets(data.presets);
    } catch {
      /* keep last known truth */
    }
  }, []);

  const refreshJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store", headers: ownerHeaders() });
      if (res.status === 401) {
        setUnlockOpen(true);
        return undefined;
      }
      if (!res.ok) return;
      const data: JobFull = await res.json();
      setCurrentJob(data);
      return data;
    } catch {
      return undefined;
    }
  }, []);

  // ── polling: schedules every 5s ──
  const refreshSchedules = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.schedules)) setSchedules(data.schedules);
    } catch {
      /* keep last known truth */
    }
  }, []);

  const refreshEcon = useCallback(async () => {
    try {
      const res = await fetch("/api/economy", { cache: "no-store" });
      if (!res.ok) return;
      setEcon((await res.json()) as EconReport);
    } catch {
      /* node down — keep the last known truth */
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/runner/health", { cache: "no-store" });
      if (!res.ok) return;
      setRunnerHealth((await res.json()) as RunnerHealth);
    } catch {
      /* keep the last known truth */
    }
  }, []);

  const refreshAi = useCallback(async () => {
    try {
      const res = await fetch("/api/ai", { cache: "no-store" });
      if (!res.ok) return;
      setAi((await res.json()) as AiStatus);
    } catch {
      /* keep the last known truth */
    }
  }, []);

  const refreshBuild = useCallback(async () => {
    try {
      const res = await fetch("/api/build", { cache: "no-store" });
      if (!res.ok) return;
      setBuild((await res.json()) as BuildStatus);
    } catch {
      /* keep the last known truth */
    }
  }, []);

  const refreshInsights = useCallback(async () => {
    try {
      const res = await fetch("/api/insights", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as InsightsStatus;
      setInsights(data);
      setSelectedInsight((sel) => (sel ? data.insights.find((i) => i.taskId === sel.taskId && i.planGeneratedAt === sel.planGeneratedAt) ?? data.insights[0] ?? null : data.insights[0] ?? null));
    } catch {
      /* keep the last known truth */
    }
  }, []);

  const refreshNetData = useCallback(async () => {
    try {
      const res = await fetch("/api/net-data", { cache: "no-store" });
      if (!res.ok) return;
      setNetData((await res.json()) as NetStatus);
    } catch {
      /* keep the last known truth */
    }
  }, []);

  const refreshDurability = useCallback(async () => {
    try {
      const res = await fetch("/api/durability", { cache: "no-store" });
      if (!res.ok) return;
      setDurability((await res.json()) as DurabilityData);
    } catch {
      /* keep the last known truth */
    }
  }, []);

  useEffect(() => {
    refreshNodes();
    refreshRuns();
    refreshSchedules();
    refreshEcon();
    refreshHealth();
    const t1 = setInterval(refreshNodes, 6000);
    const t2 = setInterval(refreshRuns, 5000);
    const t3 = setInterval(refreshSchedules, 5000);
    const t4 = setInterval(() => setNowMs(Date.now()), 1000);
    const t5 = setInterval(refreshEcon, 6000);
    const t6 = setInterval(refreshHealth, 6000);
    const t7 = setInterval(refreshAi, 15000);
    const t8 = setInterval(refreshBuild, 10000);
    const t9 = setInterval(refreshInsights, 15000);
    const t10 = setInterval(refreshNetData, 15000);
    const t11 = setInterval(refreshDurability, 20000);
    refreshAi();
    refreshBuild();
    refreshInsights();
    refreshNetData();
    refreshDurability();
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); clearInterval(t6); clearInterval(t7); clearInterval(t8); clearInterval(t9); clearInterval(t10); clearInterval(t11); };
  }, [refreshNodes, refreshRuns, refreshSchedules, refreshEcon, refreshHealth, refreshAi, refreshBuild, refreshInsights, refreshNetData, refreshDurability]);

  // ── live-follow the running job ──
  useEffect(() => {
    if (!currentJob || currentJob.status !== "running") return;
    const t = setInterval(async () => {
      const j = await refreshJob(currentJob.id);
      if (j && j.status !== "running") {
        refreshRuns();
        refreshNodes();
      }
    }, 700);
    return () => clearInterval(t);
  }, [currentJob, refreshJob, refreshRuns, refreshNodes]);

  // ── auto-scroll terminal ──
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [currentJob]);

  const submitJob = async () => {
    if (!selectedPreset) {
      toast({ title: "בחר עבודה", description: "יש לבחור סוג עבודה מהרשימה", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ preset: selectedPreset }),
      });
      const data = await res.json();
      if (res.status === 202) {
        setCurrentJob(data as JobFull);
        toast({ title: "עבודה נשלחה", description: `${data.label} · ${data.id}` });
        refreshRuns();
      } else if (!ownerDeniedToast(data)) {
        toast({ title: "הדחייה נכשלה", description: data.error === "runner_busy" ? `ה-runner עסוק (${data.running}/${data.max})` : String(data.error), variant: "destructive" });
      }
    } catch {
      toast({ title: "runner לא נגיש", description: "שירות הביצוע לא מגיב", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const licenseAgent = async () => {
    const name = licName.trim();
    if (!/^[a-z][a-z0-9]{1,15}$/.test(name)) {
      toast({ title: "שם-סוכן לא תקין", description: "אותיות קטנות באנגלית וספרות, 2–16 תווים, מתחיל באות", variant: "destructive" });
      return;
    }
    setLicBusy(true);
    try {
      const res = await fetch("/api/agents/license", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ agentId: name }),
      });
      const data = await res.json();
      if (res.status === 202) {
        toast({ title: "רישוי-סוכן התחיל", description: `זהות חדשה נוצרת ונרשמת חתומה מול השוק · ${data.id}` });
        setCurrentJob(data as JobFull);
        setLicName("");
        refreshRuns();
        refreshEcon();
      } else if (!ownerDeniedToast(data)) {
        toast({ title: "הרישוי נדחה", description: String(data.error ?? "שגיאה לא-ידועה"), variant: "destructive" });
      }
    } catch {
      toast({ title: "runner לא נגיש", description: "שירות הביצוע לא מגיב", variant: "destructive" });
    } finally {
      setLicBusy(false);
    }
  };

  const runSentinel = async () => {
    setAiBusy(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ preset: "ai-sentinel" }),
      });
      const data = await res.json();
      if (res.status === 202) {
        toast({ title: "הסנטינל יצא לדרך", description: `מגייס מצב-רשת ומנתח עם NVIDIA NIM · ${data.id}` });
        setCurrentJob(data as JobFull);
        refreshRuns();
        // הניתוח לוקח עד ~דקה — רענון-מתוזמן אחרי סיום
        setTimeout(() => { refreshAi(); refreshRuns(); }, 75_000);
      } else if (!ownerDeniedToast(data)) {
        toast({ title: "ההרצה נדחתה", description: data.error === "runner_busy" ? `ה-runner עסוק (${data.running}/${data.max})` : String(data.error), variant: "destructive" });
      }
    } catch {
      toast({ title: "runner לא נגיש", description: "שירות הביצוע לא מגיב", variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  };

  const runExecutor = async () => {
    setExecBusy(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ preset: "plan-executor" }),
      });
      const data = await res.json();
      if (res.status === 202) {
        toast({ title: "המבצע יצא לדרך", description: `לוקח את תוכנית-האדריכל והופך אותה לידע מפורסם · ${data.id}` });
        setCurrentJob(data as JobFull);
        refreshRuns();
        setTimeout(() => { refreshInsights(); refreshRuns(); }, 95_000);
      } else if (!ownerDeniedToast(data)) {
        toast({ title: "ההרצה נדחתה", description: data.error === "runner_busy" ? `ה-runner עסוק (${data.running}/${data.max})` : String(data.error), variant: "destructive" });
      }
    } catch {
      toast({ title: "runner לא נגיש", description: "שירות הביצוע לא מגיב", variant: "destructive" });
    } finally {
      setExecBusy(false);
    }
  };

  const createSchedule = async () => {
    if (!schedPreset) {
      toast({ title: "בחר עבודה לתזמון", description: "יש לבחור סוג עבודה מהרשימה", variant: "destructive" });
      return;
    }
    const intervalSec = Number(schedInterval);
    if (!Number.isInteger(intervalSec) || intervalSec < 60) {
      toast({ title: "פרק-זמן לא תקין", description: "מינימום 60 שניות — הגנה על המכונה", variant: "destructive" });
      return;
    }
    setSchedBusy(true);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ preset: schedPreset, intervalSec }),
      });
      const data = await res.json();
      if (res.status === 201) {
        toast({ title: "תזמון נוצר", description: `${presets.find((p) => p.id === schedPreset)?.label ?? schedPreset} · כל ${intervalSec} שניות` });
        setSchedPreset("");
        refreshSchedules();
      } else if (ownerDeniedToast(data)) {
        /* handled */
      } else if (data.error === "unknown_preset") {
        toast({ title: "עבודה לא מוכרת", description: "ה-runner מקבל whitelist בלבד", variant: "destructive" });
      } else if (data.error === "invalid_interval") {
        toast({ title: "פרק-זמן קטן מדי", description: `מינימום ${data.min} שניות`, variant: "destructive" });
      } else if (data.error === "too_many_schedules") {
        toast({ title: "יותר מדי תזמונים", description: `מקסימום ${data.max}`, variant: "destructive" });
      } else {
        toast({ title: "יצירת תזמון נכשלה", description: String(data.error ?? ""), variant: "destructive" });
      }
    } catch {
      toast({ title: "runner לא נגיש", description: "שירות הביצוע לא מגיב", variant: "destructive" });
    } finally {
      setSchedBusy(false);
    }
  };

  const toggleSchedule = async (s: Schedule) => {
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(s.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (res.status === 401) {
        ownerDeniedToast(await res.json().catch(() => ({})));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: s.enabled ? "התזמון הושבת" : "התזמון הופעל", description: presets.find((p) => p.id === s.presetId)?.label ?? s.presetId });
      refreshSchedules();
    } catch {
      toast({ title: "עדכון התזמון נכשל", variant: "destructive" });
    }
  };

  const deleteSchedule = async (id: string, label: string) => {
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE", headers: ownerHeaders() });
      if (res.status === 401) {
        ownerDeniedToast(await res.json().catch(() => ({})));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: "התזמון נמחק", description: label });
      refreshSchedules();
    } catch {
      toast({ title: "מחיקת התזמון נכשלה", variant: "destructive" });
    }
  };

  const upCount = nodes ? nodes.filter((n) => n.up).length : 0;
  const statusMeta = currentJob ? STATUS_META[currentJob.status] : null;

  return (
    <div dir="rtl" className="min-h-screen flex flex-col bg-zinc-50 text-zinc-900">
      {/* Header */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 py-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-600 flex items-center justify-center">
              <Activity className="h-5 w-5 text-white" aria-hidden />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">רשת-הביצוע · Fleet Runner</h1>
              <p className="text-sm text-zinc-500">הרשת שלנו מבצעת דברים אמיתיים — פיתוח, בדיקות, סריקות. אפס סימולציה.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ownerToken ? (
              <Button variant="outline" size="sm" onClick={lockOwner} aria-label="נעילת מצב-בעלים">
                <ShieldCheck className="h-4 w-4 text-emerald-600" /> מצב-בעלים פתוח
              </Button>
            ) : (
              <Button variant={unlockOpen ? "default" : "outline"} size="sm" onClick={() => setUnlockOpen((v) => !v)} aria-label="פתיחת מצב-בעלים">
                <KeyRound className="h-4 w-4" /> פתיחת-בעלים
              </Button>
            )}
            <Badge variant={runnerUp ? "default" : "destructive"} className={runnerUp ? "bg-emerald-600" : ""}>
              {runnerUp ? "runner חי" : "runner לא-נגיש"}
            </Badge>
            <Button variant="outline" size="sm" onClick={refreshNodes} aria-label="רענון סריקת רשת">
              <RefreshCw className="h-4 w-4" /> סרוק
            </Button>
          </div>
        </div>
        {unlockOpen && !ownerToken && (
          <div className="border-t border-zinc-200 bg-emerald-50/70">
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-zinc-700">אימות-בעלים · סיסמת-הכספת:</span>
              <Input
                type="password"
                value={unlockInput}
                onChange={(e) => setUnlockInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void unlockOwner(); }}
                className="max-w-64"
                placeholder="vault passphrase"
                aria-label="סיסמת-הכספת"
                autoFocus
              />
              <Button size="sm" onClick={() => void unlockOwner()} disabled={unlockBusy || !unlockInput}>
                {unlockBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} פתח
              </Button>
              {unlockError && <span className="text-sm text-red-600" role="alert">{unlockError}</span>}
              <span className="text-xs text-zinc-500 ms-auto">פעולות-שינוי מאומתות מול הכספת (AES vault) — deny-by-default לכל השאר</span>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Network nodes */}
        <section aria-labelledby="nodes-title" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="nodes-title" className="text-lg font-semibold flex items-center gap-2">
              <Server className="h-5 w-5 text-emerald-600" aria-hidden /> צמתי הרשת
            </h2>
            <span className="text-sm text-zinc-500">
              {nodes ? `${upCount}/${nodes.length} למעלה · ${fmtTime(probedAt ?? undefined)}` : "סורק…"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {nodes === null &&
              [0, 1, 2, 3].map((i) => (
                <Card key={i} className="animate-pulse">
                  <CardContent className="p-4 h-28" />
                </Card>
              ))}
            {nodes?.map((n) => (
              <Card key={n.id} className={`border ${n.up ? "border-emerald-200" : "border-red-200"}`}>
                <CardHeader className="pb-2 px-4 pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-semibold leading-tight">{n.name}</CardTitle>
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${n.up ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} aria-label={n.up ? "למעלה" : "למטה"} />
                  </div>
                  <CardDescription className="text-xs">
                    פורט {n.port} · {n.kind}
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-0">
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-zinc-500">זמן-תגובה</span>
                      <span className="font-mono">{n.latencyMs}ms</span>
                    </div>
                    <div className="text-zinc-700 break-words" dir="ltr">{nodeDetail(n)}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Sovereignty — R39/R40: the architecture is the owner, decides and journals */}
        <section aria-labelledby="sovereignty-title" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SovereigntyCard />
        </section>

        {/* Execution console */}
        <section aria-labelledby="console-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="console-title" className="flex items-center gap-2 text-lg">
                <Terminal className="h-5 w-5 text-emerald-600" aria-hidden /> מסוף-הביצוע
              </CardTitle>
              <CardDescription>
                עבודות אמיתיות על העץ האמיתי — whitelist בלבד, בלי פקודות שרירותיות. כל ריצה מתועדת ביומן ראיות append-only.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6 space-y-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <Select value={selectedPreset} onValueChange={setSelectedPreset}>
                  <SelectTrigger className="w-full sm:w-72" aria-label="בחירת עבודה">
                    <SelectValue placeholder="בחר עבודה…" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={submitJob} disabled={submitting || !runnerUp} className="bg-emerald-600 hover:bg-emerald-700 min-w-28">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                  הרץ
                </Button>
                {selectedPreset && presets.find((p) => p.id === selectedPreset) && (
                  <p className="text-sm text-zinc-500 self-center">{presets.find((p) => p.id === selectedPreset)!.description}</p>
                )}
              </div>

              {currentJob && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline" className={statusMeta?.cls}>
                      {currentJob.status === "running" && <Loader2 className="h-3 w-3 animate-spin inline ml-1" />}
                      {statusMeta?.label}
                    </Badge>
                    {currentJob.exitCode != null && (
                      <Badge variant="outline" className={currentJob.exitCode === 0 ? "text-emerald-700" : "text-red-700"}>
                        exit {currentJob.exitCode}
                      </Badge>
                    )}
                    <Badge variant="outline">{fmtDuration(currentJob.durationMs)}</Badge>
                    <Badge variant="outline" className="font-mono text-xs" dir="ltr">{currentJob.id}</Badge>
                    <span className="text-xs text-zinc-400" dir="ltr">{currentJob.cwd}$ {currentJob.cmd.join(" ")}</span>
                  </div>
                  <div
                    ref={termRef}
                    dir="ltr"
                    className="rounded-lg bg-zinc-900 text-zinc-100 p-4 font-mono text-xs leading-relaxed max-h-96 overflow-y-auto whitespace-pre-wrap break-words [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-zinc-800 [&::-webkit-scrollbar-thumb]:bg-zinc-600 [&::-webkit-scrollbar-thumb]:rounded-full"
                    role="log"
                    aria-live="polite"
                    aria-label="פלט הריצה החי"
                  >
                    {currentJob.restored && (
                      <div className="text-amber-300 border-b border-amber-800 pb-2 mb-2">ריצה היסטורית — נשמר רק סיכום (הפלט המלא לא נשמר לפני שכבת-הדיסק)</div>
                    )}
                    {currentJob.stdout}
                    {currentJob.stdout && currentJob.stderr ? "\n" : ""}
                    {currentJob.stderr && <span className="text-rose-300">{currentJob.stderr}</span>}
                    {!currentJob.stdout && !currentJob.stderr && currentJob.status === "running" && (
                      <span className="text-zinc-400">… רץ, פלט יגיע בסיום (ה-runner לוכד את הזרמים באמת)</span>
                    )}
                    {currentJob.truncated && <span className="text-amber-300">[פלט נחתך להצגה — הריצה המלאה אמיתית]</span>}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Scheduler */}
        <section aria-labelledby="sched-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="sched-title" className="flex items-center gap-2 text-lg">
                <CalendarClock className="h-5 w-5 text-emerald-600" aria-hidden /> מתזמן
              </CardTitle>
              <CardDescription>
                עבודות שרצות מעצמן כל פרק-זמן קבוע — ה-runner מבצע, מתעד ביומן-הראיות ומדווח. מינימום 60 שניות · מקסימום 20 תזמונים.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6 space-y-4">
              <form
                className="flex flex-col sm:flex-row sm:flex-wrap gap-3"
                onSubmit={(e) => { e.preventDefault(); createSchedule(); }}
              >
                <Select value={schedPreset} onValueChange={setSchedPreset}>
                  <SelectTrigger className="w-full sm:w-64" aria-label="בחירת עבודה לתזמון">
                    <SelectValue placeholder="בחר עבודה לתזמון…" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={60}
                    step={1}
                    dir="ltr"
                    inputMode="numeric"
                    value={schedInterval}
                    onChange={(e) => setSchedInterval(e.target.value)}
                    className="w-28"
                    aria-label="פרק-זמן בשניות"
                  />
                  <span className="text-sm text-zinc-500 whitespace-nowrap">שניות</span>
                </div>
                <Button type="submit" disabled={schedBusy || !runnerUp} className="bg-emerald-600 hover:bg-emerald-700 min-w-28">
                  {schedBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
                  תזמן
                </Button>
              </form>
              {schedules.length === 0 ? (
                <p className="text-sm text-zinc-500 py-4 text-center">
                  אין תזמונים — הוסף אחד מלמעלה (למשל: דוח-שוק כל 300 שניות)
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto rounded-md border [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">עבודה</TableHead>
                        <TableHead className="text-right">כל</TableHead>
                        <TableHead className="text-right">פעיל</TableHead>
                        <TableHead className="text-right">ריצה-אחרונה</TableHead>
                        <TableHead className="text-right">ריצה-הבאה</TableHead>
                        <TableHead className="text-right">ספירה</TableHead>
                        <TableHead className="text-right">
                          <span className="sr-only">פעולות</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schedules.map((s) => {
                        const meta = s.lastStatus ? STATUS_META[s.lastStatus] : null;
                        const nextInSec = Math.max(0, Math.ceil((Date.parse(s.nextRunAt) - nowMs) / 1000));
                        const label = presets.find((p) => p.id === s.presetId)?.label ?? s.presetId;
                        return (
                          <TableRow key={s.id}>
                            <TableCell className="font-medium">{label}</TableCell>
                            <TableCell className="text-sm whitespace-nowrap">{fmtInterval(s.intervalSec)}</TableCell>
                            <TableCell>
                              <Switch
                                checked={s.enabled}
                                onCheckedChange={() => toggleSchedule(s)}
                                aria-label={`הפעלה/השבתה של ${label}`}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {s.lastJobId ? (
                                  <button
                                    className="font-mono text-xs underline decoration-dotted underline-offset-4 hover:text-emerald-700"
                                    onClick={() => refreshJob(s.lastJobId!)}
                                    aria-label={`טעינת פלט הריצה האחרונה של ${label}`}
                                  >
                                    {fmtTime(s.lastRunAt)}
                                  </button>
                                ) : (
                                  <span className="text-sm">—</span>
                                )}
                                {meta && (
                                  <Badge variant="outline" className={`text-[10px] ${meta.cls}`}>
                                    {meta.label}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap font-mono">
                              {s.enabled ? (nextInSec <= 1 ? "עכשיו" : `בעוד ${fmtCountdown(nextInSec)}`) : "מושבת"}
                            </TableCell>
                            <TableCell className="text-xs text-zinc-600 whitespace-nowrap">
                              {s.runCount} ריצות
                              {s.failCount > 0 ? ` · ${s.failCount} כישלונות` : ""}
                              {s.skippedCount > 0 ? ` · ${s.skippedCount} דולגו` : ""}
                            </TableCell>
                            <TableCell>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label={`מחיקת תזמון ${label}`}>
                                    <Trash2 className="h-4 w-4 text-red-600" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent dir="rtl">
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>למחוק את התזמון?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {label} — {fmtInterval(s.intervalSec)}. הריצות שכבר-בוצעו נשארות מתועדות ביומן-הראיות. הפעולה לא הפיכה.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>ביטול</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-red-600 hover:bg-red-700"
                                      onClick={() => deleteSchedule(s.id, label)}
                                    >
                                      מחק
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Sovereign economy — live treasury, staking and epoch ops */}
        <section aria-labelledby="econ-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="econ-title" className="flex items-center gap-2 text-lg">
                <Coins className="h-5 w-5 text-amber-600" aria-hidden /> כלכלה ריבונית
              </CardTitle>
              <CardDescription>
                האוצר, הסטייקינג ומהלכי-האפוק מהנתונים החיים של צומת-השוק · האפוק (מיסים→שכר→תגמולים) רץ אוטומטית כל 10 דק׳
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {econ ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">אוצר (הכנסות-אמת)</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{Number(econ.treasury?.usds ?? econ.conservation.quote.fees).toLocaleString("he-IL")}</div>
                      <div className="text-[11px] text-zinc-400">µ¢</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">סטייק כולל</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                        {Number(econ.agents.reduce((s, a) => s + BigInt(a.usdsStaked || "0"), 0n)).toLocaleString("he-IL")}
                      </div>
                      <div className="text-[11px] text-zinc-400">µ¢ נעולים</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">סטייקרים</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                        {econ.agents.filter((a) => BigInt(a.usdsStaked || "0") > 0n).length}/{econ.agents.length}
                      </div>
                      <div className="text-[11px] text-zinc-400">סוכנים</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">עסקאות שוק</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{econ.settledTrades}</div>
                      <div className="text-[11px] text-zinc-400">שקועות</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={econ.conservation.quote.holds && econ.conservation.base.holds ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-red-100 text-red-800 hover:bg-red-100"}>
                      {econ.conservation.quote.holds && econ.conservation.base.holds ? "שימור-כסף מוחזק ✓" : "הפרת-שימור ✗"}
                    </Badge>
                    <span className="text-xs text-zinc-500">
                      מסחר · עמלות · מיסים · שכר · תגמולי-סטייק — הכל על אותו מנוע, הכל מתועד
                    </span>
                  </div>

                  <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <div className="text-xs font-medium text-amber-900">רישוי-חבר חדש — הרשת מרחיבה את עצמה</div>
                    <p className="mt-0.5 text-[11px] text-amber-800/80">
                      זהות Ed25519 חדשה נוצרת מקומית, נרשמת חתומה-מפעיל מול השוק החי (שורד ריסטרט), ומצטרפת למסחר אוטומטית בריצת-הכלכלה הבאה.
                    </p>
                    <div className="mt-2 flex gap-2" dir="ltr">
                      <Input
                        value={licName}
                        onChange={(e) => setLicName(e.target.value)}
                        placeholder="agent-name (לדוגמה: eta)"
                        className="h-9 flex-1 font-mono text-sm"
                        maxLength={16}
                        disabled={licBusy}
                        aria-label="שם הסוכן החדש"
                      />
                      <Button onClick={licenseAgent} disabled={licBusy || !licName.trim()} size="sm" className="h-9 gap-1.5">
                        {licBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
                        רשום
                      </Button>
                    </div>
                  </div>

                  {econ.epochOps && econ.epochOps.length > 0 && (
                    <div className="max-h-44 overflow-y-auto rounded-lg border border-zinc-200" dir="ltr">
                      <table className="w-full text-xs">
                        <tbody>
                          {econ.epochOps.slice(-8).reverse().map((o, i) => {
                            const meta = KIND_META[o.kind] ?? { label: o.kind, cls: "bg-zinc-100 text-zinc-700" };
                            return (
                              <tr key={`${o.epoch}-${o.kind}-${o.agentId}-${i}`} className="border-b border-zinc-100 last:border-0">
                                <td className="px-3 py-1.5">
                                  <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                                </td>
                                <td className="px-3 py-1.5 font-medium">{o.agentId}</td>
                                <td className="px-3 py-1.5 font-mono tabular-nums">{Number(o.amount).toLocaleString("he-IL")} µ¢</td>
                                <td className="px-3 py-1.5 font-mono text-zinc-400">{o.epoch || "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את מצב-הכלכלה החי…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Sovereignty scorecard — live proof the network runs itself */}
        <section aria-labelledby="sov-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="sov-title" className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden /> ריבונות חיה — הוכחת-הרצה-עצמית
              </CardTitle>
              <CardDescription>
                המדדים החיים של עצמאות-הרשת: מה רץ מעצמו בלי לחיצה, כמה פעמים הרשת ריפאה את עצמה, וכמה ראיות נאספות
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {runnerHealth ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <div className="text-xs text-emerald-700">פעולות-אוטונומיות</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{runs.filter((r) => r.trigger === "schedule").length}<span className="text-xs font-normal text-emerald-600">/50</span></div>
                      <div className="text-[11px] text-emerald-600/70">מהריצות האחרונות</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">ריצות-מתזמן Σ</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{schedules.reduce((s, x) => s + x.runCount, 0).toLocaleString("he-IL")}</div>
                      <div className="text-[11px] text-zinc-400">נורו מעצמן</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">ריפויים-עצמיים</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{runnerHealth.watchdog?.healCount ?? 0}</div>
                      <div className="text-[11px] text-zinc-400">watchdog רפואי</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">פעימות-תזמון</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{(runnerHealth.tickCount ?? 0).toLocaleString("he-IL")}</div>
                      <div className="text-[11px] text-zinc-400">בדיקות-תור</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">ראיות-ריצה Σ</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{(runnerHealth.jobsTotal ?? 0).toLocaleString("he-IL")}</div>
                      <div className="text-[11px] text-zinc-400">יומן append-only</div>
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                      <div className="text-xs text-zinc-500">רץ-ברציפות</div>
                      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                        {Math.floor((runnerHealth.uptimeSec ?? 0) / 3600)}:{String(Math.floor(((runnerHealth.uptimeSec ?? 0) % 3600) / 60)).padStart(2, "0")}
                      </div>
                      <div className="text-[11px] text-zinc-400">שעות:דקות</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={runs.some((r) => r.trigger === "schedule") ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-100"}>
                      {runs.some((r) => r.trigger === "schedule") ? "הרשת מריצה את עצמה ✓" : "טרם נרשמו ריצות-אוטונומיות"}
                    </Badge>
                    <Badge variant="outline" className="border-zinc-300">
                      תזמונים פעילים {schedules.filter((s) => s.enabled).length}/{schedules.length}
                    </Badge>
                    <span className="text-xs text-zinc-500">
                      watchdog: {runnerHealth.watchdog?.lastResult ?? "—"} · תזמונים-ברישום: {runnerHealth.schedulesCount ?? 0}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את מדדי-הריבונות…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* AI sentinel — NVIDIA NIM brain */}
        <section aria-labelledby="ai-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="ai-title" className="flex items-center gap-2 text-lg">
                <BrainCircuit className="h-5 w-5 text-violet-600" aria-hidden /> מוח-AI — סנטינל אינטליגנטי
              </CardTitle>
              <CardDescription>
                ניתוח-מודיעיני חי של הרשת על-ידי NVIDIA NIM (נמוטרון): הערכה, סיכונים, אנומליות והמלצות — מהמצב-החי בפועל, לא מהנחות
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {ai ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={ai.vault.unsealed ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-amber-100 text-amber-800 hover:bg-amber-100"}>
                      {ai.vault.unsealed ? "כספת פתוחה — AI מופעל" : "כספת אטומה — AI fail-closed"}
                    </Badge>
                    <Badge variant="outline" className="border-zinc-300">
                      {ai.vault.sealedBlob ? "blob אטום בגיט ✓" : "אין blob אטום"}
                    </Badge>
                    {ai.latest && (
                      <Badge variant="outline" className="border-zinc-300 font-mono text-[10px]">
                        {ai.latest.model}
                      </Badge>
                    )}
                    <Button size="sm" variant="outline" className="gap-1" onClick={runSentinel} disabled={aiBusy || !ai.vault.unsealed}>
                      {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                      נתח עכשיו
                    </Button>
                  </div>
                  {ai.latest ? (
                    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4">
                      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                        <span>נותח: {new Date(ai.latest.generatedAt).toLocaleString("he-IL")}</span>
                        <span>·</span>
                        <span>זמן-תגובה {(ai.latest.latencyMs / 1000).toFixed(1)}s</span>
                      </div>
                      <div className="max-h-96 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-zinc-800 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                        {ai.latest.analysis}
                      </div>
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                      עדיין אין ניתוח — לחץ &quot;נתח עכשיו&quot; והסנטינל יגייס את מצב-הרשת החי ויפיק הערכה מלאה
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-400">
                    המפתח חי בכספת-אטומה (AES-256+PBKDF2) — נשמר בגיט בתור blob מוצפן, נפתח-אוטונומית אחרי מחיקת-סנדבוקס. אפס-סודות במטוס-הבקרה.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את מצב-המוח…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Autonomous build — the network that builds, not only checks */}
        <section aria-labelledby="build-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="build-title" className="flex items-center gap-2 text-lg">
                <Hammer className="h-5 w-5 text-emerald-600" aria-hidden /> בנייה אוטונומית — הרשת בונה את עצמה
              </CardTitle>
              <CardDescription>
                מה הרשת בנתה לבד: מחזורי-בנייה אמיתיים מהנתונים החיים בלבד — האדריכל (NIM) מתכנן, הבנאי מבצע, האתר מתעדכן לבד כל-הזמן
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {build ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {build.report ? (
                      <>
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          מחזור בנייה #{build.report.cycle}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-300">
                          נבנה: {new Date(build.report.builtAt).toLocaleTimeString("he-IL")}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-300">
                          תזמונים ירוקים {build.report.stats.schedulesGreen}/{build.report.stats.schedulesEnabled}
                        </Badge>
                      </>
                    ) : (
                      <Badge variant="outline" className="border-amber-300 text-amber-700">
                        עדיין אין דוח-בנייה — המחזור הראשון ירוץ דרך ה-runner (preset: site-builder)
                      </Badge>
                    )}
                    {build.plan && (
                      <Badge variant="outline" className="border-violet-300 text-violet-700 font-mono text-[10px]">
                        תוכנית: {build.plan.model ?? "NIM"}
                      </Badge>
                    )}
                  </div>

                  {build.report && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      {[
                        { k: "עסקאות", v: build.report.stats.trades },
                        { k: "ספר seq", v: build.report.stats.ledgerSeq },
                        { k: "סוכנים", v: build.report.stats.agents },
                        { k: "ראיות", v: build.report.stats.jobsTotal },
                        { k: "מחזורים", v: build.cycles ?? build.report.cycle },
                        { k: "מה נבנה", v: build.report.whatWasBuilt.length },
                      ].map((s) => (
                        <div key={s.k} className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-center">
                          <div className="text-lg font-bold text-zinc-800">{s.v}</div>
                          <div className="text-[11px] text-zinc-500">{s.k}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {build.report && build.report.whatWasBuilt.length > 0 && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
                      <div className="mb-2 text-xs font-semibold text-emerald-800">מה נבנה בפועל (24h אחרונים, מהראיות):</div>
                      <ul className="space-y-1 text-sm text-emerald-900">
                        {build.report.whatWasBuilt.map((w, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                            <span>{w}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(build.report?.plan ?? build.plan) && (
                    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4">
                      <div className="mb-2 text-xs font-semibold text-violet-800">
                        תוכנית-הבניין החיה: {build.report?.plan?.mission ?? build.plan?.mission}
                      </div>
                      <div className="space-y-2">
                        {(build.report?.plan?.tasks ?? build.plan?.tasks ?? []).slice(0, 5).map((t) => (
                          <div key={t.id} className="rounded-md border border-violet-200 bg-white/70 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className="border-violet-300 text-violet-700 text-[10px]">
                                {t.action === "content" ? "תוכן" : t.action === "insight" ? "ניתוח" : "תיעוד"}
                              </Badge>
                              <span className="text-sm font-medium text-zinc-800">{t.title}</span>
                            </div>
                            {t.why && <p className="mt-1 text-xs leading-relaxed text-zinc-600">{t.why}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {build.report?.insight?.text && (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
                      <div className="mb-1 text-xs font-semibold text-zinc-600">הניתוח החי האחרון של המוח ({build.report.insight.model}):</div>
                      <div className="max-h-44 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-zinc-700 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                        {build.report.insight.text}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את מצב-הבנייה…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Sovereign knowledge journal — the network that writes itself */}
        <section aria-labelledby="insights-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="insights-title" className="flex items-center gap-2 text-lg">
                <BookOpenText className="h-5 w-5 text-amber-600" aria-hidden /> יומן-הידע הריבוני — הרשת כותבת את עצמה
              </CardTitle>
              <CardDescription>
                הלולאה המלאה: האדריכל מתכנן ← המבצע הופך כל משימה בטוחה לפריט-ידע אמיתי שמפורסם כאן — לידע יש כתובת, תאריך וראיות
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {insights ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                      פריטים מפורסמים: {insights.insights.length}
                    </Badge>
                    {insights.plan && (
                      <Badge variant="outline" className="border-amber-300 text-amber-700">
                        תוכנית חיה: {insights.progress.done}/{insights.progress.total} בוצעו
                      </Badge>
                    )}
                    <Badge variant="outline" className="border-zinc-300">
                      בוצעו סה&quot;כ: {insights.progress.executedTotal}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={runExecutor}
                      disabled={execBusy}
                    >
                      {execBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PenLine className="h-3.5 w-3.5" aria-hidden />}
                      בצע את התוכנית עכשיו
                    </Button>
                  </div>

                  {insights.insights.length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {insights.insights.map((i) => {
                          const active = selectedInsight?.taskId === i.taskId && selectedInsight?.planGeneratedAt === i.planGeneratedAt;
                          return (
                            <button
                              key={`${i.planGeneratedAt}::${i.taskId}`}
                              onClick={() => setSelectedInsight(i)}
                              aria-pressed={active}
                              className={`rounded-lg border px-3 py-2 text-right transition-colors ${
                                active
                                  ? "border-amber-400 bg-amber-50 ring-1 ring-amber-300"
                                  : "border-zinc-200 bg-white hover:border-amber-200 hover:bg-amber-50/40"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <FileText className={`h-3.5 w-3.5 shrink-0 ${active ? "text-amber-600" : "text-zinc-400"}`} aria-hidden />
                                <span className="max-w-[260px] truncate text-sm font-medium text-zinc-800">{i.title}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                                <Badge variant="outline" className="h-4 border-zinc-200 px-1 text-[9px]">
                                  {i.action === "content" ? "תוכן" : i.action === "insight" ? "ניתוח" : "תיעוד"}
                                </Badge>
                                <span>{new Date(i.executedAt).toLocaleString("he-IL")}</span>
                                <span>· משימה {i.taskId}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {selectedInsight && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
                          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                            <span className="text-sm font-semibold text-zinc-800">{selectedInsight.title}</span>
                            <span>·</span>
                            <span className="font-mono text-[10px]">{selectedInsight.model}</span>
                            <span>·</span>
                            <span>מתוך: {selectedInsight.mission}</span>
                          </div>
                          {selectedInsight.why && (
                            <p className="mb-3 rounded-md border border-amber-200 bg-white/70 p-2 text-xs leading-relaxed text-zinc-600">
                              <span className="font-semibold text-zinc-700">למה זה נכתב: </span>
                              {selectedInsight.why}
                            </p>
                          )}
                          <div className="max-h-96 overflow-y-auto rounded-md border border-amber-100 bg-white p-4 text-sm leading-relaxed text-zinc-800 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-amber-200 [&::-webkit-scrollbar-thumb]:rounded-full [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-zinc-900 [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-zinc-800 [&_li]:ml-4 [&_li]:list-disc [&_ol]:my-2 [&_p]:my-2 [&_strong]:text-zinc-900 [&_table]:my-3 [&_table]:w-full [&_table]:text-xs [&_td]:border [&_td]:border-zinc-200 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-200 [&_th]:bg-zinc-50 [&_th]:px-2 [&_th]:py-1">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedInsight.body}</ReactMarkdown>
                          </div>
                          <p className="mt-2 text-[10px] text-zinc-400">
                            נכתב אוטונומית ע&quot;י הרשת (plan-executor · משימה {selectedInsight.taskId} מתוכנית {new Date(selectedInsight.planGeneratedAt).toLocaleString("he-IL")}) — בלי התערבות-אדם
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                      עדיין אין פריטים — לחץ &quot;בצע את התוכנית עכשיו&quot; והמבצע יהפוך את תוכנית-האדריכל לידע מפורסם
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-400">
                    כל פריט: תוצר אמיתי של משימה מתוכנית-בניין חיה — מאומת (אורך/סודות/קוד), idempotent לפי-משימה, עם ראיות append-only אצל ה-runner.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את יומן-הידע…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Network broadcasts — the network writes to its own site */}
        <section aria-labelledby="net-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="net-title" className="flex items-center gap-2 text-lg">
                <Radio className="h-5 w-5 text-teal-600" aria-hidden /> שידורי-הרשת — הרשת כותבת לאתר ישירות
              </CardTitle>
              <CardDescription>
                מסלול site-data: האדריכל מחליט מה לשדר ← המבצע כותב JSON מאומת-סכמה ישירות-לאתר ← שער-אתר-חי מאשר שהאתר מספק אותו בפועל
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {netData ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100">
                      פריטים חיים: {netData.items.length}
                    </Badge>
                    {netData.publishedAt && (
                      <Badge variant="outline" className="border-teal-300 text-teal-700">
                        פורסם: {new Date(netData.publishedAt).toLocaleString("he-IL")}
                      </Badge>
                    )}
                    {netData.invalid && (
                      <Badge variant="outline" className="border-orange-300 text-orange-700">
                        קובץ-פגום — מוצג ריק בכנות
                      </Badge>
                    )}
                    <Badge variant="outline" className="border-zinc-300">
                      5 שערים: רשימה-לבנה · סכמה · סודות · שער-אתר-חי · revert
                    </Badge>
                  </div>

                  {netData.items.length > 0 ? (
                    <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-teal-100 bg-teal-50/30 p-3 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-teal-200 [&::-webkit-scrollbar-thumb]:rounded-full">
                      {netData.items.map((it) => {
                        const meta = NET_KIND_META[it.kind] ?? { label: it.kind, cls: "border-zinc-300 text-zinc-600" };
                        return (
                          <article key={it.id} className="rounded-md border border-teal-200 bg-white p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className={`text-[10px] ${meta.cls}`}>
                                {meta.label}
                              </Badge>
                              <h3 className="text-sm font-semibold text-zinc-800">{it.title}</h3>
                              <span className="mr-auto text-[10px] text-zinc-400">
                                {new Date(it.createdAt).toLocaleString("he-IL")}
                              </span>
                            </div>
                            <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-zinc-600">{it.body}</p>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                      עדיין אין שידורים — בסבב-התוכנית הבא האדריכל יכול לפרסם שידור-רשת ישירות-לכאן (site-data://sovereign-net.json)
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-400">
                    הקובץ היחיד שהרשת רשאית לכתוב מחוץ-ל-roshpina — כל פרסום עובר סכמה קשיחה (1..20 פריטים, ללא סודות) ושער-אתר-חי שמוכיח שהאתר מספק את הפריטים בפועל; פלט-שבור חוזר-אוטומטית.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> טוען את שידורי-הרשת…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Estate durability — what survives a sandbox wipe, measured live */}
        <section aria-labelledby="durability-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="durability-title" className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden /> עמידות-העיקרה — מה שרץ כאן שורד גם מחיקת-סנדבוקס
              </CardTitle>
              <CardDescription>
                ארבע-שכבות-גיבוי חוץ-מקומיות + תרגיל-אסון חי — מדוד עכשיו מהיומן ומ-origin, בלי מצב-גדולה: שכבה שלא ניתן לאמת מדווחת כך בכנות
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {durability ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                      {durability.layers.filter((l) => l.status === "protected").length}/{durability.layers.length} שכבות מוגנות
                    </Badge>
                    {durability.remote.reachable ? (
                      <Badge variant="outline" className="border-emerald-300 text-emerald-700">origin נגיש</Badge>
                    ) : (
                      <Badge variant="outline" className="border-orange-300 text-orange-700">origin לא נגיש — אימות כנה: unknown</Badge>
                    )}
                    {durability.remote.dailyAnchors.length > 0 && (
                      <Badge variant="outline" className="border-emerald-300 text-emerald-700">
                        עוגנים-יומיים: {durability.remote.dailyAnchors.join(", ")}
                      </Badge>
                    )}
                    {durability.capsule && (
                      <Badge variant="outline" className="border-zinc-300">
                        קפסולה אחרונה: {durability.capsule.sizeKB}KB · בת {durability.capsule.ageMin} דק'
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {durability.layers.map((l) => {
                      const meta = DURABILITY_META[l.status];
                      return (
                        <article key={l.id} className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-zinc-800">{l.label}</h3>
                            <Badge className={meta.cls}>{meta.label}</Badge>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{l.what}</p>
                          <p className="mt-2 font-mono text-[11px] leading-relaxed text-zinc-600">{l.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    {durability.settlement.label}: {durability.settlement.detail} · מדוד: {new Date(durability.checkedAt).toLocaleTimeString("he-IL")} · ענף-ה-estate מחזיק מניפסט-SHA256 והוכח בתרגיל-שחזור ובתרגיל-אסון חי
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> מודד את שכבות-העמידות…
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Recent runs */}
        <section aria-labelledby="runs-title">
          <Card>
            <CardHeader className="px-6 pt-6">
              <CardTitle id="runs-title" className="text-lg">ריצות אחרונות</CardTitle>
              <CardDescription>לחיצה על שורה טוענת את הפלט המלא והאמיתי שלה למסוף למעלה</CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              {runs.length === 0 ? (
                <p className="text-sm text-zinc-500 py-6 text-center">עדיין אין ריצות — הרץ עבודה מהמסוף</p>
              ) : (
                <div className="max-h-80 overflow-y-auto rounded-md border [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">שעה</TableHead>
                        <TableHead className="text-right">עבודה</TableHead>
                        <TableHead className="text-right">מצב</TableHead>
                        <TableHead className="text-right">משך</TableHead>
                        <TableHead className="text-right">exit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow
                          key={r.id}
                          className="cursor-pointer hover:bg-zinc-50"
                          onClick={() => refreshJob(r.id)}
                        >
                          <TableCell className="font-mono text-xs">{fmtTime(r.startedAt)}</TableCell>
                          <TableCell>
                            {r.label}
                            {r.trigger === "schedule" && (
                              <Badge variant="outline" className="mr-2 text-[10px] text-zinc-500 border-zinc-200">
                                <Clock3 className="h-3 w-3" aria-hidden />
                                מתוזמן
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATUS_META[r.status]?.cls}>
                              {r.status === "running" && <Loader2 className="h-3 w-3 animate-spin inline ml-1" />}
                              {STATUS_META[r.status]?.label ?? r.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{fmtDuration(r.durationMs)}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {r.exitCode === 0 && <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="הצלחה" />}
                            {r.exitCode != null && r.exitCode !== 0 && <XCircle className="h-4 w-4 text-red-600" aria-label="כישלון" />}
                            {r.status === "timeout" && <AlertTriangle className="h-4 w-4 text-orange-600" aria-label="פסק זמן" />}
                            {r.exitCode == null && r.status !== "timeout" ? "—" : r.exitCode ?? ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>הכל אמיתי · אפס סימולציה · ראיות: mini-services/fleet-runner/data/jobs.jsonl + schedules.json</span>
          <span dir="ltr" className="font-mono">control :3000 · runner :3031 · ledger :3032 · market :3033</span>
        </div>
      </footer>
    </div>
  );
}
