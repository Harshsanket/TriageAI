/** `/config` control metadata (Phase 18.T8): one declaration per top-level field. */
export interface ControlMeta {
  section: string;
  label: string;
  help: string;
  default: unknown;
  applies: 'immediately' | 'soft-reload' | 'restart';
  danger?: boolean;
  secret?: boolean;
}

/**
 * Every top-level key of the parsed kernel config schema. The coverage test in
 * `packages/kernel/test/opsEval2.test.ts` diffs this list against the real
 * schema, so adding a field without metadata fails CI.
 */
export const KERNEL_CONFIG_FIELDS = [
  'profile',
  'queue',
  'modules',
  'capabilities',
  'interfaces',
  'retention',
  'hosted',
  'egress',
  'routing',
  'agents',
  'appearance',
] as const;

export const CONTROL_CATALOG: Record<(typeof KERNEL_CONFIG_FIELDS)[number], ControlMeta> = {
  profile: {
    section: 'setup',
    label: 'Profile',
    help: 'core, support or assistant; presets decide default modules.',
    default: 'core',
    applies: 'restart',
  },
  queue: {
    section: 'orchestration',
    label: 'Queue',
    help: 'Postgres queue (default) or inline for tests.',
    default: { adapter: 'pg-queue', pollIntervalMs: 250 },
    applies: 'restart',
  },
  modules: {
    section: 'interfaces',
    label: 'Modules',
    help: 'Enable or disable modules; disabled modules leave no UI or routes.',
    default: {},
    applies: 'soft-reload',
  },
  capabilities: {
    section: 'models',
    label: 'Capabilities',
    help: 'Adapters for embedding, retrieval, generation, validation and output.',
    default: {},
    applies: 'restart',
  },
  interfaces: {
    section: 'setup',
    label: 'Interfaces',
    help: 'Wizard interface choices; each one maps to a module set.',
    default: [],
    applies: 'restart',
  },
  retention: {
    section: 'data',
    label: 'Retention',
    help: 'Delete runs, decisions, audit, candidates, messages and dead letters by age.',
    default: { enabled: false },
    applies: 'immediately',
    danger: true,
  },
  hosted: {
    section: 'models',
    label: 'Hosted models',
    help: 'Opt-in API models with provider allowlist and daily budgets.',
    default: { enabled: false, allowedProviders: [] },
    applies: 'soft-reload',
  },
  egress: {
    section: 'data',
    label: 'Egress allowlist',
    help: 'Hosts outbound HTTP may reach, each with the highest data class it may carry.',
    default: { allowlist: [{ host: 'api.github.com', dataClass: 'public' }] },
    applies: 'soft-reload',
  },
  routing: {
    section: 'models',
    label: 'Model routing',
    help: 'Per-task primary/fallback runtimes, quality floors and price table.',
    default: { tasks: {} },
    applies: 'soft-reload',
  },
  agents: {
    section: 'interfaces',
    label: 'Agent identities',
    help: 'Display names and colours used wherever an agent is shown.',
    default: {},
    applies: 'soft-reload',
  },
  appearance: {
    section: 'interfaces',
    label: 'Appearance defaults',
    help: 'Instance defaults for theme, font size and motion.',
    default: {},
    applies: 'immediately',
  },
};

export function missingControlMeta(fields: string[]): string[] {
  return fields.filter((field) => !(field in CONTROL_CATALOG));
}
