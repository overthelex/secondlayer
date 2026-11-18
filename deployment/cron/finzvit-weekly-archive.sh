#!/bin/bash
# Weekly archive and import of the Держстат/ДПС financial statements on cthulhu
# (legal_prod / local.lex), user vovkes.
#
# data.gov.ua package 7436ae83-dfc1-4836-9962-8af3e831c522 ("Фінансова звітність
# підприємств") replaces its monthly files in place and drops old ones (the 2023-2024
# filings made in 2024-2025 are gone), so every file is kept the first time it appears:
#
#   $ARCHIVE/by-resource/<resource_id>/<last_modified YYYY-MM-DD>_<file name>
#   $ARCHIVE/SHA256SUMS                  one line per archived file
#   $ARCHIVE/resources-<date>.tsv        the package listing of each run
#
# Steps: package_show (GET; no HEAD requests, Cloudflare answers them 403), download the
# resources whose (id, last_modified) is not archived yet, then, if anything new arrived,
# import it into opendata_financial_statements and run the incremental financial_figures
# backfill in a one-off container from the deployed backend image. DB credentials are
# copied from the running app container, so nothing secret lives here or in the crontab.
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

cd "$ARCHIVE"
STAMP=$(date +%F)
LISTING=$(mktemp)
trap 'rm -f "$LISTING"' EXIT

echo "$(date -Is) package_show $PKG"
curl -sS --fail --retry 3 --retry-delay 20 -A "$UA" \
  "https://data.gov.ua/api/3/action/package_show?id=$PKG" \
  | jq -r '.result.resources[]
      | select((.url // "") | ascii_downcase | endswith(".zip"))
      | [.id, ((.last_modified // .created // "") | .[0:10]), (.url | split("/") | last), .url]
      | @tsv' > "$LISTING"
[ -s "$LISTING" ] || { echo "$(date -Is) ERROR: empty resource listing" >&2; exit 1; }
[ "$DRY_RUN" = 1 ] || cp "$LISTING" "resources-$STAMP.tsv"

NEW=()
while IFS=$'\t' read -r id lm name url; do
  # Only well-formed ids, dates, plain file names and data.gov.ua URLs reach the filesystem.
  if ! [[ "$id" =~ ^[0-9a-f-]{36}$ && "$lm" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$name" =~ ^[A-Za-z0-9._-]+$ && "$url" == https://data.gov.ua/* ]]; then
    echo "SKIP malformed resource: $id $lm $name"
    continue
  fi
  f="by-resource/$id/${lm}_$name"
  [ -s "$f" ] && continue
  if [ "$DRY_RUN" = 1 ]; then echo "WOULD GET $f"; continue; fi
  mkdir -p "by-resource/$id"
  echo "$(date -Is) GET $f"
  if curl -sSL --fail --retry 3 --retry-delay 30 -A "$UA" -o "$f.part" "$url" \
     && [ "$(head -c 2 "$f.part")" = "PK" ]; then
    mv "$f.part" "$f"
    sha256sum "$f" >> SHA256SUMS
    NEW+=("$lm"$'\t'"$id/${lm}_$name")
  else
    echo "$(date -Is) FAIL $f" >&2
    rm -f "$f.part"
  fi
done < "$LISTING"

echo "$(date -Is) new files: ${#NEW[@]}"
[ "$DRY_RUN" = 1 ] && exit 0

# Files archived but not imported yet (a failed or --no-import run) wait in PENDING.
PENDING="$ARCHIVE/pending-import.tsv"
if [ "${#NEW[@]}" -gt 0 ]; then printf '%s\n' "${NEW[@]}" >> "$PENDING"; fi
[ -s "$PENDING" ] || exit 0
[ "$NO_IMPORT" = 1 ] && { echo "--no-import: $(wc -l < "$PENDING") file(s) left in $PENDING"; exit 0; }

# Data files only (not the field-structure description), oldest last_modified first, so a
# newer cumulative file overwrites what an older one held.
mapfile -t IMPORT < <(sort -u "$PENDING" | cut -f2 | grep -v '/[0-9-]*_opis_' | sed 's|^|/finzvit/|')
[ "${#IMPORT[@]}" -gt 0 ] || { echo "nothing to import"; rm -f "$PENDING"; exit 0; }

APP_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^secondlayer-app-local(-blue|-green)?$' | head -1 || true)
if [ -z "$APP_CONTAINER" ]; then
  echo "$(date -Is) ERROR: no running secondlayer-app-local container; files archived, import skipped" >&2
  exit 1
fi
if docker ps --format '{{.Names}}' | grep -qx "$JOB_CONTAINER"; then
  echo "$(date -Is) $JOB_CONTAINER is still running, import left for the next run" >&2
  exit 1
fi
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")
NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | awk '{print $1}')

ENV_FILE=$(mktemp)
trap 'rm -f "$LISTING" "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" \
  | grep -E '^(NODE_ENV|TZ|DATABASE_URL|POSTGRES_(HOST|PORT|USER|PASSWORD|DB))=' > "$ENV_FILE"

echo "$(date -Is) importing ${#IMPORT[@]} file(s) with $IMAGE"
docker run --rm --name "$JOB_CONTAINER" \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -e NODE_OPTIONS=--max-old-space-size=4096 \
  -v "$ARCHIVE/by-resource:/finzvit:ro" \
  --cpu-shares 256 \
  --no-healthcheck \
  --entrypoint node \
  "$IMAGE" \
  dist/scripts/import-financial-statements.js "${IMPORT[@]}"
rm -f "$PENDING"

docker run --rm --name "$JOB_CONTAINER" \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  --cpu-shares 256 \
  --no-healthcheck \
  --entrypoint node \
  "$IMAGE" \
  dist/scripts/backfill-financial-figures.js --incremental

echo "$(date -Is) done"
