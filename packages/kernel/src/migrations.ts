/**
 * Core (kernel-owned) migrations — always applied before module migrations.
 * Table shapes follow docs/ARCHITECTURE.md §6 and the decision-record contract.
 */
import type { Migration } from './types.js';

const CORE_TABLES = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'endpoint',
  status TEXT NOT NULL DEFAULT 'PENDING',
  idempotency_key TEXT,
  input JSONB,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idempotency per workflow (Phase 1 engine contract §6)
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idem
  ON workflow_runs (workflow_id, idempotency_key);

CREATE TABLE IF NOT EXISTS stage_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INT NOT NULL DEFAULT 0,
  input JSONB,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stage_runs_run ON stage_runs (run_id, stage_id);

CREATE TABLE IF NOT EXISTS decision_records (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage_run_id TEXT REFERENCES stage_runs(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_version TEXT NOT NULL,
  adapter_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_ref TEXT,
  evidence JSONB,
  deterministic JSONB,
  model_output JSONB,
  explanation TEXT,
  explanation_kind TEXT CHECK (explanation_kind IN ('model_generated','deterministic_rule') OR explanation_kind IS NULL),
  outcome JSONB,
  fallback JSONB,
  timings JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decision_records_run ON decision_records (run_id, stage_run_id);

CREATE TABLE IF NOT EXISTS candidate_examples (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  source_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  input JSONB NOT NULL,
  gold JSONB NOT NULL,
  provenance JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  actor TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  example_ids JSONB NOT NULL,
  sha256 TEXT NOT NULL,
  splits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_assets (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL CHECK (component IN ('embedder','classifier','generator','retriever')),
  name TEXT NOT NULL,
  artifact_ref TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  eval_report_id TEXT,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered','candidate','active','rolled_back','retired')),
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  subject_model_id TEXT REFERENCES model_assets(id) ON DELETE SET NULL,
  baseline_model_id TEXT REFERENCES model_assets(id) ON DELETE SET NULL,
  suites JSONB NOT NULL,
  metrics JSONB NOT NULL,
  artifact TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const QUEUE_TABLES = `
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 4,
  ready_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_jobs_ready ON queue_jobs (queue, status, ready_at);
CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_idem
  ON queue_jobs (queue, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS queue_deadletters (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Vector chunks live in kernel infrastructure (pgvector) so any module's
 * retrieval path shares one storage contract (ADR-0013). The column is a
 * dimension-less `vector`: embeddings stay config-bound, and exact scans are
 * fine at Phase-4 scale (no dimension-specific index required).
 */
const VECTOR_TABLES = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_chunks (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS vector_chunks_document ON vector_chunks (collection, document_id);
`;

/**
 * Phase 6 feedback/eval additions. Existing tables were created in 0001, so
 * this migration only widens them; applied databases keep their checksummed
 * history (migrations are immutable).
 */
const FEEDBACK_COLUMNS = `
ALTER TABLE eval_reports ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE eval_reports ADD COLUMN IF NOT EXISTS passes BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE eval_reports ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS datasets_purpose_sha ON datasets (purpose, sha256);
CREATE INDEX IF NOT EXISTS model_assets_component_status ON model_assets (component, status);
CREATE UNIQUE INDEX IF NOT EXISTS model_assets_one_active
  ON model_assets (component) WHERE status = 'active';
`;

/**
 * Phase 9 identity tables. Auth is host-owned (ADR-0020), but the tables are
 * kernel-owned like the rest of the core schema so every host shares one
 * migration history.
 */
const AUTH_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','agent','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_family ON auth_sessions (family_id);
`;

/**
 * Phase 11 setup tables (host-owned semantics, kernel-owned schema like auth):
 * versioned config overlays written by the `/config` wizard, encrypted secrets,
 * and knowledge imports queued until the KB module is running.
 */
const SETUP_TABLES = `
CREATE TABLE IF NOT EXISTS config_overlays (
  version SERIAL PRIMARY KEY,
  overlay JSONB NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setup_imports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  auto_approve BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','imported','failed')),
  error TEXT,
  document_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
`;

const PLUGIN_TABLES = `
CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  key_id TEXT,
  installed_by TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const COST_LEDGER = `
CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  tokens_cached INT NOT NULL DEFAULT 0,
  est_cost NUMERIC(14,6) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(14,6),
  currency TEXT NOT NULL DEFAULT 'USD',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_ledger_run ON cost_ledger (run_id);
CREATE INDEX IF NOT EXISTS cost_ledger_day ON cost_ledger (at, provider);
`;

const AGENT_STATE = `
CREATE TABLE IF NOT EXISTS shared_state (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  updated_by_run TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, key)
);
CREATE TABLE IF NOT EXISTS state_events (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INT NOT NULL,
  value JSONB,
  run_id TEXT,
  agent_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  owner_agent_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  input_refs TEXT[] NOT NULL DEFAULT '{}',
  output_handoff_id TEXT,
  done_when TEXT NOT NULL,
  proof_refs TEXT[] NOT NULL DEFAULT '{}',
  checked_by TEXT,
  review JSONB,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_items_board ON work_items (workspace_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS workspace_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  alternatives TEXT[] NOT NULL DEFAULT '{}',
  made_by TEXT NOT NULL,
  supersedes TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source_refs TEXT[] NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'proposed',
  supersedes TEXT,
  derived_from_untrusted BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  use_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, scope_id, status);
`;

const VECTOR_INDEX = `
ALTER TABLE vector_chunks ADD COLUMN IF NOT EXISTS dims INT;
ALTER TABLE vector_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'default';
UPDATE vector_chunks SET dims = vector_dims(embedding) WHERE dims IS NULL;
CREATE INDEX IF NOT EXISTS vector_chunks_hnsw_384
  ON vector_chunks USING hnsw ((embedding::vector(384)) vector_cosine_ops)
  WHERE dims = 384;
CREATE INDEX IF NOT EXISTS vector_chunks_fts
  ON vector_chunks USING GIN (to_tsvector('english', text));
`;

const APPROVALS = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  on_expiry TEXT NOT NULL DEFAULT 'escalate'
    CHECK (on_expiry IN ('escalate','cancel','park_as_draft')),
  approver TEXT,
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (status, expires_at);
`;

const AUDIT_CHAIN_SEQ = `
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS chain_seq BIGSERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_seq ON audit_events (chain_seq);
`;

const AUDIT_CHAIN = `
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS hash TEXT;
CREATE INDEX IF NOT EXISTS audit_events_chain ON audit_events (created_at, id);
`;

const MODEL_TRACES = `
CREATE TABLE IF NOT EXISTS model_call_traces (
  trace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task TEXT NOT NULL,
  trace JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_call_traces_run ON model_call_traces (run_id, at);
`;

const OUTBOX = `
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_events_pending
  ON outbox_events (available_at) WHERE published_at IS NULL;
`;

const PINNED_VERSIONS = `
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS pinned_versions JSONB NOT NULL DEFAULT '{}'::jsonb;
`;

const AGENT_RUNTIME = `
CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  definition JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_no INT NOT NULL,
  decision TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  run_id TEXT PRIMARY KEY,
  version INT NOT NULL DEFAULT 1,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const MODEL_TRACES_PARTITIONED = `
CREATE TABLE IF NOT EXISTS model_call_traces_partitioned (
  trace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task TEXT NOT NULL,
  trace JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, at)
) PARTITION BY RANGE (at);

DO $$
DECLARE
  start_date DATE := date_trunc('month', now())::date;
  end_date DATE := (date_trunc('month', now()) + interval '1 month')::date;
  partition_name TEXT;
BEGIN
  partition_name := 'model_call_traces_' || to_char(start_date, 'YYYY_MM');
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF model_call_traces_partitioned FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
  END IF;
END $$;

INSERT INTO model_call_traces_partitioned (trace_id, run_id, task, trace, at)
SELECT trace_id, run_id, task, trace, at FROM model_call_traces
ON CONFLICT DO NOTHING;
DROP TABLE model_call_traces;
ALTER TABLE model_call_traces_partitioned RENAME TO model_call_traces;
CREATE INDEX IF NOT EXISTS model_call_traces_run ON model_call_traces (run_id, at);
`;

const MODEL_TRACE_PARTITIONS = `
DO $$
DECLARE
  month_start DATE;
  month_end DATE;
  partition_name TEXT;
  month_offset INT;
BEGIN
  FOR month_offset IN 0..2 LOOP
    month_start := (date_trunc('month', now()) + (month_offset || ' month')::interval)::date;
    month_end := (date_trunc('month', now()) + ((month_offset + 1) || ' month')::interval)::date;
    partition_name := 'model_call_traces_' || to_char(month_start, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF model_call_traces FOR VALUES FROM (%L) TO (%L)',
        partition_name, month_start, month_end
      );
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'model_call_traces_default') THEN
    CREATE TABLE model_call_traces_default PARTITION OF model_call_traces DEFAULT;
  END IF;
END $$;
`;

const JOB_PROGRESS = `
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE TABLE IF NOT EXISTS job_progress (
  job_id TEXT PRIMARY KEY,
  run_id TEXT,
  workflow_id TEXT,
  owner_id TEXT,
  title TEXT NOT NULL,
  stage TEXT,
  done INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'items',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','partial','failed','cancelled','awaiting')),
  error TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_progress_active ON job_progress (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS job_progress_owner ON job_progress (owner_id, created_at DESC);
`;

const USER_PREFERENCES = `
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const VECTOR_SOURCE_ENABLED = `
UPDATE vector_chunks
   SET metadata = metadata || '{"sourceEnabled": true}'::jsonb
 WHERE NOT (metadata ? 'sourceEnabled');
`;

const MODULE_GRANTS = `
CREATE TABLE IF NOT EXISTS module_grants (
  module_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  permissions JSONB NOT NULL,
  run_mode TEXT NOT NULL DEFAULT 'in-process'
    CHECK (run_mode IN ('in-process','worker','container')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const CORE_MIGRATIONS: Migration[] = [
  { id: '0001-core-tables', sql: CORE_TABLES },
  { id: '0002-queue-tables', sql: QUEUE_TABLES },
  { id: '0003-vector-store', sql: VECTOR_TABLES },
  { id: '0004-feedback-columns', sql: FEEDBACK_COLUMNS },
  { id: '0005-auth-tables', sql: AUTH_TABLES },
  { id: '0006-setup-tables', sql: SETUP_TABLES },
  { id: '0007-plugin-installs', sql: PLUGIN_TABLES },
  { id: '0008-cost-ledger', sql: COST_LEDGER },
  { id: '0009-agent-state', sql: AGENT_STATE },
  { id: '0010-vector-index', sql: VECTOR_INDEX },
  { id: '0011-approvals', sql: APPROVALS },
  { id: '0012-audit-chain', sql: AUDIT_CHAIN },
  { id: '0013-audit-chain-seq', sql: AUDIT_CHAIN_SEQ },
  { id: '0014-model-traces', sql: MODEL_TRACES },
  { id: '0015-outbox', sql: OUTBOX },
  { id: '0016-pinned-versions', sql: PINNED_VERSIONS },
  { id: '0017-agent-runtime', sql: AGENT_RUNTIME },
  { id: '0018-partition-model-traces', sql: MODEL_TRACES_PARTITIONED },
  { id: '0019-model-trace-partitions', sql: MODEL_TRACE_PARTITIONS },
  { id: '0020-job-progress', sql: JOB_PROGRESS },
  { id: '0021-vector-source-enabled', sql: VECTOR_SOURCE_ENABLED },
  { id: '0022-user-preferences', sql: USER_PREFERENCES },
  { id: '0023-module-grants', sql: MODULE_GRANTS },
  {
    id: '0024-secret-last-used',
    sql: 'ALTER TABLE secrets ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;',
  },
  {
    id: '0025-uptime-probes',
    sql: `
      CREATE TABLE IF NOT EXISTS uptime_probes (
        id BIGSERIAL PRIMARY KEY,
        target TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ok BOOLEAN NOT NULL,
        latency_ms INT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS uptime_probes_target ON uptime_probes (target, at DESC);
    `,
  },
  {
    id: '0026-user-skills',
    sql: `
      CREATE TABLE IF NOT EXISTS user_skills (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user'
          CHECK (scope IN ('user','instance','agent')),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        version INT NOT NULL DEFAULT 1,
        provenance TEXT NOT NULL DEFAULT 'manual'
          CHECK (provenance IN ('manual','github','chat','custom','suggestion')),
        source_url TEXT,
        source_ref TEXT,
        license TEXT,
        suggestion BOOLEAN NOT NULL DEFAULT false,
        ignored BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS user_skills_owner
        ON user_skills (owner_id, enabled, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS user_skills_owner_name
        ON user_skills (COALESCE(owner_id, ''), name);
    `,
    dropSql: 'DROP TABLE IF EXISTS user_skills;',
  },
  {
    id: '0027-uptime-downsample-boots',
    sql: `
      ALTER TABLE uptime_probes
        ADD COLUMN IF NOT EXISTS downsampled BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS app_boots (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS app_boots_at ON app_boots (at DESC);
    `,
    dropSql: 'DROP TABLE IF EXISTS app_boots;',
  },
  {
    id: '0028-workflow-run-notify',
    sql: `
      CREATE OR REPLACE FUNCTION triageai_notify_workflow_runs() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify(
          'triageai_events',
          json_build_object(
            'table', 'workflow_runs',
            'id', COALESCE(NEW.id, OLD.id),
            'op', TG_OP
          )::text
        );
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS workflow_runs_notify ON workflow_runs;
      CREATE TRIGGER workflow_runs_notify
        AFTER INSERT OR UPDATE OF status ON workflow_runs
        FOR EACH ROW EXECUTE FUNCTION triageai_notify_workflow_runs();
    `,
  },
];
