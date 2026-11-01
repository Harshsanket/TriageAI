/**
 * Tool registry + contract validation (Phase 15, ADR-0029).
 *
 * A tool is registered only if its definition is complete. Read/write and
 * low/high are separate labels; the rule floor raises irreversible verbs to
 * high risk so a tool cannot under-declare itself.
 */
import { AppError, policyBlocked, timeout as timeoutError } from '../errors.js';
import type { ErrorCategory } from '../errors.js';
import type { ToolDefinition, ToolInfo, ToolResult } from './types.js';

const NAME = /^[a-z][a-z0-9_]*\.[a-z]+(_[a-z0-9_]+)?$/;
const VERBS = new Set([
  'get',
  'list',
  'search',
  'query',
  'create',
  'update',
  'delete',
  'send',
  'run',
]);

export class ToolContractError extends AppError {
  constructor(readonly problems: string[]) {
    super(
      'kernel.TOOL_CONTRACT_INVALID',
      `Invalid tool definition:\n- ${problems.join('\n- ')}`,
      problems,
      500,
      {
        category: 'internal',
        retryable: false,
      },
    );
    this.name = 'ToolContractError';
  }
}

export function validateToolDefinition<I, O>(def: ToolDefinition<I, O>): string[] {
  const problems: string[] = [];
  if (!NAME.test(def.name)) problems.push(`name "${def.name}" must be <namespace>.<verb>_<object>`);
  const verb = def.name.split('.')[1]?.split('_')[0] ?? '';
  if (!VERBS.has(verb)) problems.push(`verb "${verb}" is not in the fixed verb set`);
  if (def.description.length < 10 || def.description.length > 400) {
    problems.push('description must be 10–400 characters');
  }
  if (!Array.isArray(def.examples) || def.examples.length < 1 || def.examples.length > 2) {
    problems.push('examples must contain 1–2 calls');
  }
  for (const field of ['version', 'owner'] as const) {
    if (!def[field]) problems.push(`${field} is required`);
  }
  if (!def.input || !def.output) problems.push('input and output Zod schemas are required');
  if (!def.scopes?.length) problems.push('scopes must list at least one scope');
  if (!def.timeoutMs || def.timeoutMs <= 0 || def.timeoutMs > 120_000) {
    problems.push('timeoutMs is required and must be 1–120000');
  }
  if (!def.retry || def.retry.maxAttempts < 0) problems.push('retry.maxAttempts is required');
  if (!def.undo) problems.push('undo is required (free | compensable | none)');
  const dangerVerb = def.name.split('.')[1]?.split('_')[0];
  if (def.access === 'write' && (dangerVerb === 'delete' || dangerVerb === 'send')) {
    if (def.undo !== 'none') problems.push(`${dangerVerb} tools must declare undo: none`);
  }
  if (def.undo === 'none' && def.risk !== 'high') {
    problems.push('undo: none always counts as high risk');
  }
  if (def.undo === 'compensable' && typeof def.compensate !== 'function') {
    problems.push('undo: compensable requires compensate()');
  }
  if (def.risk === 'low' && (dangerVerb === 'delete' || dangerVerb === 'send')) {
    problems.push(`${dangerVerb} is always high risk`);
  }
  const highWrite = def.access === 'write' && (def.risk === 'high' || def.riskOf !== undefined);
  if (highWrite && typeof def.preview !== 'function') {
    problems.push('a tool whose calls can be high-risk writes must implement preview()');
  }
  return problems;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private readOnly = false;

  /** Kill switch: read-only mode leaves only read tools callable (18.5). */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  register<I, O>(definition: ToolDefinition<I, O>): void {
    const problems = validateToolDefinition(definition);
    if (problems.length > 0) throw new ToolContractError(problems);
    if (this.tools.has(definition.name)) {
      throw new ToolContractError([`tool ${definition.name} is already registered`]);
    }
    this.tools.set(definition.name, definition as unknown as ToolDefinition<unknown, unknown>);
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      version: tool.version,
      owner: tool.owner,
      description: tool.description,
      access: tool.access,
      risk: tool.risk,
      scopes: tool.scopes,
      timeoutMs: tool.timeoutMs,
      undo: tool.undo,
      idempotent: tool.idempotent,
      ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
    }));
  }

  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  async invoke<O = unknown>(
    name: string,
    input: unknown,
    ctx: import('./types.js').ToolContext,
    options: { approved?: boolean; idempotencyKey?: string } = {},
  ): Promise<ToolResult<O>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('tool.NOT_FOUND', 'not_found', false, `tool ${name} is not registered`);
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      return fail(
        'tool.INVALID_INPUT',
        'validation',
        false,
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        'Fix the arguments and retry.',
      );
    }
    if (this.readOnly && tool.access === 'write') {
      return fail('tool.READ_ONLY', 'policy_blocked', false, 'read-only mode blocks writes');
    }
    const missing = tool.scopes.filter((scope) => !ctx.grantedScopes.includes(scope));
    if (missing.length > 0) {
      return fail('tool.FORBIDDEN', 'forbidden', false, `missing scopes: ${missing.join(', ')}`);
    }
    const risk = tool.riskOf ? tool.riskOf(parsed.data, ctx) : tool.risk;
    const approved = options.approved === true;
    if (tool.access === 'write' && !approved) {
      return fail('tool.APPROVAL_REQUIRED', 'policy_blocked', false, `tool ${name} needs approval`);
    }
    if (tool.risk === 'high' && risk !== 'high') {
      return fail('tool.RISK_UNDER_DECLARED', 'policy_blocked', false, 'risk cannot be lowered');
    }
    if (tool.validate) await tool.validate(parsed.data, ctx);

    const idempotencyKey = options.idempotencyKey ?? `${ctx.runId}:${ctx.stepId}:${name}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(timeoutError(`tool ${name} exceeded ${tool.timeoutMs}ms`));
          }, tool.timeoutMs);
        });
        const data = await Promise.race([
          tool.handler(parsed.data, {
            ...ctx,
            signal: controller.signal,
            idempotencyKey,
          }),
          timedOut,
        ]);
        const output = tool.output.safeParse(data);
        if (!output.success) {
          return fail(
            'tool.INVALID_OUTPUT',
            'internal',
            false,
            output.error.issues.map((issue) => issue.message).join('; '),
          );
        }
        return { ok: true, data: output.data as O };
      } catch (err) {
        const appError = err instanceof AppError ? err : null;
        const category: ErrorCategory = appError?.category ?? 'internal';
        const retryable = appError?.retryable ?? false;
        const canRetry =
          retryable &&
          attempt < tool.retry.maxAttempts + 1 &&
          tool.retry.retryOn.includes(category) &&
          (tool.access === 'read' || tool.idempotent);
        if (!canRetry) {
          return fail(
            appError?.code ?? 'tool.FAILED',
            category,
            retryable,
            appError?.message ?? (err as Error).message,
          );
        }
        const backoff =
          tool.retry.backoff === 'exponential'
            ? Math.min(2_000, 100 * 2 ** (attempt - 1))
            : tool.retry.backoff === 'fixed'
              ? 100
              : 0;
        if (backoff > 0) await new Promise((resolve) => setTimeout(resolve, backoff));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

function fail<O = unknown>(
  code: string,
  category: ErrorCategory,
  retryable: boolean,
  message: string,
  hint?: string,
): ToolResult<O> {
  return { ok: false, error: { code, category, retryable, message, ...(hint ? { hint } : {}) } };
}

export { policyBlocked };
