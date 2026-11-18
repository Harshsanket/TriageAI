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

/**
 * Month-partition the remaining append-only tables (Phase 18.T10). The recipe
 * follows 0018/0019: stage under `_partitioned`, create the trailing window and
 * default partition, backfill, drop the legacy table, rename, then recreate the
 * indexes. Legacy rows older than the window land in the default partition.
 */
const APPEND_ONLY_PARTITIONS = `
CREATE OR REPLACE FUNCTION triageai_partition_months(
  p_parent TEXT,
  p_prefix TEXT,
  p_back INT,
  p_ahead INT
) RETURNS VOID AS $$
DECLARE
  month_start DATE;
  month_end DATE;
  partition_name TEXT;
  month_offset INT;
BEGIN
  FOR month_offset IN (-p_back)..p_ahead LOOP
    month_start := (date_trunc('month', now()) + (month_offset || ' month')::interval)::date;
    month_end := (date_trunc('month', now()) + ((month_offset + 1) || ' month')::interval)::date;
    partition_name := p_prefix || '_' || to_char(month_start, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        partition_name, p_parent, month_start, month_end
      );
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = p_prefix || '_default') THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I DEFAULT',
      p_prefix || '_default', p_parent
    );
  END IF;
END $$ LANGUAGE plpgsql;

-- decision_records (drop the stage_runs FK: a partitioned table cannot be the
-- target of a foreign key without its partition key in the referenced key).
CREATE TABLE decision_records_partitioned (
  id TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage_run_id TEXT,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
SELECT triageai_partition_months('decision_records_partitioned', 'decision_records', 14, 2);
INSERT INTO decision_records_partitioned
  (id, org_id, run_id, stage_run_id, workflow_id, workflow_version, module_id,
   module_version, adapter_versions, config_snapshot, input_ref, evidence,
   deterministic, model_output, explanation, explanation_kind, outcome,
   fallback, timings, error, created_at)
SELECT id, org_id, run_id, stage_run_id, workflow_id, workflow_version, module_id,
       module_version, adapter_versions, config_snapshot, input_ref, evidence,
       deterministic, model_output, explanation, explanation_kind, outcome,
       fallback, timings, error, created_at
  FROM decision_records
ON CONFLICT DO NOTHING;
DROP TABLE decision_records;
ALTER TABLE decision_records_partitioned RENAME TO decision_records;
CREATE INDEX IF NOT EXISTS decision_records_run ON decision_records (run_id, stage_run_id);
CREATE INDEX IF NOT EXISTS decision_records_created_brin ON decision_records USING BRIN (created_at);

-- stage_runs
CREATE TABLE stage_runs_partitioned (
  id TEXT NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
SELECT triageai_partition_months('stage_runs_partitioned', 'stage_runs', 14, 2);
INSERT INTO stage_runs_partitioned
  (id, run_id, stage_id, kind, status, attempts, input, output, error,
   started_at, finished_at, created_at)
SELECT id, run_id, stage_id, kind, status, attempts, input, output, error,
       started_at, finished_at, created_at
  FROM stage_runs
ON CONFLICT DO NOTHING;
DROP TABLE stage_runs;
ALTER TABLE stage_runs_partitioned RENAME TO stage_runs;
CREATE INDEX IF NOT EXISTS stage_runs_run ON stage_runs (run_id, stage_id);
CREATE INDEX IF NOT EXISTS stage_runs_created_brin ON stage_runs USING BRIN (created_at);

-- audit_events (chain_seq stays a sequence; uniqueness is per (id, created_at))
CREATE TABLE audit_events_partitioned (
  id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  chain_seq BIGSERIAL,
  prev_hash TEXT,
  hash TEXT,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
SELECT triageai_partition_months('audit_events_partitioned', 'audit_events', 14, 2);
INSERT INTO audit_events_partitioned
  (id, actor, action, subject, payload, created_at, chain_seq, prev_hash, hash)
SELECT id, actor, action, subject, payload, created_at, chain_seq, prev_hash, hash
  FROM audit_events
ON CONFLICT DO NOTHING;
DROP TABLE audit_events;
ALTER TABLE audit_events_partitioned RENAME TO audit_events;
ALTER SEQUENCE IF EXISTS audit_events_partitioned_chain_seq_seq RENAME TO audit_events_chain_seq_seq;
SELECT setval(
  pg_get_serial_sequence('audit_events', 'chain_seq'),
  GREATEST((SELECT COALESCE(MAX(chain_seq), 0) FROM audit_events), 1),
  true
);
CREATE INDEX IF NOT EXISTS audit_events_chain_seq ON audit_events (chain_seq);
CREATE INDEX IF NOT EXISTS audit_events_chain ON audit_events (created_at, id);
CREATE INDEX IF NOT EXISTS audit_events_created_brin ON audit_events USING BRIN (created_at);

-- state_events
CREATE TABLE state_events_partitioned (
  id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INT NOT NULL,
  value JSONB,
  run_id TEXT,
  agent_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
SELECT triageai_partition_months('state_events_partitioned', 'state_events', 14, 2);
INSERT INTO state_events_partitioned
  (id, scope_type, scope_id, key, version, value, run_id, agent_id, at)
SELECT id, scope_type, scope_id, key, version, value, run_id, agent_id, at
  FROM state_events
ON CONFLICT DO NOTHING;
DROP TABLE state_events;
ALTER TABLE state_events_partitioned RENAME TO state_events;
CREATE INDEX IF NOT EXISTS state_events_scope ON state_events (scope_type, scope_id, key, at DESC);
CREATE INDEX IF NOT EXISTS state_events_at_brin ON state_events USING BRIN (at);

-- cost_ledger
CREATE TABLE cost_ledger_partitioned (
  id TEXT NOT NULL,
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
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
SELECT triageai_partition_months('cost_ledger_partitioned', 'cost_ledger', 14, 2);
INSERT INTO cost_ledger_partitioned
  (id, run_id, stage_id, agent_id, task, provider, model, tokens_in, tokens_out,
   tokens_cached, est_cost, actual_cost, currency, at)
SELECT id, run_id, stage_id, agent_id, task, provider, model, tokens_in, tokens_out,
       tokens_cached, est_cost, actual_cost, currency, at
  FROM cost_ledger
ON CONFLICT DO NOTHING;
DROP TABLE cost_ledger;
ALTER TABLE cost_ledger_partitioned RENAME TO cost_ledger;
CREATE INDEX IF NOT EXISTS cost_ledger_run ON cost_ledger (run_id);
CREATE INDEX IF NOT EXISTS cost_ledger_day ON cost_ledger (at, provider);
CREATE INDEX IF NOT EXISTS cost_ledger_at_brin ON cost_ledger USING BRIN (at);

-- outbox_events
CREATE TABLE outbox_events_partitioned (
  id TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
SELECT triageai_partition_months('outbox_events_partitioned', 'outbox_events', 14, 2);
INSERT INTO outbox_events_partitioned
  (id, topic, payload, attempts, available_at, published_at, created_at)
SELECT id, topic, payload, attempts, available_at, published_at, created_at
  FROM outbox_events
ON CONFLICT DO NOTHING;
DROP TABLE outbox_events;
ALTER TABLE outbox_events_partitioned RENAME TO outbox_events;
CREATE INDEX IF NOT EXISTS outbox_events_pending
  ON outbox_events (available_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_events_created_brin ON outbox_events USING BRIN (created_at);

-- app_boots
CREATE TABLE app_boots_partitioned (
  id BIGSERIAL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
SELECT triageai_partition_months('app_boots_partitioned', 'app_boots', 14, 2);
INSERT INTO app_boots_partitioned (id, at)
SELECT id, at FROM app_boots
ON CONFLICT DO NOTHING;
SELECT setval(
  pg_get_serial_sequence('app_boots_partitioned', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM app_boots_partitioned), 1),
  true
);
DROP TABLE app_boots;
ALTER TABLE app_boots_partitioned RENAME TO app_boots;
ALTER SEQUENCE IF EXISTS app_boots_partitioned_id_seq RENAME TO app_boots_id_seq;
CREATE INDEX IF NOT EXISTS app_boots_at ON app_boots (at DESC);
CREATE INDEX IF NOT EXISTS app_boots_at_brin ON app_boots USING BRIN (at);

DROP FUNCTION triageai_partition_months(TEXT, TEXT, INT, INT);
`;

/**
 * 18.T9: per-(collection, model, dims) HNSW indexes are provisioned at boot
 * (`ensureVectorIndexes`) because their predicates contain row values. This
 * migration only adds the lookup index that makes pair discovery and
 * model-filtered scans cheap, and drops the legacy one-size HNSW index — it
 * spanned every collection/model, so a query could not use it without mixing
 * models.
 */
const VECTOR_MODEL_INDEX = `
CREATE INDEX IF NOT EXISTS vector_chunks_collection_model
  ON vector_chunks (collection, embedding_model, dims);
DROP INDEX IF EXISTS vector_chunks_hnsw_384;
-- KB ingestion has stored the embedder in metadata since 13.T7; recover those
-- rows so model-scoped reads keep seeing them. Truly unknown rows stay
-- 'default' and are never mixed into a named model's results.
UPDATE vector_chunks
   SET embedding_model = COALESCE(
         NULLIF(metadata->>'embeddingModel', ''),
         NULLIF(metadata->>'modelVersion', '')
       )
 WHERE embedding_model = 'default'
   AND COALESCE(
         NULLIF(metadata->>'embeddingModel', ''),
         NULLIF(metadata->>'modelVersion', '')
       ) IS NOT NULL;
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
  { id: '0029-partition-append-only', sql: APPEND_ONLY_PARTITIONS },
  {
    id: '0030-activity-events',
    sql: `
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor TEXT NOT NULL DEFAULT 'system',
        kind TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS activity_events_at ON activity_events (at DESC);
      CREATE INDEX IF NOT EXISTS activity_events_kind ON activity_events (kind, at DESC);
      CREATE INDEX IF NOT EXISTS activity_events_actor ON activity_events (actor, at DESC);

      -- Activity writes are best-effort: a trigger failure never blocks the
      -- business write it describes (Phase 18.6).
      CREATE OR REPLACE FUNCTION triageai_activity_record(
        p_actor TEXT,
        p_kind TEXT,
        p_subject TEXT,
        p_summary TEXT,
        p_refs JSONB
      ) RETURNS VOID AS $$
      BEGIN
        INSERT INTO activity_events (id, actor, kind, subject, summary, refs)
        VALUES (
          'act_' || replace(gen_random_uuid()::text, '-', ''),
          COALESCE(NULLIF(p_actor, ''), 'system'),
          p_kind,
          COALESCE(p_subject, ''),
          COALESCE(p_summary, ''),
          COALESCE(p_refs, '[]'::jsonb)
        );
      EXCEPTION WHEN OTHERS THEN
        RETURN;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION triageai_activity_workflow_runs() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM triageai_activity_record(
            COALESCE(NEW.owner_id, 'system'),
            'run',
            NEW.id,
            'run started: ' || NEW.workflow_id,
            jsonb_build_array(NEW.id, NEW.workflow_id)
          );
          RETURN NEW;
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status
           AND NEW.status IN ('SUCCEEDED','FAILED','CANCELLED','AWAITING') THEN
          PERFORM triageai_activity_record(
            COALESCE(NEW.owner_id, 'system'),
            'run',
            NEW.id,
            'run ' || NEW.status || ': ' || NEW.workflow_id
              || COALESCE(' (' || NEW.error || ')', ''),
            jsonb_build_array(NEW.id, NEW.workflow_id)
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION triageai_activity_approvals() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM triageai_activity_record(
            COALESCE(NEW.approver, 'system'),
            'approval',
            NEW.id,
            'approval requested: ' || NEW.tool_name,
            jsonb_build_array(NEW.run_id, NEW.step_id, NEW.id)
          );
        ELSIF NEW.status IS DISTINCT FROM OLD.status
              AND NEW.status IN ('approved','rejected','expired') THEN
          PERFORM triageai_activity_record(
            COALESCE(NEW.approver, 'system'),
            'approval',
            NEW.id,
            'approval ' || NEW.status || ': ' || NEW.tool_name,
            jsonb_build_array(NEW.run_id, NEW.step_id, NEW.id)
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION triageai_activity_stage_runs() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'tool' AND NEW.status IN ('SUCCEEDED','FAILED') THEN
          PERFORM triageai_activity_record(
            'system',
            'tool',
            NEW.run_id,
            'tool step ' || NEW.stage_id || ' ' || lower(NEW.status),
            jsonb_build_array(NEW.run_id, NEW.stage_id, NEW.id)
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION triageai_activity_audit_events() RETURNS trigger AS $$
      DECLARE
        activity_kind TEXT;
      BEGIN
        activity_kind := CASE WHEN NEW.action LIKE 'alert.%' THEN 'alert' ELSE 'config' END;
        PERFORM triageai_activity_record(
          COALESCE(NEW.actor, 'system'),
          activity_kind,
          COALESCE(NEW.subject, NEW.action),
          NEW.action,
          jsonb_build_array(NEW.id)
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS workflow_runs_activity ON workflow_runs;
      CREATE TRIGGER workflow_runs_activity
        AFTER INSERT OR UPDATE OF status ON workflow_runs
        FOR EACH ROW EXECUTE FUNCTION triageai_activity_workflow_runs();

      DROP TRIGGER IF EXISTS approvals_activity ON approvals;
      CREATE TRIGGER approvals_activity
        AFTER INSERT OR UPDATE OF status ON approvals
        FOR EACH ROW EXECUTE FUNCTION triageai_activity_approvals();

      DROP TRIGGER IF EXISTS stage_runs_activity ON stage_runs;
      CREATE TRIGGER stage_runs_activity
        AFTER INSERT ON stage_runs
        FOR EACH ROW EXECUTE FUNCTION triageai_activity_stage_runs();

      DROP TRIGGER IF EXISTS audit_events_activity ON audit_events;
      CREATE TRIGGER audit_events_activity
        AFTER INSERT ON audit_events
        FOR EACH ROW
        WHEN (
          NEW.action LIKE 'config.%' OR NEW.action LIKE 'controls.%'
          OR NEW.action LIKE 'setup.%' OR NEW.action LIKE 'legal_hold.%'
          OR NEW.action LIKE 'privacy.%' OR NEW.action LIKE 'alert.%'
        )
        EXECUTE FUNCTION triageai_activity_audit_events();
    `,
  },
  {
    id: '0031-legal-holds',
    sql: `
      CREATE TABLE IF NOT EXISTS legal_holds (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS legal_holds_class ON legal_holds (class_id);
      CREATE INDEX IF NOT EXISTS legal_holds_expires ON legal_holds (expires_at);
    `,
    dropSql: 'DROP TABLE IF EXISTS legal_holds;',
  },
  {
    id: '0032-trajectory-metrics',
    sql: `
      CREATE TABLE IF NOT EXISTS trajectory_metrics (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_count INT NOT NULL DEFAULT 0,
        redundant_steps INT NOT NULL DEFAULT 0,
        wasted_steps INT NOT NULL DEFAULT 0,
        path_efficiency DOUBLE PRECISION,
        first_failing_node TEXT,
        scores JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS trajectory_metrics_created
        ON trajectory_metrics (created_at DESC);
    `,
    dropSql: 'DROP TABLE IF EXISTS trajectory_metrics;',
  },
  {
    id: '0033-connection-stats',
    sql: `
      CREATE TABLE IF NOT EXISTS connection_stats (
        connection_id TEXT PRIMARY KEY,
        calls BIGINT NOT NULL DEFAULT 0,
        errors BIGINT NOT NULL DEFAULT 0,
        last_success_at TIMESTAMPTZ,
        last_error TEXT,
        latency_ms INT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS connection_stats;',
  },
  {
    // 18.T4/18.T33 scheduler state + routine history, plus queue priority
    // lanes (18.3 concurrency/fairness). One migration so the scheduler and
    // the lane column land atomically.
    id: '0034-scheduler-state-lanes',
    sql: `
      CREATE TABLE IF NOT EXISTS schedule_state (
        schedule_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        watermark JSONB,
        last_run_at TIMESTAMPTZ,
        last_status TEXT,
        skipped_overlap INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS schedule_state_workflow
        ON schedule_state (workflow_id);

      -- One row per routine occurrence (including no_change and overlap skips)
      -- so the receipt can be computed over a window. Manual runs are marked
      -- and excluded from the scheduled window by the API.
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        run_id TEXT,
        due_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        outcome TEXT NOT NULL,
        manual BOOLEAN NOT NULL DEFAULT false,
        useful BOOLEAN NOT NULL DEFAULT false,
        needed_human BOOLEAN NOT NULL DEFAULT false,
        output_empty BOOLEAN NOT NULL DEFAULT false,
        cost NUMERIC(14,6) NOT NULL DEFAULT 0,
        watermark_after JSONB,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_window
        ON schedule_runs (schedule_id, started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_slot
        ON schedule_runs (schedule_id, due_at)
        WHERE due_at IS NOT NULL AND manual = false;

      -- Priority lanes: higher runs first (interactive = 1, background = 0).
      ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS queue_jobs_lane
        ON queue_jobs (queue, status, priority DESC, ready_at);
    `,
    dropSql: `
      DROP TABLE IF EXISTS schedule_runs;
      DROP TABLE IF EXISTS schedule_state;
      ALTER TABLE queue_jobs DROP COLUMN IF EXISTS priority;
    `,
  },
  { id: '0035-vector-model-index', sql: VECTOR_MODEL_INDEX },
];
