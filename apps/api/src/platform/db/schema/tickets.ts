import { bigint, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.js';

export const ticketStatus = pgEnum('ticket_status', [
  'open',
  'classifying',
  'routing',
  'rag_processing',
  'awaiting_customer',
  'human_review',
  'resolved',
  'closed',
]);

/**
 * Text ULID primary keys (generated in app code via the `ulid` package):
 * sortable by creation time, URL-safe, no central sequence contention.
 */
export const tickets = pgTable('tickets', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: ticketStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Reserved for attachment support (deferred in v1 — text-only tickets).
 * The table exists so adding uploads later is additive, not a redesign.
 * No application code writes to this table yet.
 */
export const ticketAttachments = pgTable('ticket_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
