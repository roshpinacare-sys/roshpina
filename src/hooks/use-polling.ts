"use client";

/**
 * use-polling — חיבור-חי עדין ל-API של רושפינה.
 * polling בקצב-משלו לכל-מקור, סלחני: שגיאה היא מצב (הנתונים האחרונים נשארים),
 * ולא קריסה. refresh ידני זמין לכל-פאנל.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(url: string, intervalMs = 12000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    const run = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
        const json = (await res.json()) as T & { reason?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json?.reason ?? json?.error ?? `HTTP ${res.status}`);
        } else {
          setError(null);
        }
        setData(json);
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "שגיאת-רשת");
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(id);
    };
  }, [url, intervalMs, tick]);

  return { data, error, loading, refresh };
}
