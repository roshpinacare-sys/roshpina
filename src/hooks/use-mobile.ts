"use client";

import * as React from "react";

/**
 * use-mobile — hook-שבירת-נקודה של shadcn/ui (נדרש ל-sidebar).
 * מחזיר true כשרוחב-החלון מתחת ל-768px. SSR-safe דרך useSyncExternalStore.
 */
const MOBILE_BREAKPOINT = 768;

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  );
}
