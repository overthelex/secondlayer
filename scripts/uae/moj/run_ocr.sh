#!/bin/bash
# OCR every judgment the extractor flagged, into the same text directory.
#
# Five workers, niced, on an eight-core shared box: enough to finish in an hour
# without the app noticing.  Each worker is single-threaded by ocr_one.py.
set -uo pipefail

REPORT="${1:-report.jsonl}"
PDF_DIR="${2:-pdf}"
TXT_DIR="${3:-txt}"
WORKERS="${WORKERS:-5}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$TXT_DIR"
python3 - "$REPORT" <<'PY' > .ocr_list
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    if not r["ok"]:
        print(r["id"])
PY

echo "to OCR: $(wc -l < .ocr_list)"
xargs -P "$WORKERS" -I{} nice -n 19 ionice -c3 \
    python3 "$HERE/ocr_one.py" "$PDF_DIR/{}.pdf" "$TXT_DIR" < .ocr_list
echo "text files now: $(find "$TXT_DIR" -name '*.txt' -size +1k | wc -l)"
