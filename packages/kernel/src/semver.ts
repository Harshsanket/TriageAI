/**
 * Minimal semver subset for module dependency ranges:
 *   `1.2.3`      exact
 *   `>=0.1.0`    lower-bound only
 *   `^0.1.0`     same-major compatible release
 * Anything else is a boot-time config error (never silently accepted).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`invalid version "${v}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export const compareVersion = (a: Version, b: Version): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

export function satisfiesRange(actual: string, range: string): { ok: boolean; reason?: string } {
  const trimmed = range.trim();
  const op = trimmed.startsWith('>=') ? '>=' : trimmed.startsWith('^') ? '^' : '=';
  const base = op === '=' ? trimmed : op === '>=' ? trimmed.slice(2) : trimmed.slice(1);
  let parsedBase: Version;
  let parsedActual: Version;
  try {
    parsedBase = parseVersion(base);
    parsedActual = parseVersion(actual);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (op === '=') {
    const eq = compareVersion(parsedActual, parsedBase) === 0;
    return eq ? { ok: true } : { ok: false, reason: `${actual} != ${base}` };
  }
  if (op === '>=') {
    const ge = compareVersion(parsedActual, parsedBase) >= 0;
    return ge ? { ok: true } : { ok: false, reason: `${actual} < ${base}` };
  }
  // ^x.y.z: same major, >= base
  if (parsedActual.major !== parsedBase.major) {
    return { ok: false, reason: `major ${parsedActual.major} != ${parsedBase.major}` };
  }
  if (compareVersion(parsedActual, parsedBase) < 0) {
    return { ok: false, reason: `${actual} < ${base} within same major` };
  }
  return { ok: true };
}
