import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const INSIGHTS_DIR = "/home/z/my-project/mini-services/fleet-runner/data/insights";
const BUILD_DIR = "/home/z/my-project/mini-services/fleet-runner/data/build";

type InsightRec = {
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
};

// GET /api/insights — יומן-הידע הריבוני: מה שהמבצע פרסם מתוך תוכנית-האדריכל.
// כאן רק קוראים קבצים צד-שרת — אפס-סודות, אפס-קריאות-רשת (האמת נכתבה ע"י ה-runner).
export async function GET() {
  try {
    let insights: InsightRec[] = [];
    if (existsSync(`${INSIGHTS_DIR}/index.json`)) {
      try {
        const raw = JSON.parse(readFileSync(`${INSIGHTS_DIR}/index.json`, "utf8")) as InsightRec[];
        if (Array.isArray(raw)) insights = raw;
      } catch {
        insights = [];
      }
    }

    let plan: Record<string, unknown> | null = null;
    if (existsSync(`${BUILD_DIR}/plan.json`)) {
      try {
        plan = JSON.parse(readFileSync(`${BUILD_DIR}/plan.json`, "utf8")) as Record<string, unknown>;
      } catch {
        plan = null;
      }
    }

    let executedCount = 0;
    if (existsSync(`${BUILD_DIR}/executed.json`)) {
      try {
        const ex = JSON.parse(readFileSync(`${BUILD_DIR}/executed.json`, "utf8")) as {
          executions?: Record<string, unknown>;
        };
        executedCount = Object.keys(ex.executions ?? {}).length;
      } catch {
        executedCount = 0;
      }
    }

    const planTasks = (plan?.tasks as { id: string }[] | undefined) ?? [];
    const doneInPlan = insights.filter((i) =>
      planTasks.some((t) => t.id === i.taskId && plan?.generatedAt === i.planGeneratedAt)
    ).length;

    return NextResponse.json(
      {
        insights,
        plan: plan ? { generatedAt: plan.generatedAt, mission: plan.mission, model: plan.model, tasks: planTasks.length } : null,
        progress: { done: doneInPlan, total: planTasks.length, executedTotal: executedCount },
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return NextResponse.json(
      { error: "insights_unavailable", detail: String(err).slice(0, 200) },
      { status: 502, headers: NO_STORE }
    );
  }
}
