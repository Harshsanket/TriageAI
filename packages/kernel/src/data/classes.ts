/** Data classes (Phase 18.8, ADR-0043): store, keep, retrieve, sensitivity,
 * model use and trust for every table, collection and blob kind. */
export type Sensitivity = 'public' | 'internal' | 'restricted' | 'secret';
export type ModelUse = 'never' | 'local_only' | 'redacted' | 'allowed';
export type RetrievalMethod = 'key' | 'range' | 'fulltext' | 'vector' | 'tool';

export interface DataClass {
  id: string;
  description: string;
  owner: string;
  store: 'postgres' | 'postgres_partitioned' | 'pgvector' | 'blob' | 'cache' | 'secret_store';
  accessPattern: string;
  retention: {
    mode: 'days' | 'with_parent' | 'while_active' | 'until_revoked' | 'ttl';
    days?: number;
    ttlMs?: number;
    legalHoldable: boolean;
    personalData: boolean;
  };
  retrieval: { methods: RetrievalMethod[]; contextFields: string[]; defaultLimit: number };
  sensitivity: Sensitivity;
  modelUse: ModelUse;
  trust: 'trusted' | 'untrusted';
  volatileFields?: string[];
  bounds?: { minRetentionDays?: number; maxRetentionDays?: number; strictestModelUse?: ModelUse };
}

const cls = (
  input: Partial<DataClass> & Pick<DataClass, 'id' | 'description' | 'owner'>,
): DataClass => ({
  store: 'postgres',
  accessPattern: 'key lookup; read-mostly',
  retention: { mode: 'days', days: 365, legalHoldable: true, personalData: false },
  retrieval: { methods: ['key'], contextFields: [], defaultLimit: 50 },
  sensitivity: 'internal',
  modelUse: 'redacted',
  trust: 'trusted',
  ...input,
});

export const DEFAULT_DATA_CLASSES: Record<string, DataClass> = {
  support_tickets: cls({
    id: 'support_tickets',
    description: 'Tickets and their state',
    owner: 'support',
    retention: { mode: 'days', days: 365, legalHoldable: true, personalData: true },
    retrieval: {
      methods: ['key', 'range', 'fulltext'],
      contextFields: ['subject', 'status', 'category', 'body'],
      defaultLimit: 50,
    },
    volatileFields: ['status', 'assignee_id', 'priority_code'],
  }),
  support_ticket_messages: cls({
    id: 'support_ticket_messages',
    description: 'Ticket conversation messages',
    owner: 'support',
    retention: { mode: 'with_parent', legalHoldable: true, personalData: true },
    retrieval: {
      methods: ['key', 'range', 'fulltext'],
      contextFields: ['body', 'author_type'],
      defaultLimit: 50,
    },
    trust: 'untrusted',
  }),
  chat_conversations: cls({
    id: 'chat_conversations',
    description: 'Chat conversations',
    owner: 'chat',
    retrieval: {
      methods: ['key', 'fulltext'],
      contextFields: ['title', 'summary'],
      defaultLimit: 50,
    },
  }),
  chat_messages: cls({
    id: 'chat_messages',
    description: 'Chat turns',
    owner: 'chat',
    retrieval: {
      methods: ['key', 'range', 'fulltext'],
      contextFields: ['role', 'content'],
      defaultLimit: 50,
    },
  }),
  user_preferences: cls({
    id: 'user_preferences',
    description: 'Per-user appearance preferences',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: true },
    retrieval: { methods: ['key'], contextFields: ['preferences'], defaultLimit: 1 },
    sensitivity: 'internal',
    modelUse: 'never',
    trust: 'trusted',
  }),
  user_skills: cls({
    id: 'user_skills',
    description: 'User-created and imported instruction skills',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: true },
    retrieval: {
      methods: ['key', 'fulltext'],
      contextFields: ['name', 'description'],
      defaultLimit: 5,
    },
    sensitivity: 'internal',
    modelUse: 'allowed',
    trust: 'trusted',
  }),
  job_progress: cls({
    id: 'job_progress',
    description: 'Durable progress for long-running jobs',
    owner: 'kernel',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: false },
    retrieval: {
      methods: ['key', 'range'],
      contextFields: ['title', 'stage', 'status'],
      defaultLimit: 50,
    },
    modelUse: 'never',
    trust: 'trusted',
  }),
  extracted_datasets: cls({
    id: 'extracted_datasets',
    description: 'Structured datasets extracted from documents',
    owner: 'data-extract',
    retention: { mode: 'with_parent', legalHoldable: true, personalData: true },
    retrieval: {
      methods: ['key', 'range'],
      contextFields: ['title', 'profile', 'source_label'],
      defaultLimit: 50,
    },
    sensitivity: 'restricted',
    modelUse: 'local_only',
    trust: 'untrusted',
  }),
  extracted_rows: cls({
    id: 'extracted_rows',
    description: 'Typed rows belonging to an extracted dataset',
    owner: 'data-extract',
    retention: { mode: 'with_parent', legalHoldable: true, personalData: true },
    retrieval: { methods: ['key', 'range', 'tool'], contextFields: ['fields'], defaultLimit: 50 },
    sensitivity: 'restricted',
    modelUse: 'local_only',
    trust: 'untrusted',
  }),
  kb_sources: cls({
    id: 'kb_sources',
    description: 'Knowledge source items, hashes and on/off state',
    owner: 'kb',
    retention: { mode: 'with_parent', legalHoldable: true, personalData: false },
    retrieval: {
      methods: ['key', 'fulltext'],
      contextFields: ['title', 'label', 'uri'],
      defaultLimit: 50,
    },
    modelUse: 'never',
    trust: 'untrusted',
  }),
  kb_ingest_items: cls({
    id: 'kb_ingest_items',
    description: 'Per-run extraction and embedding staging rows',
    owner: 'kb',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 50 },
    modelUse: 'never',
    trust: 'untrusted',
  }),
  kb_documents: cls({
    id: 'kb_documents',
    description: 'Knowledge documents',
    owner: 'kb',
    retention: { mode: 'with_parent', legalHoldable: true, personalData: false },
    retrieval: {
      methods: ['key', 'fulltext', 'vector'],
      contextFields: ['title', 'body'],
      defaultLimit: 10,
    },
    modelUse: 'allowed',
    trust: 'untrusted',
  }),
  vector_chunks: cls({
    id: 'vector_chunks',
    description: 'Embedded chunks',
    owner: 'kb',
    store: 'pgvector',
    accessPattern: 'similarity search with metadata filters',
    retention: { mode: 'with_parent', legalHoldable: false, personalData: false },
    retrieval: { methods: ['vector'], contextFields: ['text', 'metadata.title'], defaultLimit: 3 },
    modelUse: 'allowed',
    trust: 'untrusted',
  }),
  workflow_runs: cls({
    id: 'workflow_runs',
    description: 'Run records',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-heavy; read by time range and run id',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'local_only',
  }),
  stage_runs: cls({
    id: 'stage_runs',
    description: 'Stage records',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-heavy; read by run id',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'local_only',
  }),
  decision_records: cls({
    id: 'decision_records',
    description: 'Decision evidence',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-only; read by run id',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'local_only',
  }),
  audit_events: cls({
    id: 'audit_events',
    description: 'Audit log',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-only; read by actor/action/time',
    retention: { mode: 'days', days: 400, legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  cost_ledger: cls({
    id: 'cost_ledger',
    description: 'Model call cost rows',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-only; aggregate by day/provider',
    retention: { mode: 'days', days: 400, legalHoldable: true, personalData: false },
    modelUse: 'never',
  }),
  memories: cls({
    id: 'memories',
    description: 'Long-term memory entries',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: true },
    retrieval: { methods: ['vector', 'key'], contextFields: ['text', 'kind'], defaultLimit: 5 },
  }),
  shared_state: cls({
    id: 'shared_state',
    description: 'Workspace/agent state',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: true },
    retrieval: { methods: ['key', 'range'], contextFields: ['value'], defaultLimit: 50 },
  }),
  work_items: cls({
    id: 'work_items',
    description: 'Workspace task board',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: false },
    retrieval: { methods: ['key', 'range'], contextFields: ['title', 'status'], defaultLimit: 50 },
  }),
  workspace_decisions: cls({
    id: 'workspace_decisions',
    description: 'Workspace decision log',
    owner: 'kernel',
    retention: { mode: 'while_active', legalHoldable: false, personalData: false },
    retrieval: {
      methods: ['key', 'range'],
      contextFields: ['decision', 'reason'],
      defaultLimit: 50,
    },
  }),
  users: cls({
    id: 'users',
    description: 'Accounts',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  secrets: cls({
    id: 'secrets',
    description: 'Encrypted credentials',
    owner: 'kernel',
    store: 'secret_store',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 1 },
    sensitivity: 'secret',
    modelUse: 'never',
  }),
  module_grants: cls({
    id: 'module_grants',
    description: 'Approved module permission manifests (ADR-0054)',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: false },
    sensitivity: 'internal',
    modelUse: 'never',
  }),
  plugin_installs: cls({
    id: 'plugin_installs',
    description: 'Installed plugin metadata',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 50 },
  }),
  public_api_keys: cls({
    id: 'public_api_keys',
    description: 'Hashed public API keys',
    owner: 'public-api',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 1 },
    sensitivity: 'secret',
    modelUse: 'never',
  }),
  email_threads: cls({
    id: 'email_threads',
    description: 'Email Message-ID mapping',
    owner: 'emailer',
    retention: { mode: 'with_parent', legalHoldable: false, personalData: true },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 50 },
    sensitivity: 'restricted',
  }),
  email_outbox: cls({
    id: 'email_outbox',
    description: 'Outbound email approvals',
    owner: 'emailer',
    retention: { mode: 'days', days: 365, legalHoldable: true, personalData: true },
    retrieval: { methods: ['key', 'range'], contextFields: ['subject', 'body'], defaultLimit: 50 },
    sensitivity: 'restricted',
  }),

  auth_sessions: cls({
    id: 'auth_sessions',
    description: 'Refresh-token session families',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: true },
    sensitivity: 'secret',
    modelUse: 'never',
  }),
  candidate_examples: cls({
    id: 'candidate_examples',
    description: 'Feedback candidates',
    owner: 'kernel',
    retention: { mode: 'days', days: 365, legalHoldable: true, personalData: true },
    retrieval: { methods: ['key', 'range'], contextFields: ['input', 'gold'], defaultLimit: 50 },
  }),
  config_overlays: cls({
    id: 'config_overlays',
    description: 'Versioned wizard config overlays',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: true, personalData: false },
    retrieval: { methods: ['key', 'range'], contextFields: [], defaultLimit: 20 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  datasets: cls({
    id: 'datasets',
    description: 'Training dataset versions',
    owner: 'kernel',
    retention: { mode: 'days', days: 365, legalHoldable: false, personalData: true },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 20 },
  }),
  eval_reports: cls({
    id: 'eval_reports',
    description: 'Merged eval reports',
    owner: 'kernel',
    retention: { mode: 'days', days: 365, legalHoldable: false, personalData: false },
    retrieval: { methods: ['key', 'range'], contextFields: ['metrics'], defaultLimit: 20 },
  }),
  model_assets: cls({
    id: 'model_assets',
    description: 'Model registry assets',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: false, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 20 },
  }),
  orgs: cls({
    id: 'orgs',
    description: 'Organisations',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: true, personalData: false },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  queue_deadletters: cls({
    id: 'queue_deadletters',
    description: 'Dead-lettered jobs',
    owner: 'kernel',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  queue_jobs: cls({
    id: 'queue_jobs',
    description: 'Durable queue jobs',
    owner: 'kernel',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  settings: cls({
    id: 'settings',
    description: 'Install settings and setup state',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: true, personalData: false },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 50 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  setup_imports: cls({
    id: 'setup_imports',
    description: 'Queued wizard knowledge imports',
    owner: 'kernel',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: true },
    retrieval: { methods: ['key'], contextFields: ['title', 'body'], defaultLimit: 50 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  state_events: cls({
    id: 'state_events',
    description: 'Append-only shared-state changes',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-only; read by scope/time',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  approvals: cls({
    id: 'approvals',
    description: 'Pending human approvals for tool calls',
    owner: 'kernel',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    retrieval: {
      methods: ['key', 'range'],
      contextFields: ['tool_name', 'preview'],
      defaultLimit: 50,
    },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  model_call_traces: cls({
    id: 'model_call_traces',
    description: 'Per-model-call traces',
    owner: 'kernel',
    store: 'postgres_partitioned',
    accessPattern: 'append-only; read by run id',
    retention: { mode: 'days', days: 14, legalHoldable: true, personalData: true },
    retrieval: { methods: ['key', 'range'], contextFields: [], defaultLimit: 50 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  uptime_probes: cls({
    id: 'uptime_probes',
    description: 'Per-minute health probes for model runtimes and services',
    owner: 'kernel',
    retention: { mode: 'days', days: 400, legalHoldable: false, personalData: false },
    retrieval: {
      methods: ['range'],
      contextFields: ['target', 'ok', 'latency_ms'],
      defaultLimit: 500,
    },
    sensitivity: 'internal',
    modelUse: 'never',
  }),

  outbox_events: cls({
    id: 'outbox_events',
    description: 'Transactional outbox events',
    owner: 'kernel',
    retention: { mode: 'days', days: 30, legalHoldable: false, personalData: true },
    retrieval: { methods: ['key', 'range'], contextFields: [], defaultLimit: 50 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  agent_definitions: cls({
    id: 'agent_definitions',
    description: 'Versioned agent definitions',
    owner: 'kernel',
    retention: { mode: 'until_revoked', legalHoldable: true, personalData: false },
    retrieval: {
      methods: ['key'],
      contextFields: ['display_name', 'definition'],
      defaultLimit: 50,
    },
  }),
  agent_steps: cls({
    id: 'agent_steps',
    description: 'Per-step agent decisions',
    owner: 'kernel',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    retrieval: {
      methods: ['key', 'range'],
      contextFields: ['decision', 'payload'],
      defaultLimit: 50,
    },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
  agent_checkpoints: cls({
    id: 'agent_checkpoints',
    description: 'Versioned agent run state',
    owner: 'kernel',
    retention: { mode: 'days', days: 180, legalHoldable: true, personalData: true },
    retrieval: { methods: ['key'], contextFields: ['state'], defaultLimit: 1 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),

  model_call_traces_partitioned: cls({
    id: 'model_call_traces_partitioned',
    description: 'Temporary staging table for partitioned model traces',
    owner: 'kernel',
    retention: { mode: 'days', days: 1, legalHoldable: false, personalData: true },
    retrieval: { methods: ['key'], contextFields: [], defaultLimit: 1 },
    sensitivity: 'restricted',
    modelUse: 'never',
  }),
};

export function dataClassFor(table: string): DataClass | undefined {
  return DEFAULT_DATA_CLASSES[table];
}

/** Coverage: every migrated table must have a class (18.T14). */
export function missingDataClasses(tables: string[]): string[] {
  return tables.filter((table) => !DEFAULT_DATA_CLASSES[table]);
}
