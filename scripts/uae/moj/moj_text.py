#!/usr/bin/env python3
"""Extract Arabic text from a Federal Supreme Court judgment PDF.

The portal serves two generations of PDF and each is broken in its own way:

* newer files store logical-order Arabic but emit every lam-alef ligature
  reversed, as alef+lam.  Orthography cannot tell that apart from the definite
  article, but geometry can: the decomposed alef carries **zero width** while a
  real article's alef does not.  That is the only reliable discriminator, so the
  swap is driven off the glyph boxes, not off a regex.
* older files store Unicode presentation forms plus kashidas that the font maps
  to stray non-Arabic codepoints.  NFKC folds the forms back and the strays are
  decorative, so they are dropped.
"""
import re
import sys
import unicodedata

import pymupdf

ALEFS = "اأإآ"  # bare, hamza above, hamza below, madda
LAM = "ل"
BIDI = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮"
                              "⁦⁧⁨⁩­ـ"), None)
ARABIC = re.compile(r"[؀-ۿﭐ-﻿]")


def _page_text(page):
    """Page text with reversed lam-alef ligatures put back in order."""
    out = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                chars = span["chars"]
                buf = []
                i = 0
                while i < len(chars):
                    c = chars[i]
                    nxt = chars[i + 1] if i + 1 < len(chars) else None
                    box = c["bbox"]
                    zero_width = (box[2] - box[0]) < 0.01
                    if (c["c"] in ALEFS and zero_width
                            and nxt is not None and nxt["c"] == LAM):
                        buf.append(LAM)
                        buf.append(c["c"])
                        i += 2
                        continue
                    buf.append(c["c"])
                    i += 1
                out.append("".join(buf))
            out.append("\n")
        out.append("\n")
    return "".join(out)


def extract(path):
    doc = pymupdf.open(path)
    text = "".join(_page_text(p) for p in doc)
    text = unicodedata.normalize("NFKC", text).translate(BIDI)
    # kashida and other decoration the older fonts map to stray codepoints
    text = "".join(c for c in text
                   if c.isascii() or ARABIC.match(c) or c.isspace()
                   or unicodedata.category(c) in ("Po", "Ps", "Pe", "Pd", "Sm"))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*\n+", "\n\n", text)
    return text.strip(), doc.page_count


if __name__ == "__main__":
    t, n = extract(sys.argv[1])
    sys.stdout.write(t)
