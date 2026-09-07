/**
 * lib/potential/in-memory-kg-source.ts — InMemoryKnowledgeGraphSource.
 *
 * In-memory implementation of KnowledgeGraphSource for tests and local dev.
 * Zero external dependencies.
 *
 * Tenant isolation: fetchSignals filters by (userId, tenantId) in memory.
 */

import type { KnowledgeSignal, KnowledgeGraphSource } from "./types";

export class InMemoryKnowledgeGraphSource implements KnowledgeGraphSource {
  private signals: KnowledgeSignal[] = [];

  /** Add a signal to the in-memory store. */
  addSignal(signal: KnowledgeSignal): void {
    this.signals.push(signal);
  }

  /** Remove all signals for a given (userId, tenantId). Returns count removed. */
  clearForUser(userId: string, tenantId: string): number {
    const before = this.signals.length;
    this.signals = this.signals.filter(
      (s) => !(s.userId === userId && s.tenantId === tenantId)
    );
    return before - this.signals.length;
  }

  /** Remove all signals across all tenants. */
  clearAll(): void {
    this.signals = [];
  }

  /** Fetch signals matching (userId, tenantId). */
  async fetchSignals(userId: string, tenantId: string): Promise<KnowledgeSignal[]> {
    return this.signals.filter(
      (s) => s.userId === userId && s.tenantId === tenantId
    );
  }

  /** Total signal count (for tests / diagnostics). */
  totalCount(): number {
    return this.signals.length;
  }
}
