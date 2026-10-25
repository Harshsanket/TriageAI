#!/usr/bin/env bash
#
# Restore a custom-format PostgreSQL dump produced by scripts/backup.sh.
# Run from the repository root. Stop the API first so no writer is active:
#
#   docker compose stop api
#   scripts/restore.sh ./backups/triageai-20261025T120000Z.dump
#   docker compose start api
#
# The restore is destructive (--clean --if-exists): schema objects in the dump
# replace the current ones. Take a fresh backup before a real drill.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup.dump>" >&2
  exit 2
fi

DUMP_FILE="$1"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${DB_USER:-triageai}"
DB_NAME="${DB_NAME:-triageai}"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "dump not found: $DUMP_FILE" >&2
  exit 2
fi

echo "→ restoring ${DUMP_FILE} into ${DB_NAME}"
echo "  (destructive: --clean --if-exists)"
docker compose exec -T "$POSTGRES_SERVICE" \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner <"$DUMP_FILE"

echo "restore complete. Start the API and check:"
echo "  docker compose start api"
echo "  curl -fsS http://localhost:3000/readyz"
echo "  # with AUTH_MODE=required, sign in before checking /api/v1/system/manifest"
