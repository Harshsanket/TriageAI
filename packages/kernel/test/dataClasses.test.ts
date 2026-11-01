import { describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { missingDataClasses } from '../src/data/classes.js';

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
});
