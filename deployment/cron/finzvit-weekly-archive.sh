#!/bin/bash
# Weekly archive and import of the Держстат/ДПС financial statements on cthulhu
# (legal_prod / local.lex), user vovkes.
#
# data.gov.ua package 7436ae83-dfc1-4836-9962-8af3e831c522 ("Фінансова звітність
# підприємств") replaces its monthly files in place and drops old ones (the 2023-2024
# filings made in 2024-2025 are gone), so every file is kept the first time it appears:
#
#   $ARCHIVE/by-resource/<resource_id>/<last_modified YYYY-MM-DDTHH-MM-SS>_<file name>
#   $ARCHIVE/SHA256SUMS                  one line per archived file
#   $ARCHIVE/resources-<date>.tsv        the package listing of each run
#   $ARCHIVE/pending-import.tsv          archived files not imported yet
#
# Files archived by hand before this job used a date-only prefix (YYYY-MM-DD_<name>);
# such a file is adopted once (hard link under the full-timestamp name) when its date
# matches the resource's last_modified, and queued for import like a new download.
#
# Steps: package_show (GET; no HEAD requests, Cloudflare answers them 403), download the
# resources whose (id, last_modified) is not archived yet, check every ZIP fully (CRC of
# all members), then import everything pending into opendata_financial_statements and run
# the incremental financial_figures backfill in one-off containers from the deployed
# backend image (its entrypoint drops to the nodejs user). The pending list is cleared
# only when both steps succeed. DB credentials are copied from the running app container,
# so nothing secret lives here or in the crontab.
#
# Options: --dry-run (list what would be downloaded, change nothing), --no-import.
# Install (merge into the existing crontab):
#   crontab -l | cat - ~/SecondLayer/deployment/cron/finzvit-crontab | crontab -

set -euo pipefail

PKG=7436ae83-dfc1-4836-9962-8af3e831c522
ARCHIVE=${FINZVIT_ARCHIVE:-/mnt/bulk_storage/opendata/finzvit}
JOB_CONTAINER=finzvit-import-weekly
UA="Mozilla/5.0 (compatible; secondlayer-finzvit-archive)"
DRY_RUN=0
NO_IMPORT=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --no-import) NO_IMPORT=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

exec 9>/tmp/finzvit-weekly-archive.lock
flock -n 9 || { echo "$(date -Is) another run holds the lock, skipping"; exit 0; }

mkdir -p "$ARCHIVE/by-resource"
cd "$ARCHIVE"
STAMP=$(date +%F)
PENDING="$ARCHIVE/pending-import.tsv"
LISTING=$(mktemp)
ENV_FILE=""
trap 'rm -f "$LISTING" ${ENV_FILE:+"$ENV_FILE"}' EXIT

# A ZIP is accepted only when every member reads back with a correct CRC.
zip_ok() {
  python3 -I -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.exit(1 if z.testzip() is not None else 0)' "$1" 2>/dev/null
}

echo "$(date -Is) package_show $PKG"
# last_modified keeps its time (":" → "-", fraction dropped), so a resource replaced
# twice on one day is archived twice.
curl -sS --fail --retry 3 --retry-delay 20 -A "$UA" \
  "https://data.gov.ua/api/3/action/package_show?id=$PKG" \
  | jq -r '.result.resources[]
      | select((.url // "") | ascii_downcase | endswith(".zip"))
      | [.id,
         ((.last_modified // .created // "") | .[0:19] | gsub(":"; "-")
           | if test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$") then . + "T00-00-00" else . end),
         (.url | split("/") | last), .url]
      | @tsv' > "$LISTING"
[ -s "$LISTING" ] || { echo "$(date -Is) ERROR: empty resource listing" >&2; exit 1; }
[ "$DRY_RUN" = 1 ] || cp "$LISTING" "resources-$STAMP.tsv"

queued=0
while IFS=$'\t' read -r id lm name url; do
  # Only well-formed ids, timestamps, plain file names and data.gov.ua URLs reach the filesystem.
  if ! [[ "$id" =~ ^[0-9a-f-]{36}$ && "$lm" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}$ \
          && "$name" =~ ^[A-Za-z0-9._-]+$ && "$url" == https://data.gov.ua/* ]]; then
    echo "SKIP malformed resource: $id $lm $name"
    continue
  fi
  rel="$id/${lm}_$name"
  f="by-resource/$rel"
  [ -s "$f" ] && continue
  legacy="by-resource/$id/${lm:0:10}_$name"
  if [ "$DRY_RUN" = 1 ]; then
    if [ -s "$legacy" ]; then echo "WOULD ADOPT $legacy as $f"; else echo "WOULD GET $f"; fi
    continue
  fi
  mkdir -p "by-resource/$id"
  if [ -s "$legacy" ] && zip_ok "$legacy"; then
    echo "$(date -Is) ADOPT $legacy as $f"
    printf '%s\t%s\n' "$lm" "$rel" >> "$PENDING"
    ln "$legacy" "$f"
  else
    echo "$(date -Is) GET $f"
    if ! curl -sSL --fail --retry 3 --retry-delay 30 -A "$UA" -o "$f.part" "$url"; then
      echo "$(date -Is) FAIL download $f" >&2; rm -f "$f.part"; continue
    fi
    if ! zip_ok "$f.part"; then
      echo "$(date -Is) FAIL corrupt zip $f" >&2; rm -f "$f.part"; continue
    fi
    # Queue first, then rename: an interrupted run leaves at most a pending line for a
    # file that is not there yet (dropped below; the next run downloads it again).
    printf '%s\t%s\n' "$lm" "$rel" >> "$PENDING"
    mv "$f.part" "$f"
  fi
  sha256sum "$f" >> SHA256SUMS
  queued=$((queued + 1))
done < "$LISTING"

echo "$(date -Is) newly archived: $queued"
[ "$DRY_RUN" = 1 ] && exit 0
[ -s "$PENDING" ] || exit 0
[ "$NO_IMPORT" = 1 ] && { echo "--no-import: $(sort -u "$PENDING" | wc -l) file(s) left in $PENDING"; exit 0; }

# Data files only (not the field-structure description), present on disk, oldest
# last_modified first, so a newer cumulative file overwrites what an older one held.
IMPORT=()
while IFS=$'\t' read -r _ rel; do
  [ -s "by-resource/$rel" ] || continue
  case "$rel" in */*_opis_*) continue ;; esac
  IMPORT+=("/finzvit/$rel")
done < <(sort -u "$PENDING")
if [ "${#IMPORT[@]}" -eq 0 ]; then echo "nothing to import"; rm -f "$PENDING"; exit 0; fi

APP_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^secondlayer-app-local(-blue|-green)?$' | head -1 || true)
if [ -z "$APP_CONTAINER" ]; then
  echo "$(date -Is) ERROR: no running secondlayer-app-local container; import left in $PENDING" >&2
  exit 1
fi
if docker ps --format '{{.Names}}' | grep -qx "$JOB_CONTAINER"; then
  echo "$(date -Is) $JOB_CONTAINER is still running, import left in $PENDING" >&2
  exit 1
fi
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | awk '{print $1}')

ENV_FILE=$(mktemp)
chmod 600 "$ENV_FILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" \
  | grep -E '^(NODE_ENV|TZ|DATABASE_URL|POSTGRES_(HOST|PORT|USER|PASSWORD|DB))=' > "$ENV_FILE"

# The image entrypoint (backend-entrypoint.sh) drops to the nodejs user before running
# the command, so external archives are never parsed as root.
run_job() {
  docker run --rm --name "$JOB_CONTAINER" \
    --network "$NETWORK" \
    --env-file "$ENV_FILE" \
    -e NODE_OPTIONS=--max-old-space-size=4096 \
    -v "$ARCHIVE/by-resource:/finzvit:ro" \
    --cpu-shares 256 \
    --no-healthcheck \
    "$IMAGE" "$@"
}

echo "$(date -Is) importing ${#IMPORT[@]} file(s) with $IMAGE"
if ! run_job node dist/scripts/import-financial-statements.js "${IMPORT[@]}"; then
  echo "$(date -Is) ERROR: import failed; files left in $PENDING" >&2
  exit 1
fi
if ! run_job node dist/scripts/backfill-financial-figures.js --incremental; then
  echo "$(date -Is) ERROR: backfill failed; files left in $PENDING (re-importing them is a no-op)" >&2
  exit 1
fi
rm -f "$PENDING"
echo "$(date -Is) done"
