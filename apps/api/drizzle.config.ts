import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` only needs the URL shape (it does not connect);
 * we fall back to the docker-compose default so generation works without a
 * .env file. `drizzle-kit migrate` DOES connect — have docker compose up and
 * a real .env first.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

export default defineConfig({
  schema: './src/platform/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
