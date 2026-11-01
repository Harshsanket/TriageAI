/**
 * Replay protection (ADR-0055 §6): an id is remembered until its deadline; a
 * second envelope with the same id inside that window is refused.
 */
import type { Mp1Envelope } from '@triageai/contracts';

export class ReplayCache {
  private seen = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Returns false when the id was already seen before its deadline. */
  check(envelope: Pick<Mp1Envelope, 'id' | 'deadline'>, now = Date.now()): boolean {
    this.prune(now);
    const deadline = Date.parse(envelope.deadline);
    const existing = this.seen.get(envelope.id);
    if (existing !== undefined && existing >= now) return false;
    this.seen.set(envelope.id, deadline);
    if (this.seen.size > this.maxEntries) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [id] of oldest) this.seen.delete(id);
    }
    return true;
  }

  prune(now = Date.now()): void {
    for (const [id, deadline] of this.seen) {
      if (deadline < now) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
