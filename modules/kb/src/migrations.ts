import type { Migration } from '@triageai/kernel';

export const KB_MIGRATIONS: Migration[] = [
  {
    id: '0001-kb-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        approved BOOLEAN NOT NULL DEFAULT false,
        version INT NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS kb_ingest_runs (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        version INT NOT NULL,
        status TEXT NOT NULL,
        chunk_count INT NOT NULL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS kb_ingest_runs; DROP TABLE IF EXISTS kb_documents;',
  },
  {
    id: '0002-kb-sources',
    sql: `
      CREATE TABLE IF NOT EXISTS kb_sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        uri TEXT,
        media_type TEXT,
        content_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'default',
        chunk_preset TEXT NOT NULL DEFAULT 'structure-700',
        sensitivity TEXT NOT NULL DEFAULT 'internal'
          CHECK (sensitivity IN ('public','internal','restricted','secret')),
        enabled BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','ready','partial','failed')),
        item_count INT NOT NULL DEFAULT 1,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        blob_ref TEXT,
        owner_id TEXT,
        last_sync_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_dedupe
        ON kb_sources (content_hash, embedding_model, chunk_preset)
        WHERE status IN ('pending','ready','partial');
      CREATE INDEX IF NOT EXISTS kb_sources_enabled ON kb_sources (enabled, updated_at DESC);
      ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS source_id TEXT;
      ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS label TEXT;
      ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS media_type TEXT;
      ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS owner_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_source
        ON kb_documents (source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS kb_documents_source_id ON kb_documents (source_id);
      CREATE TABLE IF NOT EXISTS kb_ingest_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        position INT NOT NULL,
        text TEXT,
        chunks JSONB NOT NULL DEFAULT '[]'::jsonb,
        chunk_count INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','ready','embedded','succeeded','failed','skipped')),
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, source_id)
      );
    `,
    dropSql: `
      DROP TABLE IF EXISTS kb_ingest_items;
      DROP TABLE IF EXISTS kb_sources;
      DROP INDEX IF EXISTS kb_documents_source_id;
      DROP INDEX IF EXISTS kb_documents_source;
      ALTER TABLE IF EXISTS kb_documents DROP COLUMN IF EXISTS owner_id;
      ALTER TABLE IF EXISTS kb_documents DROP COLUMN IF EXISTS media_type;
      ALTER TABLE IF EXISTS kb_documents DROP COLUMN IF EXISTS label;
      ALTER TABLE IF EXISTS kb_documents DROP COLUMN IF EXISTS source_id;
    `,
  },
  {
    id: '0004-kb-no-approval',
    sql: `
      ALTER TABLE kb_documents ALTER COLUMN approved SET DEFAULT true;
      UPDATE kb_documents SET approved = true WHERE approved = false;
    `,
    dropSql: '',
  },
  {
    id: '0005-kb-managed-sources',
    sql: `
      ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS managed_key TEXT;
      ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'public'
        CHECK (audience IN ('public','operator'));
      ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_managed_key
        ON kb_sources (managed_key) WHERE managed_key IS NOT NULL;
    `,
    dropSql: `
      DROP INDEX IF EXISTS kb_sources_managed_key;
      ALTER TABLE IF EXISTS kb_sources DROP COLUMN IF EXISTS read_only;
      ALTER TABLE IF EXISTS kb_sources DROP COLUMN IF EXISTS audience;
      ALTER TABLE IF EXISTS kb_sources DROP COLUMN IF EXISTS managed_key;
    `,
  },
];
