"use client";

/**
 * header.tsx — ראש-הקונסולה: אבן-הראשה (keystone), שם-הפלטפורמה, צ'יפ-בריאות חי,
 * ושלוש-העמודים: רווח · הגנה · אינטליגנציה.
 */

import { usePolling } from "@/hooks/use-polling";
import type { HealthResponse } from "@/lib/api-types";
import { cn } from "@/lib/utils";

export function Keystone({ className }: { className?: string }) {
  // אבן-ראשה: טרפז זהב עם חריץ-פנימי כהה — צורת-לוגו CSS טהורה.
  return (
    <span
      className={cn("relative inline-block h-10 w-10 shrink-0", className)}
      style={{ clipPath: "polygon(22% 0, 78% 0, 100% 100%, 0 100%)", background: "linear-gradient(180deg, var(--gold-soft), var(--gold-dim))" }}
      role="img"
      aria-label="אבן-הראשה של רושפינה"
    >
      <span
        className="absolute"
        style={{
          inset: "26% 32% 18% 32%",
          clipPath: "polygon(18% 0, 82% 0, 100% 100%, 0 100%)",
          background: "var(--card)",
        }}
      />
    </span>
  );
}

function HealthChip() {
  const { data, error, loading } = usePolling<HealthResponse>("/api/health", 10000);

  if (loading && !data) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-ink-2">
        <span className="live-dot bg-gold" /> מאתחל קרנל…
      </span>
    );
  }
  if (error && !data) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-broken/40 bg-broken/10 px-3 py-1 text-xs text-broken">
        <span className="live-dot bg-broken" /> אין-קשר לקרנל
      </span>
    );
  }
  const integrity = data?.counts.audit.integrity ?? false;
  const seeded = data?.seeded ?? false;
  const ok = seeded && integrity;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
        ok ? "border-verified/40 bg-verified/10 text-verified" : "border-gold/40 bg-gold/10 text-gold",
      )}
      title={data ? `kid ${data.kid} · audit ${data.counts.audit.length} רשומות` : undefined}
    >
      <span className={cn("live-dot", ok ? "bg-verified" : "bg-gold")} />
      {ok ? "קרנל תקין" : seeded ? "בודק שלמות…" : "מזריע…"}
      {data ? <span className="hash text-[10px] text-ink-2">kid {data.kid.slice(0, 8)}</span> : null}
    </span>
  );
}

export function ConsoleHeader() {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-7xl px-4 py-5 md:py-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Keystone />
            <div>
              <h1 className="font-display text-2xl md:text-3xl font-black root-glow leading-tight">
                רושפינה
              </h1>
              <p className="text-xs md:text-sm text-ink-2">פלטפורמת האמון והערך · ראש-הפינה</p>
            </div>
          </div>
          <HealthChip />
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-6 text-ink-2 md:text-sm">
          <span className="text-gold font-medium">רווח</span> — מנוע-עמלות תיאום (5% על שחרור) וארביטראז'-עלויות בין-ספקים ·{" "}
          <span className="text-verified font-medium">הגנה</span> — guard fail-closed, ביקורת hash-linked חתומה ודרכוני Ed25519 ·{" "}
          <span className="text-ink font-medium">אינטליגנציה</span> — מנוע-פוטנציאל המנתב חוזקות להזדמנויות.
        </p>
      </div>
    </header>
  );
}
