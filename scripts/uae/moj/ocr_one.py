#!/usr/bin/env python3
"""Re-OCR one judgment whose embedded text layer was judged unusable.

Same recipe as the legislation corpus: rasterise with PyMuPDF at 200 dpi and run
tesseract's Arabic model one page at a time.  OMP_THREAD_LIMIT=1 is essential -
tesseract is OpenMP-threaded by default and several workers each spawning a full
thread pool collapses throughput on a shared box.
"""
import os
import re
import subprocess
import sys
import tempfile
import unicodedata

import pymupdf

os.environ.setdefault("TESSDATA_PREFIX", os.path.expanduser("~/uae/tessdata"))
os.environ["OMP_THREAD_LIMIT"] = "1"
BIDI = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮⁦⁧⁨⁩­ـ"), None)

src, dst_dir = sys.argv[1], sys.argv[2]
doc_id = os.path.basename(src)[:-4]
dst = os.path.join(dst_dir, doc_id + ".txt")
if os.path.exists(dst) and os.path.getsize(dst) > 200:
    sys.exit(0)

try:
    doc = pymupdf.open(src)
except Exception:  # noqa: BLE001 - a corrupt file must not stall the batch
    sys.exit(0)

parts = []
for page in doc:
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            tmp = fh.name
        page.get_pixmap(dpi=200).save(tmp)
        out = subprocess.run(
            ["tesseract", tmp, "stdout", "-l", "ara", "--psm", "6", "--oem", "1"],
            capture_output=True, timeout=300)
        parts.append(out.stdout.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        parts.append("")
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass

text = unicodedata.normalize("NFKC", "\n".join(parts)).translate(BIDI)
text = re.sub(r"[ \t]+", " ", text)
text = re.sub(r"\n[ \t]*\n+", "\n\n", text).strip()
with open(dst, "w", encoding="utf-8") as fh:
    fh.write(text)
