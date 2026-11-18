import { describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { DEFAULT_DATA_CLASSES, missingDataClasses } from '../src/data/classes.js';

describe('DataClass coverage (phase 18)', () => {
  it('classifies every table created by core migrations', () => {
    const tables = new Set<string>();
    for (const migration of CORE_MIGRATIONS) {
      for (const match of migration.sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)) {
        if (match[1]) tables.add(match[1]);
      }
    }
    const missing = missingDataClasses([...tables]).sort();
    // Module-owned tables are classified by their module; core ones must be here.
    expect(missing).toEqual([]);
  });

  it('declares valid bounds for the sensitive classes (18.T14)', () => {
    const order = ['never', 'local_only', 'redacted', 'allowed'] as const;
    for (const id of [
      'support_tickets',
      'chat_conversations',
      'audit_events',
      'cost_ledger',
      'model_call_traces',
      'activity_events',
    ]) {
      const cls = DEFAULT_DATA_CLASSES[id];
      expect(cls?.bounds, `${id} bounds`).toBeDefined();
      const days = cls?.retention.days;
      if (days !== undefined && cls?.bounds) {
        expect(days).toBeGreaterThanOrEqual(cls.bounds.minRetentionDays ?? 0);
        expect(days).toBeLessThanOrEqual(cls.bounds.maxRetentionDays ?? 3650);
      }
      if (cls?.bounds?.strictestModelUse) {
        // The bound may only be stricter than (or equal to) the class default.
        expect(order.indexOf(cls.bounds.strictestModelUse)).toBeLessThanOrEqual(
          order.indexOf(cls.modelUse),
        );
      }
    }
  });
});
