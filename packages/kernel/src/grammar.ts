/**
 * Workflow grammar (Phase 2): stage input refs + `when` expressions.
 *
 * Deliberately tiny and safe: refs resolve against the run data store; the only
 * permitted operators are comparisons and &&/||/!. Anything else is a boot-time
 * error (see docs/contracts/workflow-contract.md §3).
 */

export interface EvalContext {
  data: Record<string, Record<string, unknown> | undefined>;
  config: Record<string, unknown>;
  runId?: string;
}

const REF = String.raw`\$\{([^}]+)\}`;

function getPath(root: unknown, parts: string[]): unknown {
  let current = root;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Resolve `${...}` / `$.path` style references against the data store. */
export function resolveRef(ref: string, ctx: EvalContext): unknown {
  const raw = ref.trim();
  let path = raw.startsWith('${') && raw.endsWith('}') ? raw.slice(2, -1) : raw;
  path = path.replace(/^\$\.?/, '');
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return undefined;

  if (parts[0] === 'stages') {
    // stages.<stageId>.output.<field...>
    const [, stageId, outputMarker, ...rest] = parts;
    const base = ctx.data[stageId];
    return getPath(base, outputMarker === 'output' ? rest : parts.slice(2));
  }
  if (parts[0] === 'run' && parts[1] === 'id') return ctx.runId;
  if (parts[0] === 'run' && parts[1] === 'input') return getPath(ctx.data.input, parts.slice(2));
  if (parts[0] === 'input') return getPath(ctx.data.input, parts.slice(1));
  if (parts[0] === 'config') return getPath(ctx.config, parts.slice(1));
  if (parts.length === 1) return getPath(ctx.data.input, parts); // $.text shorthand
  // <stageId>.<field...> shorthand
  return getPath(ctx.data[parts[0]], parts.slice(1));
}

/**
 * Resolve a stage `input` mapping. Unprefixed values pass through; strings that
 * look like refs (`$.x` / `${...}`) are resolved.
 */
export function resolveStageInput(
  mapping: Record<string, unknown> | undefined,
  ctx: EvalContext,
): Record<string, unknown> {
  if (!mapping) return { ...(ctx.data.input ?? {}) };
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === 'string' && (value.startsWith('$') || value.startsWith('${'))) {
      resolved[key] = resolveRef(value, ctx);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ── `when` expressions ───────────────────────────────────────────────────────

type Comparison = { ref: string; op: '==' | '!=' | '>=' | '<=' | '>' | '<'; literal: unknown };

function parseLiteral(text: string): unknown {
  const t = text.trim();
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (/^"[^"]*"$/.test(t)) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw new Error(`invalid literal "${t}" (strings must be quoted)`);
}

function parseAtom(atom: string): { negate: boolean; comparison?: Comparison; ref?: string } {
  const trimmed = atom.trim();
  if (!trimmed) throw new Error('empty expression atom');
  let negate = false;
  let body = trimmed;
  if (body.startsWith('!')) {
    negate = true;
    body = body.slice(1).trim();
  }
  const match = new RegExp(String.raw`^${REF}\s*(==|!=|>=|<=|>|<)\s*(.+)$`).exec(body);
  if (match) {
    return {
      negate,
      comparison: {
        ref: match[1] as string,
        op: match[2] as Comparison['op'],
        literal: parseLiteral(match[3] as string),
      },
    };
  }
  const bare = new RegExp(`^${REF}$`).exec(body);
  if (bare) return { negate, ref: bare[1] as string };
  throw new Error(`unsupported expression atom "${trimmed}"`);
}

function splitTopLevel(expr: string, separator: '&&' | '||'): string[] {
  return expr.split(separator).map((part) => part.trim());
}

/** Boot-time validation: throws on unsupported grammar. */
export function validateWhen(when: string): void {
  if (!when.trim()) throw new Error('`when` cannot be empty');
  for (const disjunct of splitTopLevel(when, '||')) {
    for (const conjunct of splitTopLevel(disjunct, '&&')) parseAtom(conjunct);
  }
}

function evaluateAtom(atom: string, ctx: EvalContext): boolean {
  const parsed = parseAtom(atom);
  let result: boolean;
  if (parsed.comparison) {
    const left = resolveRef(parsed.comparison.ref, ctx);
    const right = parsed.comparison.literal;
    switch (parsed.comparison.op) {
      case '==':
        result = left == right; // intentional loose compare for JSON scalars
        break;
      case '!=':
        result = left != right; // intentional loose compare for JSON scalars
        break;
      case '>=':
      case '<=':
      case '>':
      case '<': {
        const l = typeof left === 'number' ? left : String(left ?? '');
        const r = typeof right === 'number' ? right : String(right ?? '');
        if (typeof l !== typeof r) return false;
        result =
          parsed.comparison.op === '>='
            ? l >= r
            : parsed.comparison.op === '<='
              ? l <= r
              : parsed.comparison.op === '>'
                ? l > r
                : l < r;
        break;
      }
    }
  } else {
    result = Boolean(resolveRef(parsed.ref as string, ctx));
  }
  return parsed.negate ? !result : result;
}

/** Evaluate a validated `when` expression (|| binds loosest). */
export function evaluateWhen(when: string, ctx: EvalContext): boolean {
  return splitTopLevel(when, '||').some((disjunct) =>
    splitTopLevel(disjunct, '&&').every((atom) => evaluateAtom(atom, ctx)),
  );
}
