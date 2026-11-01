import { describe, expect, it } from 'vitest';

import {
  categoryFor,
  inferMapping,
  maskAccount,
  normalizeDate,
  parseAmount,
  parseCsv,
  parseStatementText,
  signedAmount,
} from '../src/parse.js';

describe('deterministic extraction parsing (phase 20.3)', () => {
  it('parses quoted CSV and infers a transaction mapping', () => {
    const rows = parseCsv('Date,Description,Amount\n2026-09-01,"Coffee, large",-4.50');
    expect(rows).toEqual([{ Date: '2026-09-01', Description: 'Coffee, large', Amount: '-4.50' }]);
    expect(inferMapping(['Date', 'Description', 'Amount'])).toEqual({
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
    });
  });

  it('normalises dates and amounts, masks accounts and categorises merchants', () => {
    expect(normalizeDate('2026-09-01')).toBe('2026-09-01');
    expect(normalizeDate('25/09/2026')).toBe('2026-09-25');
    expect(normalizeDate('31/02/2026')).toBeNull();
    expect(parseAmount('-$1,234.50')).toBe(-1234.5);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(maskAccount('1234567890')).toBe('****7890');
    expect(categoryFor('WHOLE FOODS MARKET', [])?.category).toBe('Groceries');
    expect(categoryFor('MYSTERY SHOP', [{ keyword: 'mystery', category: 'Fun' }])).toEqual({
      category: 'Fun',
      source: 'rule',
    });
  });

  it('parses statement lines and signs amounts by direction', () => {
    const parsed = parseStatementText(
      [
        '2026-09-02 STARBUCKS -4.50 995.50',
        '2026-09-05 WHOLE FOODS -120.00 875.50',
        '2026-09-10 PAYROLL 2000.00 2875.50',
        'not-a-date 12.00',
      ].join('\n'),
    );
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.unparsed).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ date: '2026-09-02', direction: 'out', amount: 4.5 });
    expect(parsed.rows[2]).toMatchObject({ direction: 'in', amount: 2000 });
    expect(parsed.rows.reduce((sum, row) => sum + signedAmount(row), 0)).toBe(1875.5);
  });
});
