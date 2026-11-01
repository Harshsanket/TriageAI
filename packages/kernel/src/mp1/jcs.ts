/**
 * RFC 8785-style JSON canonicalisation for MP1 signatures: recursively sorted
 * object keys, arrays kept in order, JSON scalars as emitted by `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('non-finite numbers are not valid JSON');
  }
  return JSON.stringify(value);
}
