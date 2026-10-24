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

export const CORE_MIGRATIONS: Migration[] = [
  { id: '0001-core-tables', sql: CORE_TABLES },
  { id: '0002-queue-tables', sql: QUEUE_TABLES },
  { id: '0003-vector-store', sql: VECTOR_TABLES },
  { id: '0004-feedback-columns', sql: FEEDBACK_COLUMNS },
];
