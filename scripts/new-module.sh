#!/usr/bin/env bash
#
# Scaffold a module in the standard layout (docs/contracts/module-contract.md §6).
#
#   scripts/new-module.sh <name>        # e.g. scripts/new-module.sh emailer
#
# Creates modules/<name>/ with a working, enabled-by-config TriageModule and
# prints the remaining manual steps (host registration, RBAC, Dockerfile).
set -euo pipefail

name="${1:-}"
if [[ ! "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "usage: $0 <name>   (lowercase letters, digits, dashes)" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/modules/$name"
if [[ -e "$dir" ]]; then
  echo "modules/$name already exists" >&2
  exit 1
fi

# camelCase identifier and snake_case table prefix from the dashed name.
camel="$(echo "$name" | awk -F- '{ printf "%s", $1; for (i = 2; i <= NF; i++) printf "%s", toupper(substr($i,1,1)) substr($i,2) }')"
pascal="$(echo "$camel" | awk '{ printf "%s%s", toupper(substr($0,1,1)), substr($0,2) }')"
table="$(echo "$name" | tr '-' '_')"

mkdir -p "$dir/src/stages" "$dir/test"

cat > "$dir/package.json" <<JSON
{
  "name": "@triageai/module-$name",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@triageai/contracts": "workspace:*",
    "@triageai/kernel": "workspace:*",
    "ulid": "^3.0.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.18.6",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
JSON

cp "$root/modules/echo/tsconfig.json" "$dir/tsconfig.json"

cat > "$dir/src/options.ts" <<TS
/** Module options (\`modules.$name.options\`), validated at register time. */
import { z } from 'zod';

export const configSchema = z.object({}).strict();

export type ${pascal}Options = z.infer<typeof configSchema>;
TS

cat > "$dir/src/migrations.ts" <<TS
/** $name-owned tables. Migrations are immutable: add a new entry, never edit one. */
export const MIGRATIONS = [
  {
    id: '0001-$name-tables',
    sql: \`
      CREATE TABLE IF NOT EXISTS ${table}_items (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    \`,
    dropSql: 'DROP TABLE IF EXISTS ${table}_items;',
  },
];
TS

cat > "$dir/src/routes.ts" <<TS
/** HTTP routes. Each one also needs a rule in apps/api/src/platform/auth/rbac.ts. */
import type { KernelContext } from '@triageai/kernel';

import type { ${pascal}Options } from './options.js';

export function registerRoutes(ctx: KernelContext, _options: ${pascal}Options): void {
  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/$name/items',
    handler: async (request) =>
      ctx.database.query(
        \`SELECT id, created_at FROM ${table}_items
         WHERE (\$1::text IS NULL OR owner_id = \$1)
         ORDER BY created_at DESC LIMIT 50\`,
        [request.ownerScope ?? null],
      ),
  });
}
TS

cat > "$dir/src/index.ts" <<TS
/**
 * $name module. Layout: options · migrations · routes (add rows, services,
 * stages/*, workflows, events as it grows — see module-contract §6).
 */
import type { TriageModule } from '@triageai/kernel';

import { MIGRATIONS } from './migrations.js';
import { configSchema } from './options.js';
import { registerRoutes } from './routes.js';

export const ${camel}Module: TriageModule = {
  id: '$name',
  version: '0.1.0',
  capabilities: ['storage'],
  dependsOn: { modules: [], capabilities: [] },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['${table}_items'],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: '$name' }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    registerRoutes(ctx, options);
  },
};
TS

rmdir "$dir/src/stages" 2>/dev/null || true

cat <<NEXT
Created modules/$name. Remaining steps:
  1. pnpm install
  2. apps/api/package.json: add "@triageai/module-$name": "workspace:*"
  3. apps/api/src/app.ts: add '$name': ${camel}Module to MODULES
  4. apps/api/src/platform/auth/rbac.ts: add a rule for GET /api/v1/$name/items
  5. docker/api.Dockerfile: COPY modules/$name/package.json modules/$name/package.json
  6. Enable it in your config: "modules": { "$name": { "enabled": true } }
NEXT
