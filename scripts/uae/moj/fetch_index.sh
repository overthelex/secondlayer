#!/bin/bash
# Pull the complete Federal Supreme Court judgment index from moj.gov.ae.
#
# The listing page is an ASMX-backed widget; pageSize -1 returns every record in
# one response (~7 MB, ~60 s), so there is no pagination to walk.  The site is
# not geo-blocked, but it does reject requests without a browser header set.
set -euo pipefail

OUT="${1:-index.json}"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
PAGE='https://www.moj.gov.ae/ar/about-moj/union-supreme-court/e-services/latest-court-interpretations.aspx'

curl -sS --max-time 300 \
  'https://www.moj.gov.ae/services/AjaxHandler.asmx/LoadCategorizeAssetsList' \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H "User-Agent: $UA" \
  -H "Referer: $PAGE" \
  -H 'X-Requested-With: XMLHttpRequest' \
  --data-binary '{"pageIndex":1,"pageSize":-1,"languageId":2,"languageCode":"ar-AE","isArchived":false,"thumbnailSizeFactor":"12c1x1680wTransparent","excludeItems":[],"keyword":"","openDataTypeID":450,"categoryId":null,"year":null,"apiLink":null}' \
  -o "$OUT.tmp"

python3 - "$OUT.tmp" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))["d"]
n = len(d["items"])
assert n == d["records"] and n > 4000, "short index: %d items vs %d records" % (n, d["records"])
print("index ok: %d records, modified %s" % (n, d["dateModified"]))
PY

mv "$OUT.tmp" "$OUT"
