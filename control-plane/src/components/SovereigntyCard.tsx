"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type SovereigntyData = {
  sovereignty: {
    owner?: string;
    law?: string;
    decides?: string;
    humanEscalation?: string;
    agents?: string;
    continuity?: string;
    ownerMemory?: { remembered?: string; human?: string };
  } | null;
  decisions: Array<{ at: string; kind: string; outcome: string; law: string }>;
  capability: { pass: number; fail: number; gaps: number; at: string | null };
  missing: string[];
  at: string;
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `לפני ${m} דק׳` : `לפני ${Math.round(m / 60)} שע׳`;
};

// כרטיס-הריבונות — R39/R40/R41: הארכיטקטורה היא הבעלים, מחליטה ומתעדת, הבעלים לעולם לא נשכח.
// כל-נתון מהקרקע (/api/sovereignty ← הלדג'ר החי + יומן-המועצה + המטריצה) — אין המצאה.
export function SovereigntyCard() {
  const [d, setD] = useState<SovereigntyData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/sovereignty", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: SovereigntyData) => {
          if (alive) {
            setD(j);
            setErr(null);
          }
        })
        .catch((e) => alive && setErr(String(e).slice(0, 120)));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const s = d?.sovereignty ?? null;

  return (
    <Card aria-labelledby="sovereignty-title" className="border-amber-200">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle id="sovereignty-title" className="text-sm font-semibold leading-tight">
          ריבונות — הארכיטקטורה היא הבעלים
        </CardTitle>
        <CardDescription className="text-xs">
          R39 בעלות · R40 הכרעה-עצמית · R41 רציפות · R42 ארכיון-לפי-sha
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2 text-xs">
        {err && <p className="text-red-600">המקור-לא-נגיש: {err}</p>}
        {!d && !err && <p className="text-muted-foreground">טוען מהקרקע…</p>}
        {d && (
          <>
            <p>
              <span className="font-semibold">בעלים:</span> {s?.owner ?? "—"} ·{" "}
              <span className="font-semibold">זיכרון-בעלים:</span> {s?.ownerMemory?.remembered ? "נשמר ✓" : "חסר ✗"}
            </p>
            <p>
              <span className="font-semibold">מטריצת-יכולות:</span>{" "}
              <span className={d.capability.fail === 0 ? "text-emerald-700" : "text-red-600"}>
                {d.capability.pass}/{d.capability.pass + d.capability.fail} עוברות
              </span>{" "}
              · {d.capability.gaps} פערים-כנים-מוצהרים
              {d.capability.at ? ` · נמדד ${ago(d.capability.at)}` : ""}
            </p>
            <div>
              <p className="font-semibold mb-1">יומן-החלטות (מועצת-הריבון):</p>
              {d.decisions.length === 0 && <p className="text-muted-foreground">היומן-ריק — יריית-המועצה-הראשונה-טרם-נרשמה</p>}
              <ul className="space-y-1">
                {d.decisions.slice(-3).reverse().map((x, i) => (
                  <li key={i} className="leading-snug">
                    <span className="font-mono">{x.kind}</span> → {x.outcome}{" "}
                    <span className="text-muted-foreground">({ago(x.at)})</span>
                  </li>
                ))}
              </ul>
            </div>
            {s?.continuity && (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer font-semibold text-foreground">רציפות (R41) — ההיסטוריה-הכנה</summary>
                <p className="mt-1 leading-snug">{s.continuity}</p>
              </details>
            )}
            {d.missing.length > 0 && (
              <p className="text-amber-700">מקורות-חסרים (מדווחים-בכנות): {d.missing.join(", ")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
