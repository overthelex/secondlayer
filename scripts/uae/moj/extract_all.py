#!/usr/bin/env python3
"""Extract text from every downloaded judgment and flag the ones needing OCR.

Two things can be wrong with a document, and they need different answers:

* the *encoding* of the text layer is broken (reversed lam-alef ligatures,
  presentation forms, stray kashida codepoints) - moj_text repairs that.
* the text layer itself is somebody else's bad OCR, with letters dropped and
  kashidas turned into doubled letters ("قاتاال" for "قاتل").  Nothing can
  repair that from the inside, so those documents are re-OCRed from the image.

The discriminator is the rate of doubled Arabic letters, which separates the two
populations cleanly: good documents sit at 5-11 per 1000 Arabic characters, bad
ones at 20-170.  Genuine gemination is written with shadda, not by repeating the
letter, so a high rate really does mean a broken source.
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from moj_text import extract  # noqa: E402

DUP = re.compile(r"([ء-ي])\1")
AR = re.compile(r"[ء-ي]")
JUNK_THRESHOLD = 15.0  # doubled letters per 1000 Arabic chars
MIN_CHARS = 200

pdf_dir, txt_dir, report = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(txt_dir, exist_ok=True)

rows = []
for path in sorted(glob.glob(os.path.join(pdf_dir, "*.pdf"))):
    doc_id = os.path.basename(path)[:-4]
    try:
        text, pages = extract(path)
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the run
        rows.append({"id": doc_id, "ok": False, "reason": "extract_error: %s" % exc})
        continue
    ar = len(AR.findall(text))
    dup = len(DUP.findall(text))
    ratio = dup / ar * 1000 if ar else 999.0
    ok = ar >= MIN_CHARS and ratio <= JUNK_THRESHOLD
    if ok:
        with open(os.path.join(txt_dir, doc_id + ".txt"), "w", encoding="utf-8") as fh:
            fh.write(text)
    rows.append({
        "id": doc_id, "ok": ok, "pages": pages, "chars": len(text),
        "arabic": ar, "dup_per_1000": round(ratio, 1),
        "reason": None if ok else ("too_short" if ar < MIN_CHARS else "junk_text_layer"),
    })

with open(report, "w", encoding="utf-8") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")

bad = [r for r in rows if not r["ok"]]
print("extracted %d, needs OCR %d (%.1f%%)" % (len(rows), len(bad),
                                               len(bad) / max(len(rows), 1) * 100))
for reason in sorted({r["reason"] for r in bad}):
    print("  %s: %d" % (reason, sum(1 for r in bad if r["reason"] == reason)))
