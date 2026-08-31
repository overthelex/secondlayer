#!/usr/bin/env python3
"""OCR one legislation PDF into legocr/<id>.txt.

The portal's PDFs carry a broken text layer — fonts without a usable ToUnicode
map and runs stored in visual order — so pdftotext drops glyphs and PyMuPDF
silently maps them to the wrong codepoints. Rasterising and running tesseract
is the only path that yields correct, logically ordered Arabic.
"""
import os
import re
import subprocess
import sys
import tempfile
import unicodedata

import fitz

os.environ.setdefault("TESSDATA_PREFIX", os.path.expanduser("~/uae/tessdata"))
BIDI = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮"
                              "⁦⁧⁨⁩­"), None)

src = sys.argv[1]
law_id = os.path.basename(src)[:-4]
dst = os.path.expanduser("~/uae/legocr/%s.txt" % law_id)
if os.path.exists(dst) and os.path.getsize(dst) > 100:
    sys.exit(0)

try:
    doc = fitz.open(src)
except Exception:  # noqa: BLE001  - a corrupt file must not stall the batch
    open(dst, "w").write("")
    sys.exit(0)

parts = []
for i, page in enumerate(doc):
    if i >= 200:
        break
    tmp = None
    try:
        pix = page.get_pixmap(dpi=300)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tmp = tf.name
        pix.save(tmp)
        out = subprocess.run(["tesseract", tmp, "stdout", "-l", "ara", "--psm", "6"],
                             capture_output=True, timeout=180)
        parts.append(out.stdout.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        parts.append("")
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass

t = unicodedata.normalize("NFKC", "\n".join(parts)).translate(BIDI)
t = re.sub(r"[ \t]+", " ", t)
t = re.sub(r"\n\s*\n+", "\n\n", t).strip()
open(dst, "w", encoding="utf-8").write(t)
