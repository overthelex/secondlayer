#!/bin/bash
# Incremental EDRSR sync from data.gov.ua → prod PostgreSQL
# Downloads current year ZIP, extracts documents.csv, imports new records via
# INSERT ... ON CONFLICT DO NOTHING (idempotent; per-partition unique doc_id skips existing)
#
# Usage:
#   ./sync-edrsr-incremental.sh              # Sync current year (2026)
#   ./sync-edrsr-incremental.sh 2025         # Sync specific year
#   DRY_RUN=true ./sync-edrsr-incremental.sh # Preview without writing
#
# Environment:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE — PostgreSQL connection (or via SSH)
#   SSH_HOST — if set, runs psql via SSH to a remote docker host (e.g. SSH_HOST=prod)
#   PG_DOCKER_CONTAINER — if set, runs psql via a LOCAL docker container (e.g. when the
#     runner is already on the DB host). Takes precedence over SSH_HOST. Avoids ssh-to-self.

set -euo pipefail

YEAR="${1:-$(date +%Y)}"
WORK_DIR="/tmp/edrsr_sync_$$"
LOG_FILE="/tmp/edrsr_sync_${YEAR}.log"
DRY_RUN="${DRY_RUN:-false}"

# ── Dataset URL mapping ──────────────────────────────────────────────
declare -A DATASET_URLS=(
  [2008]="https://data.gov.ua/dataset/5d93b552-2049-43c2-b9a4-32e54653c7e6/resource/e37db396-34fd-40ff-a796-1faa4b5d41b1/download/edrsr_data_2008.zip"
  [2009]="https://data.gov.ua/dataset/dc344166-85f7-4278-bae3-e33331c58029/resource/00a66d4c-77dd-4b83-b088-5ba95ec8ab4f/download/edrsr_data_2009.zip"
  [2010]="https://data.gov.ua/dataset/2fd047e6-35ff-4bf1-88f7-99b5261a9e7f/resource/09d32316-4b87-43d6-9229-db61deede73a/download/edrsr_data_2010.zip"
  [2011]="https://data.gov.ua/dataset/7e9ea7cc-fec1-45d7-8ebe-c0f3d3e406a6/resource/c302808b-6f86-4038-9e2b-340b6ef7b50f/download/edrsr_data_2011.zip"
  [2013]="https://data.gov.ua/dataset/3bc24b95-1f9e-41d6-bffa-c57088474e4a/resource/19eadafb-552b-4eef-89d6-bd17bec95575/download/edrsr_data_2013.zip"
  [2014]="https://data.gov.ua/dataset/e5c3c05a-61f5-4422-a41b-82dff1f71856/resource/93b30460-f857-4879-baf9-48bed096bea8/download/edrsr_data_2014.zip"
  [2015]="https://data.gov.ua/dataset/3951f2eb-a35b-4b35-a305-7afe471a9bca/resource/777859bd-f52c-478b-8d45-956facc40252/download/edrsr_data_2015.zip"
  [2016]="https://data.gov.ua/dataset/66169489-8877-48ae-a061-9eb91852876b/resource/b02dadfa-bea1-4a5e-b851-2a0888b87ef6/download/edrsr_data_2016.zip"
  [2017]="https://data.gov.ua/dataset/a7a72086-8b58-478d-b84b-eaa27d06ae9f/resource/f227a599-08f3-471e-a621-afa3d292b7ed/download/edrsr_data_2017.zip"
  [2018]="https://data.gov.ua/dataset/d2c2af31-cc4e-4a85-9f35-be4dba2354c2/resource/ed9575f6-8041-4581-8622-2fba792ee8ce/download/edrsr_data_2018.zip"
  [2019]="https://data.gov.ua/dataset/1c13f2f1-8bc4-41d4-81dc-ea4527fa73de/resource/c0985958-1fa9-435e-973b-a4863a8be027/download/edrsr_data_2019.zip"
  [2020]="https://data.gov.ua/dataset/83f1292d-43c9-43b8-8f89-aa2f3d14fd3a/resource/d89cd4cf-4705-4700-ba00-69a249ed9894/download/edrsr_data_2020.zip"
  [2021]="https://data.gov.ua/dataset/bcffb3ae-8e4f-4443-8058-d525257ab69e/resource/d26fc705-6744-4c15-87cc-2ce472091101/download/edrsr_data_2021.zip"
  [2022]="https://data.gov.ua/dataset/42c195b3-b915-4000-934a-7741825d1812/resource/57e98c05-4426-41a0-86e7-e04cfe8f6a8c/download/edrsr_data_2022.zip"
  [2023]="https://data.gov.ua/dataset/e0f2c66a-f773-442e-afcd-569be6a36c82/resource/eda19e26-6a9f-4ee7-bf9f-e8577a2f0814/download/edrsr_data_2023.zip"
  [2024]="https://data.gov.ua/dataset/1a6b5c08-0879-4387-8878-ac0027494274/resource/d3427d17-3fe4-4675-9a09-5274cd3476dc/download/edrsr_data_2024.zip"
  [2025]="https://data.gov.ua/dataset/2a95ae17-ed46-42ae-ad66-dd9b7a727bb7/resource/9f19ad2b-000f-4176-b283-95e399ad8e5e/download/edrsr_data_2025.zip"
  [2026]="https://data.gov.ua/dataset/16ab7f06-7414-405f-8354-0a492475272d/resource/b1a4ac1c-b17a-4988-8e6d-dedae8b2dd63/download/edrsr_data_2026.zip"
)
# [2012] — not found on data.gov.ua (gap in published data)

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG_FILE"
}

run_sql() {
  if [ -n "${PG_DOCKER_CONTAINER:-}" ]; then
    docker exec "$PG_DOCKER_CONTAINER" psql -U "${PGUSER:-secondlayer}" -d "${PGDATABASE:-secondlayer_prod}" -v ON_ERROR_STOP=1 -c "$1"
  elif [ -n "${SSH_HOST:-}" ]; then
    ssh -T "$SSH_HOST" "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -v ON_ERROR_STOP=1 -c \"$1\""
  else
    psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "${PGUSER:-secondlayer}" -d "${PGDATABASE:-secondlayer_prod}" -v ON_ERROR_STOP=1 -c "$1"
  fi
}

# Extract first integer from run_sql output. Fails loudly if run_sql failed or
# produced no number — prevents silent "0" that masks SSH/DB errors.
count_sql() {
  local out num
  out=$(run_sql "$1") || { log "ERROR: count query failed: $1"; exit 1; }
  num=$(printf '%s' "$out" | grep -oP '\d+' | head -1)
  if [ -z "$num" ]; then
    log "ERROR: count query returned no number. Output: $out"
    exit 1
  fi
  printf '%s' "$num"
}

copy_to_db() {
  local file="$1"
  # Dedup is delegated to the database: INSERT ... ON CONFLICT DO NOTHING silently skips
  # any row whose doc_id already exists in the target adjudication-year partition (each
  # partition has a unique index on doc_id). This is idempotent and, unlike the old
  # NOT EXISTS anti-join keyed on (doc_id, adjudication_date), it also handles the case
  # where data.gov.ua republishes an existing doc_id with a changed adjudication_date
  # (the anti-join treated that as new and hit the per-partition unique index).
  if [ -n "${PG_DOCKER_CONTAINER:-}" ]; then
    # Runner is on the DB host: copy the CSV straight into the container and import
    # locally (no SSH round-trip).
    docker cp "$file" "${PG_DOCKER_CONTAINER}:/tmp/import.csv"
    docker exec -i "$PG_DOCKER_CONTAINER" psql -U "${PGUSER:-secondlayer}" -d "${PGDATABASE:-secondlayer_prod}" -v ON_ERROR_STOP=1 <<SQLEOF
CREATE TEMP TABLE edrsr_import (LIKE edrsr_documents INCLUDING DEFAULTS);
COPY edrsr_import(doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ)
  FROM '/tmp/import.csv' WITH (FORMAT csv, DELIMITER E'\t', QUOTE '"', NULL '');
INSERT INTO edrsr_documents (doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ)
  SELECT doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ
  FROM edrsr_import ei
  ON CONFLICT DO NOTHING;
-- Backfill doc_url on rows we already have. data.gov.ua publishes a decision first
-- with an empty doc_url and fills it in a later re-publication of the same doc_id,
-- so ON CONFLICT DO NOTHING alone discards every URL that arrives after first sight
-- and the row stays URL-less forever — which silently starves the fulltext scraper
-- (it only fetches docs that have a doc_url). Observed 2026-07-15: 2,356,007 of
-- 5,018,483 2026 rows had no URL while the dump carried one for 98% of them.
-- Only ever fills a blank; never overwrites a URL we already hold. Matching on
-- adjudication_date as well as doc_id keeps this a partition-wise join.
UPDATE edrsr_documents d
  SET doc_url = ei.doc_url
  FROM edrsr_import ei
  WHERE d.doc_id = ei.doc_id
    AND d.adjudication_date = ei.adjudication_date
    AND (d.doc_url IS NULL OR d.doc_url = '')
    AND coalesce(ei.doc_url, '') <> '';
DROP TABLE edrsr_import;
SQLEOF
    docker exec "$PG_DOCKER_CONTAINER" rm -f /tmp/import.csv
  elif [ -n "${SSH_HOST:-}" ]; then
    # Compress before transfer to shrink payload on large files
    local compressed_file="${file}.gz"
    gzip -c "$file" > "$compressed_file"
    local remote_file="/tmp/edrsr_import_$(basename "$file").gz"
    local sql_file="/tmp/edrsr_import.sql"
    # rsync --partial resumes from where the previous attempt died instead of
    # restarting the 100+ MB transfer; scp has no resume and was dropping
    # connection mid-transfer on current-year data (~2.8M rows).
    local attempt
    for attempt in 1 2 3; do
      if rsync -q --partial --timeout=120 -e 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3' \
        "$compressed_file" "${SSH_HOST}:${remote_file}"; then
        break
      fi
      log "rsync attempt $attempt failed, retrying..."
      [ "$attempt" = "3" ] && { log "ERROR: rsync failed after 3 attempts"; rm -f "$compressed_file"; exit 1; }
      sleep $((attempt * 10))
    done
    rm -f "$compressed_file"
    ssh -T "$SSH_HOST" "gunzip -c ${remote_file} > /tmp/edrsr_import.csv && docker cp /tmp/edrsr_import.csv secondlayer-postgres-prod:/tmp/import.csv && rm -f ${remote_file} /tmp/edrsr_import.csv"
    # Create SQL script on remote
    ssh -T "$SSH_HOST" "cat > ${sql_file}" <<'SQLEOF'
CREATE TEMP TABLE edrsr_import (LIKE edrsr_documents INCLUDING DEFAULTS);
COPY edrsr_import(doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ)
  FROM '/tmp/import.csv' WITH (FORMAT csv, DELIMITER E'\t', QUOTE '"', NULL '');
INSERT INTO edrsr_documents (doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ)
  SELECT doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ
  FROM edrsr_import ei
  ON CONFLICT DO NOTHING;
-- Backfill doc_url on rows we already have. data.gov.ua publishes a decision first
-- with an empty doc_url and fills it in a later re-publication of the same doc_id,
-- so ON CONFLICT DO NOTHING alone discards every URL that arrives after first sight
-- and the row stays URL-less forever — which silently starves the fulltext scraper
-- (it only fetches docs that have a doc_url). Observed 2026-07-15: 2,356,007 of
-- 5,018,483 2026 rows had no URL while the dump carried one for 98% of them.
-- Only ever fills a blank; never overwrites a URL we already hold. Matching on
-- adjudication_date as well as doc_id keeps this a partition-wise join.
UPDATE edrsr_documents d
  SET doc_url = ei.doc_url
  FROM edrsr_import ei
  WHERE d.doc_id = ei.doc_id
    AND d.adjudication_date = ei.adjudication_date
    AND (d.doc_url IS NULL OR d.doc_url = '')
    AND coalesce(ei.doc_url, '') <> '';
DROP TABLE edrsr_import;
SQLEOF
    ssh -T "$SSH_HOST" "docker cp ${sql_file} secondlayer-postgres-prod:/tmp/import.sql && rm -f ${sql_file}"
    ssh -T "$SSH_HOST" "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_prod -v ON_ERROR_STOP=1 -f /tmp/import.sql"
    ssh -T "$SSH_HOST" "docker exec secondlayer-postgres-prod rm -f /tmp/import.csv /tmp/import.sql"
  else
    local TAB=$(printf '\t')
    psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "${PGUSER:-secondlayer}" -d "${PGDATABASE:-secondlayer_prod}" -v ON_ERROR_STOP=1 <<SQLEOF
CREATE TEMP TABLE edrsr_import (LIKE edrsr_documents INCLUDING DEFAULTS);
\COPY edrsr_import(doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ) FROM '$file' WITH (FORMAT csv, DELIMITER E'$TAB', QUOTE '"', NULL '');
INSERT INTO edrsr_documents (doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ)
  SELECT doc_id, court_code, judgment_code, justice_kind, category_code, cause_num, adjudication_date, receipt_date, judge, doc_url, status, date_publ
  FROM edrsr_import ei
  ON CONFLICT DO NOTHING;
-- Backfill doc_url on rows we already have. data.gov.ua publishes a decision first
-- with an empty doc_url and fills it in a later re-publication of the same doc_id,
-- so ON CONFLICT DO NOTHING alone discards every URL that arrives after first sight
-- and the row stays URL-less forever — which silently starves the fulltext scraper
-- (it only fetches docs that have a doc_url). Observed 2026-07-15: 2,356,007 of
-- 5,018,483 2026 rows had no URL while the dump carried one for 98% of them.
-- Only ever fills a blank; never overwrites a URL we already hold. Matching on
-- adjudication_date as well as doc_id keeps this a partition-wise join.
UPDATE edrsr_documents d
  SET doc_url = ei.doc_url
  FROM edrsr_import ei
  WHERE d.doc_id = ei.doc_id
    AND d.adjudication_date = ei.adjudication_date
    AND (d.doc_url IS NULL OR d.doc_url = '')
    AND coalesce(ei.doc_url, '') <> '';
DROP TABLE edrsr_import;
SQLEOF
  fi
}

cleanup() {
  rm -rf "$WORK_DIR"
  log "Cleanup done"
}
trap cleanup EXIT

# ── Resolve URL ───────────────────────────────────────────────────────
ZIP_URL="${DATASET_URLS[$YEAR]:-}"
if [ -z "$ZIP_URL" ]; then
  log "ERROR: No URL configured for year $YEAR"
  log "Available years: ${!DATASET_URLS[*]}"
  exit 1
fi

ZIP_FILE="/tmp/edrsr_data_${YEAR}.zip"

log "========================================"
log "EDRSR Incremental Sync: year=$YEAR, dry_run=$DRY_RUN"
log "URL: $ZIP_URL"

# ── Step 1: Get count before ──────────────────────────────────────────
COUNT_BEFORE=$(count_sql "SELECT count(*) FROM edrsr_documents WHERE EXTRACT(YEAR FROM receipt_date) = $YEAR;")
log "Records before: $COUNT_BEFORE"

# ── Step 2: Download ZIP ──────────────────────────────────────────────
log "Downloading edrsr_data_${YEAR}.zip..."
wget -q --show-progress -O "$ZIP_FILE" "$ZIP_URL" 2>&1 | tail -1 || {
  log "ERROR: Download failed"
  exit 1
}
log "Downloaded: $(du -h "$ZIP_FILE" | cut -f1)"

# ── Step 3: Extract documents.csv ─────────────────────────────────────
mkdir -p "$WORK_DIR"
unzip -o "$ZIP_FILE" "documents.csv" -d "$WORK_DIR" 2>/dev/null || \
  unzip -o "$ZIP_FILE" -d "$WORK_DIR"

DOC_FILE="$WORK_DIR/documents.csv"
if [ ! -f "$DOC_FILE" ]; then
  log "ERROR: documents.csv not found in ZIP"
  ls -la "$WORK_DIR"
  exit 1
fi

TOTAL_LINES=$(($(wc -l < "$DOC_FILE") - 1))
log "CSV records: $TOTAL_LINES"

if [ "$DRY_RUN" = "true" ]; then
  log "DRY_RUN: would import $TOTAL_LINES records for year $YEAR"
  log "========================================"
  exit 0
fi

# ── Step 4: Strip header and import ───────────────────────────────────
# Strip the header line only; keep CSV quoting intact so COPY (FORMAT csv,
# QUOTE '"') can parse quoted fields that contain embedded newlines/tabs.
# The old `sed 's/"//g'` stripped every quote, which split multiline fields
# across physical lines and aborted the COPY with
# "missing data for column adjudication_date" (e.g. edrsr_data_2010).
tail -n +2 "$DOC_FILE" > "$WORK_DIR/docs_noheader.csv"

log "Importing into edrsr_documents (ON CONFLICT DO NOTHING)..."
copy_to_db "$WORK_DIR/docs_noheader.csv"

# ── Step 5: Get count after ───────────────────────────────────────────
COUNT_AFTER=$(count_sql "SELECT count(*) FROM edrsr_documents WHERE EXTRACT(YEAR FROM receipt_date) = $YEAR;")
NEW_RECORDS=$((COUNT_AFTER - COUNT_BEFORE))

log "Records after: $COUNT_AFTER"
log "New records imported: $NEW_RECORDS"

# ── Step 6: Update latest receipt date ────────────────────────────────
LATEST=$(run_sql "SELECT max(receipt_date)::date FROM edrsr_documents WHERE EXTRACT(YEAR FROM receipt_date) = $YEAR;" 2>/dev/null | grep -oP '\d{4}-\d{2}-\d{2}' | head -1 || echo "unknown")
log "Latest receipt_date for $YEAR: $LATEST"

# ── Step 7: Refresh the distinct-judge lookup ─────────────────────────
# The judge filter in search_court_decisions resolves a name fragment against
# edrsr_judges_distinct rather than substring-scanning edrsr_documents (135.8M rows
# over 26 partitions — 83-120s before, 33ms after; migration 183).
#
# That view is materialised, so a judge whose first decision arrives in THIS sync
# stays invisible to the filter until it is refreshed. The failure mode is silent:
# a search for that judge returns "nothing found" rather than an error, so nobody
# notices until someone wonders why a real judge has no decisions.
#
# CONCURRENTLY keeps readers unblocked; it requires the unique index idx_ejd_judge,
# which migration 183 creates for precisely this. Measured on prod at 13.1s over
# 135.8M rows, so there is nothing to optimise by doing it incrementally.
#
# This is auxiliary to the import: a failure here warns loudly but must not fail the
# sync, and a missing view (migration not yet applied) is not an error at all —
# resolveJudgeNames falls back to the old substring predicate in that case.
if [ "$NEW_RECORDS" -gt 0 ]; then
  if [ "$(count_sql "SELECT count(*) FROM pg_matviews WHERE matviewname = 'edrsr_judges_distinct';")" -gt 0 ]; then
    log "Refreshing edrsr_judges_distinct (judge lookup)..."
    if run_sql "REFRESH MATERIALIZED VIEW CONCURRENTLY edrsr_judges_distinct;" >/dev/null 2>&1; then
      JUDGES=$(count_sql "SELECT count(*) FROM edrsr_judges_distinct;")
      log "Judge lookup refreshed: $JUDGES distinct judges"
    else
      log "WARNING: REFRESH of edrsr_judges_distinct failed — the judge filter will not see judges added by this sync"
    fi
  else
    log "edrsr_judges_distinct absent (migration 183 not applied) — skipping judge lookup refresh"
  fi
else
  log "No new records — judge lookup refresh not needed"
fi

log "========================================"

# Cleanup ZIP (keep for cache, delete after 7 days)
find /tmp -name "edrsr_data_*.zip" -mtime +7 -delete 2>/dev/null || true

# Exit with error if no new records and it's current year (stale data alert)
if [ "$NEW_RECORDS" -eq 0 ] && [ "$YEAR" = "$(date +%Y)" ]; then
  log "WARNING: No new records for current year — data.gov.ua may not have updated yet"
fi

exit 0
