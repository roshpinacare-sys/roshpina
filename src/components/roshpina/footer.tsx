"use client";

/**
 * footer.tsx — פוטר דביק: נצמד לתחתית-המסך כשהתוכן קצר ונדחף טבעית כשהוא ארוך.
 */

export function ConsoleFooter() {
  return (
    <footer className="mt-auto border-t border-border py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto w-full max-w-7xl px-4 text-center text-[11px] text-ink-2">
        רושפינה · רווח · הגנה · אינטליגנציה — kernel: TFA Sovereign Trust-as-a-Service · Task 115
      </div>
    </footer>
  );
}
