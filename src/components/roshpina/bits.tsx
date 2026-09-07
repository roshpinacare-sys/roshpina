"use client";

/**
 * bits.tsx — אטומים משותפים לקונסולת רושפינה: פאנלים, באדג'ים, מצבי-ריק וטעינה.
 * פלטה: זהב (ערך), אמרלד (אומת), רוז (שבר) — על קנבס שחור-חם.
 */

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { shortHash } from "@/lib/format";

export function Panel({
  title,
  subtitle,
  icon,
  actions,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel panel-glow p-4 md:p-6", className)} aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          {icon ? <span className="text-gold">{icon}</span> : null}
          <div>
            <h2 className="font-display text-lg md:text-xl font-bold text-foreground">{title}</h2>
            {subtitle ? <p className="text-xs md:text-sm text-ink-2 mt-0.5">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

const STATE_STYLES: Record<string, string> = {
  created: "border-border bg-secondary text-secondary-foreground",
  funded: "border-gold/40 bg-gold/10 text-gold",
  released: "border-verified/40 bg-verified/10 text-verified",
  refunded: "border-border bg-muted text-muted-foreground",
  disputed: "border-broken/40 bg-broken/10 text-broken",
};

const STATE_LABELS: Record<string, string> = {
  created: "נוצרה",
  funded: "מומנה",
  released: "שוחררה",
  refunded: "הוחזרה",
  disputed: "במחלוקת",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className={cn("text-[11px]", STATE_STYLES[state] ?? "")}>
      {STATE_LABELS[state] ?? state}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const cls =
    outcome === "allowed"
      ? "border-verified/40 bg-verified/10 text-verified"
      : outcome === "denied"
        ? "border-broken/40 bg-broken/10 text-broken"
        : "border-gold/40 bg-gold/10 text-gold";
  const label = outcome === "allowed" ? "אושר" : outcome === "denied" ? "נדחה" : "שגיאה";
  return (
    <Badge variant="outline" className={cn("text-[11px]", cls)}>
      {label}
    </Badge>
  );
}

export function Money({ children, className }: { children: string; className?: string }) {
  return <span className={cn("hash metric-value text-foreground", className)}>{children}</span>;
}

export function HashSpan({ hash, className }: { hash: string; className?: string }) {
  return (
    <span className={cn("hash text-xs text-ink-2", className)} title={hash}>
      {shortHash(hash)}
    </span>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-ink-2">
      {text}
    </div>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="טוען">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full bg-muted" />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-broken/40 bg-broken/10 px-4 py-3 text-sm text-broken" role="alert">
      {error}
    </div>
  );
}
