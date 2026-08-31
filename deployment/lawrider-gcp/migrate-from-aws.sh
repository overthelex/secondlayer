#!/usr/bin/env bash
# One-off data migration AWS prod -> GCP lawrider box: restore + verify.
#
# Runs ON the GCP box (invoked by the migrate job of
# deploy-lawrider-gcp.yml, or by hand). The GCP box deliberately has NO
# ssh access to AWS: the dump is PUSHED from the AWS side beforehand.
#
# On AWS (one-off, already scripted in the PR description):
#   1. pg_dump -Fd -j2 -Z5 of secondlayer_prod: full schema, data for
#      everything EXCEPT the ~118 large non-UK/CH tables (>200MB) — so
#      uk_*/ch_* data and all small service tables (users, api_keys,
#      billing, ...) arrive, while multi-TB UA/PL/US corpora stay behind
#      as empty tables.
#   2. counts manifest: `SELECT relname, count per uk_*/ch_* table` ->
#      counts.txt next to the dump.
#   3. rsync -a /home/ubuntu/pgdump-lawrider/ ubuntu@<gcp>:/data/pgdump/
#
# This script then:
#   - restores the dump into pg-lawrider (--clean --if-exists, -j4)
#   - verifies every uk_*/ch_* table against counts.txt
#
# FK constraints pointing into the empty excluded tables may fail to
# validate on restore; that is expected and reported, not fatal.

set -euo pipefail

LOCAL_DUMP_DIR="${LOCAL_DUMP_DIR:-/data/pgdump}"
ENV_FILE="${ENV_FILE:-/home/ubuntu/SecondLayer/deployment/.env.prod}"
PG_CONTAINER="pg-lawrider"
APP_CONTAINER="lawrider-app"

log() { echo "[migrate $(date -u +%H:%M:%S)] $*"; }

[ -s "$ENV_FILE" ] || { echo "env file $ENV_FILE missing"; exit 1; }
PGPASSWORD=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)
PGUSER=$(grep '^POSTGRES_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-); PGUSER="${PGUSER:-secondlayer}"
PGDB=$(grep '^POSTGRES_DB=' "$ENV_FILE" | head -1 | cut -d= -f2-); PGDB="${PGDB:-secondlayer_prod}"
export PGPASSWORD

[ "$(cat "$LOCAL_DUMP_DIR/STATUS" 2>/dev/null)" = "DUMP_DONE" ] \
  || { echo "no complete dump at $LOCAL_DUMP_DIR (STATUS != DUMP_DONE) — push it from AWS first"; exit 1; }
[ -s "$LOCAL_DUMP_DIR/counts.txt" ] \
  || { echo "counts manifest $LOCAL_DUMP_DIR/counts.txt missing — generate it on AWS at dump time"; exit 1; }
log "dump present: $(du -sh "$LOCAL_DUMP_DIR/full" | cut -f1), manifest: $(wc -l < "$LOCAL_DUMP_DIR/counts.txt") tables"

# -------------------------------------------------------------- restore ---
log "stopping app for restore"
docker stop "$APP_CONTAINER" 2>/dev/null || true

log "running pg_restore (index builds on ~90GB take a while)"
set +e
docker run --rm --network lawrider \
  -v "$LOCAL_DUMP_DIR/full:/dump:ro" -e PGPASSWORD \
  postgres:15-alpine \
  pg_restore -h "$PG_CONTAINER" -U "$PGUSER" -d "$PGDB" \
    --clean --if-exists --no-owner -j4 /dump \
  >"$LOCAL_DUMP_DIR/restore.log" 2>&1
rc=$?
set -e
errors=$(grep -c '^pg_restore: error:' "$LOCAL_DUMP_DIR/restore.log" || true)
log "pg_restore exit=$rc, errors=$errors (log: $LOCAL_DUMP_DIR/restore.log)"
# FK failures into empty excluded tables are expected; show everything else
grep '^pg_restore: error:' "$LOCAL_DUMP_DIR/restore.log" | grep -v 'foreign key' | head -20 || true

# ---------------------------------------------------------------- verify ---
log "verifying uk_*/ch_* row counts against the AWS manifest"
mismatch=0
while IFS='|' read -r t expected; do
  [ -n "$t" ] || continue
  actual=$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -At -c "SELECT count(*) FROM \"$t\"")
  if [ "$actual" = "$expected" ]; then
    echo "  OK        $t  $actual"
  else
    echo "  MISMATCH  $t  manifest=$expected gcp=$actual"
    mismatch=$((mismatch+1))
  fi
done < "$LOCAL_DUMP_DIR/counts.txt"

log "restarting app"
docker start "$APP_CONTAINER" 2>/dev/null || true

if [ "$mismatch" -gt 0 ]; then
  log "FAILED: $mismatch table(s) mismatched"
  exit 1
fi
log "migration OK: all uk_*/ch_* tables match the manifest"
