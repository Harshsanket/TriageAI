import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../config.js';
import * as schema from './schema/index.js';

/**
 * Thin postgres.js connection. Drizzle sits on top so queries stay close to
 * SQL — a deliberate choice for learning transactions, indexes, and plans.
 */
export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
