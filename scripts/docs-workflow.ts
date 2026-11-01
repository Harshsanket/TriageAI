/**
 * WORKFLOW.md generator (Phase 19.1).
 *
 * The hand-written prose lives in WORKFLOW.md; the tables that drift live
 * between `<!-- generated:<name> -->` markers and are produced here from the
 * same declarations the code uses:
 *   - routes/roles: `ROUTE_RULES` (enforced by the RBAC coverage test)
 *   - presets: `config/presets/*.json`
 *   - workflows/stages: module `register()` declarations
 *   - model catalog: `config/model-presets.json`
 *
 * Usage:
 *   pnpm docs:workflow          # rewrite the generated blocks
 *   pnpm docs:workflow:check    # fail if the file is stale, missing a section
 *                               # or over the line budget (CI)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { KernelContext, KernelRouteDef, WorkflowDef } from '../packages/kernel/src/types.js';
import { ROUTE_RULES } from '../apps/api/src/platform/auth/rbac.js';
import type { RouteRule } from '../apps/api/src/platform/auth/rbac.js';
import { MODULES } from '../apps/api/src/modules.js';

/** Works from the repo root and from `apps/api` (where pnpm runs the script). */
const ROOT = existsSync(join(process.cwd(), 'WORKFLOW.md'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const DOC_PATH = join(ROOT, 'WORKFLOW.md');

/** One screen per section, about 400 lines total (DEVELOPMENT_PLAN §19.1). */
export const LINE_BUDGET = 450;

export const REQUIRED_SECTIONS = [
  '1. System design',
  '2. Input contract',
  '3. Output contract',
  '4. Routing logic',
  '5. Coordination overhead',
  '6. Inspecting logs',
  '7. Tracking agents',
  '8. Context awareness',
  '9. Observability',
  '10. Model-use strategy',
  '11. Cost',
  '12. Efficiency',
  '13. Where things are',
  '14. Errors and degradation',
] as const;

export type BlockName = 'routes' | 'presets' | 'workflows' | 'models';

interface WorkflowSummary {
  id: string;
  module: string;
  version: string;
  trigger: string;
  stages: Array<{ id: string; kind: string; conditional: boolean }>;
}

function inert(): unknown {
  const fn = () => inert();
  return new Proxy(fn, {
    get: (_target, key) => (key === 'then' ? undefined : inert()),
  });
}

/** Register every module against a capturing context; no DB or network calls. */
function captureModules(): { workflows: WorkflowSummary[] } {
  const workflows: WorkflowSummary[] = [];

  const modules = Object.entries(MODULES).sort(([a], [b]) => a.localeCompare(b));
  for (const [, module] of modules) {
    const ctx = {
      moduleOptions: {},
      capabilities: inert(),
      database: inert(),
      events: { subscribe: () => () => undefined },
      queue: {
        start: (def: WorkflowDef) => {
          workflows.push({
            id: def.id,
            module: def.module,
            version: def.version,
            trigger: def.trigger.type,
            stages: def.stages.map((stage) => ({
              id: stage.id,
              kind: stage.kind,
              conditional: Boolean(stage.when),
            })),
          });
        },
        startWorkflow: async () => ({ runId: '', deduped: false }),
        registerWorker: () => undefined,
        drain: async () => undefined,
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      registerRoute: (_route: KernelRouteDef) => undefined,
      provideCapability: () => undefined,
      registerEventSchema: () => undefined,
      registerStageHandler: () => undefined,
      registerTool: () => undefined,
      registerOutputChannel: () => undefined,
      registerRetentionTask: () => undefined,
      registerKnowledgeSource: () => undefined,
      registerDashboardProvider: () => undefined,
      registerMetricsProvider: () => undefined,
      knowledgeSources: { get: () => undefined, register: () => undefined, list: () => [] },
      reportProgress: async () => undefined,
      enabledModules: [],
      config: { profile: 'core', queue: { adapter: 'inline' }, modules: {}, capabilities: {} },
      env: {},
    } as unknown as KernelContext;

    module.register(ctx);
  }

  return { workflows };
}

export function generateRoutesBlock(rules: RouteRule[] = ROUTE_RULES): string {
  const rows = [...rules].sort(
    (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method),
  );
  return [
    '| Method | Path | Roles |',
    '| --- | --- | --- |',
    ...rows.map((rule) => {
      const roles =
        rule.roles === 'public' || rule.roles === 'key' ? rule.roles : rule.roles.join(', ');
      return `| ${rule.method} | \`${rule.pattern}\` | ${roles} |`;
    }),
  ].join('\n');
}

export function generatePresetsBlock(presetsDir = join(ROOT, 'config/presets')): string {
  const files = readdirSync(presetsDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const rows = files.map((file) => {
    const raw = JSON.parse(readFileSync(join(presetsDir, file), 'utf8')) as {
      profile?: string;
      modules?: Record<string, { enabled?: boolean }>;
      capabilities?: Record<string, { adapter?: string }>;
    };
    const enabled = Object.entries(raw.modules ?? {})
      .filter(([, value]) => value.enabled)
      .map(([id]) => id)
      .sort();
    const adapters = Object.entries(raw.capabilities ?? {})
      .map(([id, value]) => `${id}:${value.adapter ?? '?'}`)
      .sort();
    return `| \`${file.replace(/\.json$/, '')}\` | ${raw.profile ?? '—'} | ${
      enabled.join(', ') || '—'
    } | ${adapters.join(', ') || '—'} |`;
  });
  return [
    '| Preset | Profile | Enabled modules | Capability adapters |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function generateWorkflowsBlock(): string {
  const { workflows } = captureModules();
  workflows.sort((a, b) => a.id.localeCompare(b.id));
  const rows = workflows.map((workflow) => {
    const stages = workflow.stages
      .map((stage) => `${stage.id}${stage.conditional ? '?' : ''}`)
      .join(' → ');
    return `| \`${workflow.id}\` | ${workflow.module} | ${workflow.version} | ${workflow.trigger} | ${stages} |`;
  });
  return [
    '| Workflow | Module | Version | Trigger | Stages |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '`?` marks a stage with a `when` guard; the full expressions are in the module workflows.',
  ].join('\n');
}

interface PresetModel {
  runtimeModel: string;
  contextLength?: number;
  license?: string;
  note?: string;
}

export function generateModelsBlock(
  modelPresetsPath = join(ROOT, 'config/model-presets.json'),
): string {
  const raw = JSON.parse(readFileSync(modelPresetsPath, 'utf8')) as {
    generation?: Record<string, PresetModel[]>;
    embedding?: PresetModel[];
  };
  const rows: string[] = [];
  for (const [tier, models] of Object.entries(raw.generation ?? {})) {
    for (const model of models) rows.push(modelRow(`generation.${tier}`, model));
  }
  for (const model of raw.embedding ?? []) rows.push(modelRow('embedding', model));
  return [
    '| Tier | Runtime model | Context | Licence | Note |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function modelRow(tier: string, model: PresetModel): string {
  const context = model.contextLength ? model.contextLength.toLocaleString('en-US') : '—';
  return `| ${tier} | \`${model.runtimeModel}\` | ${context} | ${model.license ?? '—'} | ${
    model.note ?? '—'
  } |`;
}

export function buildBlocks(): Record<BlockName, string> {
  return {
    routes: generateRoutesBlock(),
    presets: generatePresetsBlock(),
    workflows: generateWorkflowsBlock(),
    models: generateModelsBlock(),
  };
}

export function renderWorkflowDoc(doc: string, blocks: Record<BlockName, string>): string {
  let rendered = doc;
  for (const [name, content] of Object.entries(blocks)) {
    const pattern = new RegExp(
      `<!-- generated:${name} -->\\n[\\s\\S]*?\\n<!-- /generated:${name} -->`,
    );
    if (!pattern.test(rendered)) {
      throw new Error(
        `WORKFLOW.md is missing the "generated:${name}" marker pair (see scripts/docs-workflow.ts)`,
      );
    }
    rendered = rendered.replace(
      pattern,
      () => `<!-- generated:${name} -->\n\n${content}\n\n<!-- /generated:${name} -->`,
    );
  }
  return rendered;
}

function validateDoc(doc: string): string[] {
  const problems: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!doc.split('\n').some((line) => line.startsWith(`## ${section}`))) {
      problems.push(`missing section: "## ${section}"`);
    }
  }
  const lines = doc.split('\n').length;
  if (lines > LINE_BUDGET) {
    problems.push(`WORKFLOW.md is ${lines} lines; the budget is ${LINE_BUDGET}`);
  }
  return problems;
}

/** Problems that should fail CI: missing sections, budget, stale blocks. */
export function checkWorkflowDoc(doc: string, blocks = buildBlocks()): string[] {
  const rendered = renderWorkflowDoc(doc, blocks);
  const problems = validateDoc(rendered);
  if (rendered !== doc) {
    problems.push('generated blocks are stale; run `pnpm docs:workflow`');
  }
  return problems;
}

function main(): void {
  const check = process.argv.includes('--check');
  const doc = readFileSync(DOC_PATH, 'utf8');
  try {
    const blocks = buildBlocks();
    const rendered = renderWorkflowDoc(doc, blocks);
    const problems = validateDoc(rendered);
    if (check && rendered !== doc) {
      problems.push('generated blocks are stale; run `pnpm docs:workflow`');
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      process.exitCode = 1;
      return;
    }
    if (!check) {
      writeFileSync(DOC_PATH, rendered);
      console.log(`wrote ${relative(ROOT, DOC_PATH)} (${rendered.split('\n').length} lines)`);
      return;
    }
    console.log('WORKFLOW.md is up to date');
  } catch (error) {
    console.error(`docs-workflow: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, 'scripts/docs-workflow.ts')) {
  main();
}
