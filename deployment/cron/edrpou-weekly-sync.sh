#!/bin/bash
# Weekly ЄДР (UO/FOP/FSU) sync for openreyestr on cthulhu (legal_prod), user vovkes.
#
# The Ministry of Justice republishes the register on data.gov.ua weekly
# (dataset a1799820-195b-4982-8141-6e84f58103e7, usually on Monday).
# sync-edrpou.js resolves the current zip URLs through CKAN and, with --diff,
# writes only entities whose content hash changed.
#
# Runs in a one-off container from the deployed openreyestr image, not inside
# openreyestr-app-local: a deploy recreates the app container and would kill a
# multi-hour sync halfway. DB credentials are copied from the running app
# container, so nothing secret lives in this file or in the crontab.
#
# Install (merge into the existing crontab):
#   crontab -l | cat - ~/SecondLayer/deployment/cron/edrpou-crontab | crontab -
#
# Logs and the work dir: /data/edrpou-sync (owned by uid 1001, the image user).
#   Progress: tr '\r' '\n' < /data/edrpou-sync/sync-edrpou-<date>.log | tail -3
#   Done when the log ends with "SYNC SUMMARY".

set -euo pipefail

APP_CONTAINER=openreyestr-app-local
JOB_CONTAINER=openreyestr-edrpou-sync-weekly
WORK_DIR=/data/edrpou-sync
STAMP=$(date +%Y%m%d)
LOG="sync-edrpou-${STAMP}.log"

exec 9>/tmp/edrpou-weekly-sync.lock
flock -n 9 || { echo "$(date -Is) another run holds the lock, skipping"; exit 0; }

# Any other sync container (manual run, last week's run still going) → skip.
if docker ps --format '{{.Names}}' | grep -q '^openreyestr-edrpou-sync'; then
  echo "$(date -Is) a sync container is already running, skipping"
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; then
  echo "$(date -Is) ERROR: $APP_CONTAINER is not running" >&2
  exit 1
fi

IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | awk '{print $1}')

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" \
  | grep -E '^(NODE_ENV|TZ|DATABASE_URL|POSTGRES_(HOST|PORT|USER|PASSWORD|DB))=' > "$ENV_FILE"

docker rm -f "$JOB_CONTAINER" >/dev/null 2>&1 || true

docker run -d --rm --name "$JOB_CONTAINER" \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -e EDRPOU_DATA_DIR=/work/data \
  -v "$WORK_DIR:/work" \
  --cpu-shares 256 \
  --no-healthcheck \
  "$IMAGE" \
  sh -c "node dist/scripts/sync-edrpou.js --diff > /work/${LOG} 2>&1" >/dev/null

echo "$(date -Is) started $JOB_CONTAINER from $IMAGE, log $WORK_DIR/$LOG"

# Keep two months of logs.
find "$WORK_DIR" -maxdepth 1 -name 'sync-edrpou-*.log' -mtime +60 -delete 2>/dev/null || true
