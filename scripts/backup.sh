#!/usr/bin/env bash
#
# Backup the platform: PostgreSQL (custom-format dump) + a redacted config
# snapshot. Run from the repository root. Restore with scripts/restore.sh.
#
#   BACKUP_DIR=./backups TOKEN="<admin access token>" scripts/backup.sh
#
# TOKEN is optional; without it the database dump still runs, but the config
# export is skipped. The config export is redacted (secrets stay in env).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
DB_USER="${DB_USER:-triageai}"
DB_NAME="${DB_NAME:-triageai}"
API_URL="${API_URL:-http://localhost:3000}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
DUMP_FILE="$BACKUP_DIR/triageai-${STAMP}.dump"

echo "→ dumping ${DB_NAME} to ${DUMP_FILE}"
docker compose exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner >"$DUMP_FILE"

if [[ -n "${TOKEN:-}" ]]; then
  echo "→ exporting redacted config"
  curl -fsS -H "authorization: Bearer ${TOKEN}" \
    "${API_URL}/api/v1/system/config" \
    >"$BACKUP_DIR/config-${STAMP}.json"
else
  echo "→ TOKEN not set; skipping config export (env secrets are never exported)"
fi

echo "backup complete:"
ls -lh "$BACKUP_DIR" | tail -n +2
echo
echo "Restore (stop the API first):"
echo "  docker compose stop api"
echo "  scripts/restore.sh ${DUMP_FILE}"
