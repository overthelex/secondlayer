#!/bin/bash
# Download every judgment PDF listed in the index, resumably.
#
# Files already on disk that start with %PDF are left alone, so re-running is
# cheap and an interrupted run continues where it stopped.  A missing or blocked
# document answers with HTML rather than a 404, hence the magic-byte check.
set -uo pipefail

IDX="${1:-index.json}"
DIR="${2:-pdf}"
CONC="${CONC:-8}"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
PAGE='https://www.moj.gov.ae/ar/about-moj/union-supreme-court/e-services/latest-court-interpretations.aspx'

mkdir -p "$DIR"
python3 - "$IDX" <<'PY' > .dl_list
import json, sys
for i in json.load(open(sys.argv[1]))["d"]["items"]:
    a = (i.get("assets") or [None])[0]
    if a and a.get("downloadLink"):
        print("%s\t%s" % (i["id"], a["downloadLink"]))
PY

fetch_one() {
    local id="$1" link="$2" dst="$DIR/$1.pdf"
    [ -s "$dst" ] && [ "$(head -c4 "$dst")" = "%PDF" ] && return 0
    for attempt in 1 2 3; do
        curl -sS --max-time 120 "https://www.moj.gov.ae/$link" -o "$dst.tmp" \
            -H "User-Agent: $UA" -H "Referer: $PAGE" && \
        [ -s "$dst.tmp" ] && [ "$(head -c4 "$dst.tmp")" = "%PDF" ] && {
            mv "$dst.tmp" "$dst"; return 0; }
        sleep $((attempt * 3))
    done
    rm -f "$dst.tmp"
    echo "FAIL $id $link" >&2
    return 1
}
export -f fetch_one
export DIR UA PAGE

xargs -P "$CONC" -n 2 bash -c 'fetch_one "$0" "$1"' < <(tr '\t' '\n' < .dl_list)

total=$(wc -l < .dl_list)
have=$(find "$DIR" -name '*.pdf' -size +1k | wc -l)
echo "downloaded $have / $total"
[ "$have" -eq "$total" ]
