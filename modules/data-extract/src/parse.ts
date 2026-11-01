/** Deterministic parsing helpers (Phase 20.3/20.5). No model calls here. */

export type Row = Record<string, string>;

export interface TransactionFields {
  date: string;
  description: string;
  amount: number;
  currency: string;
  direction: 'in' | 'out';
  balance: number | null;
  category: string | null;
  account: string | null;
  merchant: string;
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCsv(text: string, delimiter = ','): Row[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  if (nonEmpty.length === 0) return [];
  const header = splitLine(nonEmpty[0] as string, delimiter);
  return nonEmpty.slice(1).map((line) => {
    const cells = splitLine(line, delimiter);
    const row: Row = {};
    header.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    return row;
  });
}

const ALIASES: Record<string, string[]> = {
  date: ['date', 'transactiondate', 'posteddate', 'postingdate', 'fecha', 'bookingdate'],
  description: [
    'description',
    'memo',
    'payee',
    'details',
    'detail',
    'narrative',
    'merchant',
    'reference',
    'name',
  ],
  amount: ['amount', 'value', 'sum', 'transactionamount', 'debitcredit'],
  direction: ['direction', 'type', 'debitcredit', 'creditdebit'],
  balance: ['balance', 'runningbalance', 'availablebalance', 'saldo'],
  currency: ['currency', 'ccy'],
  category: ['category', 'group', 'classification'],
  account: ['account', 'accountnumber', 'accountno', 'iban'],
};

const normalize = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

export function inferMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const key = normalize(header);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (mapping[field]) continue;
      if (aliases.includes(key)) mapping[field] = header;
    }
  }
  return mapping;
}

export function mappingSignature(headers: string[]): string {
  return headers.map(normalize).sort().join('|');
}

export function parseAmount(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[^\d.,()\-+]/g, '')
    .replace(/\((.*)\)/, '-$1')
    .replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

export function normalizeDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const date = new Date(trimmed.slice(0, 10));
    return Number.isNaN(date.getTime()) ? null : trimmed.slice(0, 10);
  }
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString().slice(0, 10);
  }
  return null;
}

export function maskAccount(account: string | undefined | null): string | null {
  if (!account) return null;
  const compact = account.replace(/\s+/g, '');
  return compact.length <= 4 ? compact : `****${compact.slice(-4)}`;
}

export function categoryFor(
  description: string,
  rules: Array<{ keyword: string; category: string }>,
): { category: string; source: 'rule' } | null {
  const lower = description.toLowerCase();
  for (const rule of rules) {
    if (rule.keyword && lower.includes(rule.keyword.toLowerCase())) {
      return { category: rule.category, source: 'rule' };
    }
  }
  const builtIn: Array<[RegExp, string]> = [
    [/starbucks|coffee|cafe|espresso/i, 'Coffee'],
    [/whole foods|trader joe|safeway|kroger|aldi|grocery|supermarket/i, 'Groceries'],
    [/uber|lyft|taxi|transit|metro|fuel|shell|chevron/i, 'Transport'],
    [/netflix|spotify|hulu|disney\+|subscription/i, 'Subscriptions'],
    [/rent|mortgage|landlord/i, 'Housing'],
    [/salary|payroll|deposit|refund|credit/i, 'Income'],
  ];
  for (const [pattern, category] of builtIn) {
    if (pattern.test(description)) return { category, source: 'rule' };
  }
  return null;
}

/**
 * Parse a text-layer statement. Accepted line shapes:
 *   2026-09-01 STARBUCKS -4.50 995.50
 *   09/01/2026,STARBUCKS,4.50,out,995.50
 * The parser is deliberately conservative; anything it cannot classify is
 * reported as unparsed so the dataset can go to `needs_review`.
 */
export function parseStatementText(text: string): {
  rows: TransactionFields[];
  unparsed: string[];
} {
  const rows: TransactionFields[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const dateMatch = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\s*[,;|\t ]\s*(.*)$/.exec(
      line,
    );
    if (!dateMatch) {
      if (/\d/.test(line)) unparsed.push(line);
      continue;
    }
    const date = normalizeDate(dateMatch[1] as string);
    let rest = (dateMatch[2] ?? '').trim();
    if (!date) {
      unparsed.push(line);
      continue;
    }
    let direction: 'in' | 'out' | null = null;
    const directionMatch = /(?:^|[,;|\t ])(in|out|debit|credit)(?:[,;|\t ]|$)/i.exec(rest);
    if (directionMatch) {
      direction = /in|credit/i.test(directionMatch[1] as string) ? 'in' : 'out';
      rest = rest.replace(directionMatch[0], ' ').trim();
    }
    const numbers = [...rest.matchAll(/-?\d+(?:[.,]\d{2})?/g)]
      .map((match) => ({ text: match[0], index: match.index ?? 0 }))
      .filter((match) => /[.,]\d{2}$/.test(match.text) || match.text.startsWith('-'));
    if (numbers.length === 0) {
      unparsed.push(line);
      continue;
    }
    const amountToken = numbers[0] as { text: string; index: number };
    const amount = parseAmount(amountToken.text);
    if (amount === null) {
      unparsed.push(line);
      continue;
    }
    const balanceToken = numbers.length > 1 ? numbers[numbers.length - 1] : null;
    const balance = balanceToken ? parseAmount(balanceToken.text) : null;
    let description = rest
      .slice(0, amountToken.index)
      .replace(/[,;|\t]+/g, ' ')
      .trim();
    description = description.replace(/[-+]\s*$/, '').trim();
    if (!description) description = 'Statement item';
    const inferredDirection = direction ?? (amount < 0 ? 'out' : 'in');
    rows.push({
      date,
      description,
      amount: Math.abs(amount),
      currency: 'USD',
      direction: inferredDirection,
      balance,
      category: null,
      account: null,
      merchant: description,
    });
  }
  return { rows, unparsed };
}

export function signedAmount(row: Pick<TransactionFields, 'direction' | 'amount'>): number {
  return row.direction === 'out' ? -Math.abs(row.amount) : Math.abs(row.amount);
}
