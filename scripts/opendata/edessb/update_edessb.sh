#!/bin/bash
# Weekly cron on cthulhu: refresh ЄДЕССБ yearly dumps that changed on data.gov.ua.
# The ministry republishes about monthly; a weekly check costs one CKAN call
# when nothing changed and catches an off-schedule republish within 7 days.
#   30 5 * * 1 /home/vovkes/SecondLayer/scripts/opendata/edessb/update_edessb.sh >> $HOME/logs/edessb-update.log 2>&1
set -euo pipefail
set -a; . <(grep -E "^POSTGRES_PASSWORD=" "$HOME/SecondLayer/deployment/.env.local"); set +a
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 POSTGRES_USER=secondlayer POSTGRES_DB=secondlayer_local
exec flock -n /tmp/edessb-update.lock nice -n 10 python3 "$(dirname "$0")/import_edessb.py" \
  --update --state-file "$HOME/edessb-import/state.json" --keep-dir "$HOME/edessb-import/zips"
