#!/bin/bash
# Weekly UK refresh. Keeps the register, the current text and the point-in-time
# history in step with legislation.gov.uk without crawling it.
#
# Why this exists
# ---------------
# Measured 2026-09-18: the corpus had not moved since 28 August. There was no UK
# entry in any crontab, the register stopped at uksi/2026/933 while the source was
# publishing uksi/2026/1037, and nothing would ever have noticed. The blocker
# recorded in LEXAI-2007 — "the generic importer cannot run an Atom crawl" — is
# gone: every member of the bulk archives carries its own <ukm:Metadata>, so the
# register is rebuildable from a file download.
#
# What it does NOT do
# -------------------
# Effects (stage 4) are still a crawl of the /changes feeds and need curl_cffi,
# which is not installed here. A weekly effects refresh only needs the current
# year's scopes, roughly two dozen requests, and should be added once that stack
# is on the box. Judgments are not touched at all: the Find Case Law licence
# application is undecided, and fetching more of them before it is decided is
# exactly what we told TNA we had stopped doing.
#
# Install:
#   0 4 * * 1 /home/ubuntu/SecondLayer/scripts/uk/run-uk-refresh.sh >> /data/uk/refresh.log 2>&1
set -uo pipefail

DATA_DIR="${UK_DATA_DIR:-/data/uk}"
PYTHON="${UK_PYTHON:-/home/ubuntu/uk-venv/bin/python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="https://research.legislation.gov.uk/data/downloads/texts"
# Credentials live in a 600 file, not in the crontab line: `crontab -l` is not a
# secret store, and TNA asked that this pre-release login not be shared widely.
if [ -z "${UK_RESEARCH_CREDS:-}" ] && [ -f "$DATA_DIR/research.env" ]; then
  # shellcheck disable=SC1091
  . "$DATA_DIR/research.env"
fi
CREDS="${UK_RESEARCH_CREDS:?set UK_RESEARCH_CREDS=user:password, or put it in $DATA_DIR/research.env}"
UA="LawRider/1.0 (vladimir@lawrider.ch)"
WORKERS="${UK_WORKERS:-3}"

if [ -z "${DATABASE_URL:-}" ]; then
  # shellcheck disable=SC1091
  [ -f "$DATA_DIR/db.env" ] && . "$DATA_DIR/db.env" && export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL is required}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Download a collection only when the server says it changed. The archives are
# rebuilt daily whether or not anything in them moved, so Last-Modified is the
# cheap check that keeps this from pulling 28 GB every week for nothing.
fetch() {
  local coll="$1" url zip stamp remote
  url="$BASE/$coll/xml/$coll-xml.zip"
  zip="$DATA_DIR/$coll-xml.zip"
  stamp="$DATA_DIR/$coll.lastmod"
  remote=$(curl -sS -I -u "$CREDS" -A "$UA" "$url" | awk 'tolower($1)=="last-modified:"{sub($1" ","");print}' | tr -d '\r')
  if [ -f "$zip" ] && [ -f "$stamp" ] && [ "$remote" = "$(cat "$stamp")" ]; then
    log "$coll unchanged ($remote), skipping download"
    return 1
  fi
  log "$coll changed (remote: ${remote:-unknown}), downloading"
  # -C - resumes a partial file, which matters for the 21 GB one.
  if curl -sS -L -C - -u "$CREDS" -A "$UA" -o "$zip" "$url"; then
    printf '%s' "$remote" > "$stamp"
    log "$coll downloaded: $(stat -c %s "$zip") bytes"
    return 0
  fi
  log "$coll download FAILED"
  return 2
}

log "=== UK refresh starting"
fetch revised-current;      rc_cur=$?
fetch enacted-epublished;   rc_enacted=$?
fetch revised-all-versions; rc_all=$?

# The index cache is keyed to the archive's contents, not to its mtime, so it has
# to go BEFORE stage 6 runs — otherwise the run plans this week's work from last
# week's member list and reports a clean no-op over a stale picture.
if [ "$rc_all" = "0" ]; then
  rm -f "$DATA_DIR/revised-all-versions-xml.zip.index.json.gz"
  log "archive changed, dropped the stage 6 index cache"
fi

# Register and current text. --replace because this table holds CURRENT text: an
# act whose revision date moved must not keep its old snapshot alongside the new
# one under a different valid_from.
log "--- stage 5: register + current text"
"$PYTHON" "$HERE/05_load_bulk_texts.py" \
  --zip "$DATA_DIR/revised-current-xml.zip" \
  --zip "$DATA_DIR/enacted-epublished-xml.zip" \
  --with-register --replace || log "stage 5 exited $?"

# Point-in-time. Skips any act whose version count is unchanged, so a week where
# nothing was revised costs one pass over the index and no writes.
log "--- stage 6: point-in-time"
"$PYTHON" "$HERE/06_load_point_in_time.py" \
  --zip "$DATA_DIR/revised-all-versions-xml.zip" \
  --workers "$WORKERS" || log "stage 6 exited $?"

log "=== UK refresh done (downloads: current=$rc_cur enacted=$rc_enacted all=$rc_all; 0=fetched, 1=unchanged, 2=failed)"
