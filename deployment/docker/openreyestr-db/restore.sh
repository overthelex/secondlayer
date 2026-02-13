#!/bin/bash
set -e

echo "Restoring OpenReyestr database from pre-loaded dump..."
pg_restore \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --no-owner \
  --no-privileges \
  --verbose \
  /docker-entrypoint-initdb.d/openreyestr_dump.backup || true

echo "OpenReyestr database restore complete."

# Clean up dump file to save space in running container
rm -f /docker-entrypoint-initdb.d/openreyestr_dump.backup
