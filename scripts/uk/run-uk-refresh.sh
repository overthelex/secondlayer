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
#
# ⚠⚠ No `curl -C -` here, deliberately. Resuming looks right for a 21 GB file and
# is actively unsafe for this source: the archives are REBUILT daily, so a partial
# file from a failed run and today's rebuild are different objects, and appending
# one to the other produces a file curl reports as a clean exit 0. Measured on
# 2026-09-18: a resume grew revised-current from 2,726,999,910 to 2,727,081,130
# bytes — exactly today's Content-Length — and the result was unreadable,
# `BadZipFile: Bad magic number for central directory`. A full re-download costs
# ten minutes on this box; a corrupt archive costs a silent bad load.
#
# Download into .part and rename only after the bytes are checked, so a run killed
# mid-download can never leave something the next stage will happily open.
fetch() {
  local coll="$1" url zip part stamp hdr remote len got
  url="$BASE/$coll/xml/$coll-xml.zip"
  zip="$DATA_DIR/$coll-xml.zip"
  part="$zip.part"
  stamp="$DATA_DIR/$coll.lastmod"

  hdr=$(curl -sS -I -u "$CREDS" -A "$UA" "$url") || { log "$coll HEAD failed"; return 2; }
  remote=$(printf '%s' "$hdr" | awk 'tolower($1)=="last-modified:"{sub($1" ","");print}' | tr -d '\r')
  len=$(printf '%s' "$hdr" | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r')

  # A server that stops sending Last-Modified would otherwise compare "" to ""
  # and report every archive unchanged for ever.
  if [ -n "$remote" ] && [ -f "$zip" ] && [ -f "$stamp" ] && [ "$remote" = "$(cat "$stamp")" ]; then
    log "$coll unchanged ($remote), skipping download"
    return 1
  fi

  log "$coll changed (remote: ${remote:-unknown}, ${len:-?} bytes), downloading"
  rm -f "$part"
  # --fail: without it curl exits 0 on 401/404/500 and writes the error page to
  # $part. The size and zip checks below would catch it, but failing at the
  # request is clearer than failing two checks later on a 900-byte "archive".
  if ! curl -sS -L --fail -u "$CREDS" -A "$UA" -o "$part" "$url"; then
    log "$coll download FAILED"; rm -f "$part"; return 2
  fi

  got=$(stat -c %s "$part" 2>/dev/null || echo 0)
  if [ -n "$len" ] && [ "$got" != "$len" ]; then
    log "$coll size mismatch: got $got, expected $len — discarding"
    rm -f "$part"; return 2
  fi
  # Opening the zip is what actually proves it: a truncated or spliced file passes a
  # size check often enough to be worth one more second here.
  if ! python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).namelist()' "$part" 2>/dev/null; then
    log "$coll downloaded $got bytes but the archive does not open — discarding"
    rm -f "$part"; return 2
  fi

  if ! mv -f "$part" "$zip"; then
    log "$coll verified but could not be installed at $zip — leaving the stamp alone"
    rm -f "$part"; return 2
  fi
  printf '%s' "$remote" > "$stamp"
  log "$coll downloaded and verified: $got bytes"
  return 0
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
rc=0
"$PYTHON" "$HERE/05_load_bulk_texts.py" \
  --zip "$DATA_DIR/revised-current-xml.zip" \
  --zip "$DATA_DIR/enacted-epublished-xml.zip" \
  --with-register --replace --reconcile-counters || { rc=$?; log "stage 5 exited $rc"; failed=1; }

# Point-in-time. Skips any act whose version count is unchanged, so a week where
# nothing was revised costs one pass over the index and no writes.
log "--- stage 6: point-in-time"
"$PYTHON" "$HERE/06_load_point_in_time.py" \
  --zip "$DATA_DIR/revised-all-versions-xml.zip" \
  --workers "$WORKERS" || { rc=$?; log "stage 6 exited $rc"; failed=1; }

# Re-hash the content map. Stage 5 runs with --replace, so a revised act's text
# is rewritten in place — and uk_provision_text_hash, which names each provision
# by the sha256 of its text, still holds the hash of the wording that was there
# last week.
#
# ⚠ Nothing used to do this, so the map drifted every single refresh, silently.
# Measured 2026-09-20: 768 rows stale after one crawl, and six more after a
# forty-act test an hour later. The cost only lands later, at embedding time — a
# vector stored under a hash that no longer names its text is a search hit that
# resolves to the wrong provision, or to none.
#
# Cheap when nothing moved: the statement only writes rows whose hash actually
# differs.
log "--- stage 7: re-hash the content map"
"$PYTHON" "$HERE/08_export_provision_texts.py" --populate-map \
  || { rc=$?; log "stage 7 exited $rc"; failed=1; }

# ⚠ Exit non-zero when a stage failed. The first version logged the failure and
# still returned 0, so the scheduled job went green over a refresh that imported
# nothing — the exact shape of silent staleness this whole thing exists to catch.
if [ "${failed:-0}" = "1" ] || [ "$rc_cur" = "2" ] || [ "$rc_enacted" = "2" ] || [ "$rc_all" = "2" ]; then
  log "=== UK refresh FAILED (downloads: current=$rc_cur enacted=$rc_enacted all=$rc_all; stages failed=${failed:-0})"
  exit 1
fi
log "=== UK refresh done (downloads: current=$rc_cur enacted=$rc_enacted all=$rc_all; 0=fetched, 1=unchanged, 2=failed)"
