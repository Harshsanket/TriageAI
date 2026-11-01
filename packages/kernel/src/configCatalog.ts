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

export const KERNEL_CONFIG_FIELDS = [
  'profile',
  'queue',
  'modules',
  'capabilities',
  'retention',
  'hosted',
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
  retention: {
    section: 'data',
    label: 'Retention',
    help: 'Delete runs, decisions, audit, candidates, messages and dead letters by age.',
    default: { enabled: false },
    applies: 'immediately',
  },
  hosted: {
    section: 'models',
    label: 'Hosted models',
    help: 'Opt-in API models with provider allowlist and daily budgets.',
    default: { enabled: false, allowedProviders: [] },
    applies: 'soft-reload',
  },
};

export function missingControlMeta(fields: string[]): string[] {
  return fields.filter((field) => !(field in CONTROL_CATALOG));
}
