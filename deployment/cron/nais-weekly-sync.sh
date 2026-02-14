#!/bin/bash
# Weekly NAIS Registry Sync
# Runs inside the openreyestr Docker container
# Install: crontab deployment/cron/nais-crontab

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/secondlayer"
LOG_FILE="${LOG_DIR}/nais-sync.log"

mkdir -p "$LOG_DIR"

echo "========================================" >> "$LOG_FILE"
echo "NAIS weekly sync started: $(date)" >> "$LOG_FILE"

# Determine container name based on environment
if docker ps --format '{{.Names}}' | grep -q 'app-openreyestr-stage'; then
  CONTAINER="app-openreyestr-stage"
elif docker ps --format '{{.Names}}' | grep -q 'app-openreyestr-local'; then
  CONTAINER="app-openreyestr-local"
else
  echo "ERROR: No openreyestr container running" >> "$LOG_FILE"
  exit 1
fi

echo "Using container: $CONTAINER" >> "$LOG_FILE"

docker exec "$CONTAINER" node dist/scripts/sync-all-registries.js --weekly >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "NAIS weekly sync finished: $(date), exit code: $EXIT_CODE" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

exit $EXIT_CODE
