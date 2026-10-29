/** Support-owned tables. Migrations are immutable: add a new entry, never edit one. */

export const MIGRATIONS = [
  {
    id: '0001-support-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        requester TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'NEW',
        category TEXT,
        confidence REAL,
        margin REAL,
        priority TEXT,
        team TEXT,
        classification JSONB,
        routing JSONB,
        idempotency_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK (author_type IN ('customer','agent','system')),
        author TEXT,
        body TEXT NOT NULL,
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS support_ticket_events (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql:
      'DROP TABLE IF EXISTS support_ticket_events; DROP TABLE IF EXISTS support_ticket_messages; DROP TABLE IF EXISTS support_tickets;',
  },
  {
    id: '0002-support-auto-reply',
    sql: `
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS auto_reply JSONB;

      CREATE TABLE IF NOT EXISTS support_auto_reply_policies (
        category TEXT NOT NULL,
        version INT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        fallback_policy TEXT NOT NULL DEFAULT 'escalate_human'
          CHECK (fallback_policy IN ('request_clarification','return_uncertain','escalate_human','halt_run','retry_alternative_retrieval')),
        collection TEXT NOT NULL DEFAULT 'kb_docs',
        max_answer_chars INT NOT NULL DEFAULT 1200,
        note TEXT,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (category, version)
      );

      CREATE TABLE IF NOT EXISTS support_auto_replies (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        run_id TEXT,
        answer TEXT NOT NULL,
        answer_hash TEXT NOT NULL,
        citations JSONB NOT NULL DEFAULT '[]'::jsonb,
        state TEXT NOT NULL CHECK (state IN ('sent','confirmed','failed','escalated')),
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS support_auto_replies_ticket
        ON support_auto_replies (ticket_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS support_auto_replies_failed_hash
        ON support_auto_replies (ticket_id, state, answer_hash);

      INSERT INTO support_auto_reply_policies
        (category, version, enabled, fallback_policy, note)
      VALUES
        ('known_troubleshooting', 1, true, 'request_clarification', 'phase-5 seed'),
        ('billing', 1, true, 'escalate_human', 'phase-5 seed'),
        ('account', 1, true, 'escalate_human', 'phase-5 seed'),
        ('feature_question', 1, true, 'request_clarification', 'phase-5 seed'),
        ('general_question', 1, true, 'request_clarification', 'phase-5 seed'),
        ('security', 1, false, 'escalate_human', 'safety-critical: never auto-reply'),
        ('bug_report', 1, false, 'escalate_human', 'manual triage first'),
        ('refund_dispute', 1, false, 'escalate_human', 'manual triage first')
      ON CONFLICT (category, version) DO NOTHING;
    `,
    dropSql:
      'DROP TABLE IF EXISTS support_auto_replies; DROP TABLE IF EXISTS support_auto_reply_policies;',
  },
  {
    id: '0003-support-triage',
    sql: `
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority_code TEXT;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS team_id TEXT;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS triage JSONB;
      CREATE INDEX IF NOT EXISTS support_tickets_triage
        ON support_tickets (priority_code, team_id);
    `,
  },
  {
    id: '0004-support-owner',
    sql: `
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS owner_id TEXT;
      CREATE INDEX IF NOT EXISTS support_tickets_owner
        ON support_tickets (owner_id, created_at DESC);
    `,
  },
];
