import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULES } from '../src/app.js';

const REPO_ROOT = path.resolve(process.cwd(), '../..');
const MODULES_DIR = path.join(REPO_ROOT, 'modules');

/**
 * Boundary breaks that exist today (2026-10-31, ADR-0054 Context). Phase 22A
 * removes them one by one; this list MUST only shrink. An entry that no longer
 * matches a real break fails the test, so fixing a leak means deleting its line.
 *
 * Format: `<module> sql <table>` (SQL names a table outside the module's own
 * `tables`), `<module> imports <specifier>`.
 */
const KNOWN_LEAKS: string[] = [
  // 22A is complete: the boundary test must stay empty from here on.
];

/**
 * Table names after SQL keywords that introduce one. Keywords are matched in
 * upper case only, so JS `import … from` never matches; a name followed by `(`
 * is a function call (`FROM unnest(…)`) and is skipped.
 */
const SQL_TABLE =
  /\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+[a-z_0-9]+\s+ON)\s+(?:ONLY\s+|LATERAL\s+)?([a-z_][a-z0-9_.]*)(\s*\()?/g;
/**
 * Writes need their own matcher: `INSERT INTO t (col, …)` ends in `(`, which
 * `SQL_TABLE` treats as a function call and skips. Reads from `unnest(…)` are
 * still handled by `SQL_TABLE`'s parenthesis rule.
 */
const SQL_WRITE_TABLE = /\b(?:INSERT\s+INTO|UPDATE)\s+(?:ONLY\s+)?([a-z_][a-z0-9_.]*)/g;
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(name) ? [file] : [];
  });
}

function moduleDir(id: string): string {
  return path.join(MODULES_DIR, id);
}

function findLeaks(): string[] {
  const leaks = new Set<string>();
  for (const [id, module] of Object.entries(MODULES)) {
    const own = new Set(module.tables ?? []);
    const root = moduleDir(id);

    for (const file of sourceFiles(path.join(root, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(SQL_TABLE)) {
        const table = match[1];
        if (table && !match[2] && !own.has(table)) leaks.add(`${id} sql ${table}`);
      }
      for (const match of source.matchAll(SQL_WRITE_TABLE)) {
        const table = match[1];
        if (table && !own.has(table) && !match[0].includes('SET ')) {
          leaks.add(`${id} sql ${table}`);
        }
      }
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1];
        if (!specifier) continue;
        if (specifier.startsWith('@triageai/module-')) {
          leaks.add(`${id} imports ${specifier}`);
        } else if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!target.startsWith(root + path.sep)) leaks.add(`${id} imports ${specifier}`);
        }
      }
    }
  }
  return [...leaks].sort();
}

describe('module boundary (Phase 22.T2, ADR-0054)', () => {
  it('maps every first-party module to its folder under modules/', () => {
    for (const [id, module] of Object.entries(MODULES)) {
      expect(module.id).toBe(id);
      expect(statSync(path.join(moduleDir(id), 'src')).isDirectory()).toBe(true);
    }
  });

  it('finds no boundary break beyond the known list', () => {
    const known = new Set(KNOWN_LEAKS);
    expect(findLeaks().filter((leak) => !known.has(leak))).toEqual([]);
  });

  it('keeps the known list honest: every entry is still a real break', () => {
    const found = new Set(findLeaks());
    expect(KNOWN_LEAKS.filter((leak) => !found.has(leak))).toEqual([]);
  });

  it('catches the leak shapes it is meant to catch', () => {
    const sql = `SELECT r.id FROM workflow_runs r JOIN mod_x.notes n ON n.run_id = r.id
      WHERE r.id IN (SELECT id FROM unnest($1::text[]))`;
    const tables = [...sql.matchAll(SQL_TABLE)].filter((m) => !m[2]).map((m) => m[1]);
    expect(tables).toEqual(['workflow_runs', 'mod_x.notes']);

    const imports = `import { x } from '@triageai/module-kb';\nimport type { Y } from '../../chat/src/index.js';`;
    expect([...imports.matchAll(IMPORT_SPECIFIER)].map((m) => m[1])).toEqual([
      '@triageai/module-kb',
      '../../chat/src/index.js',
    ]);
  });
});
