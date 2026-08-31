#!/usr/bin/env python3
"""UAE federal legislation PDFs -> JSONL for ae_legislation.

Text comes from pdftotext -layout. Many of the portal's PDFs ship fonts with a
broken or absent ToUnicode map, so every record carries an explicit quality
signal instead of pretending the extraction is uniform:
  glyph_loss  - share of U+FFFD (pdftotext could not map the glyph)
  odd_script  - share of characters outside Arabic/Latin/digits/punctuation
                (PyMuPDF-style silent mis-mapping shows up here)
"""
import glob, gzip, hashlib, json, os, re, sys, unicodedata

BIDI = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮"
                              "⁦⁧⁨⁩­"), None)
ARABIC = re.compile(r"[؀-ۿݐ-ݿ]")
SANE = re.compile(r"[؀-ۿݐ-ݿ A-Za-z0-9\s\.,;:()\[\]/\\\-–—«»\"'!?%&+*=…،؛؟ـ]")

TYPES = [
    ("مرسوم بقانون اتحادي", "federal_decree_law"),
    ("قانون اتحادي", "federal_law"),
    ("مرسوم اتحادي", "federal_decree"),
    ("قرار مجلس الوزراء", "cabinet_resolution"),
    ("قرار وزاري", "ministerial_resolution"),
    ("قرار", "resolution"),
    ("نظام", "regulation"),
]


def norm(t):
    t = unicodedata.normalize("NFKC", t).translate(BIDI)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n\n", t)
    return t.strip()


def title_of(t):
    head = " ".join(t.split("\n")[:6])
    head = re.sub(r"\s+", " ", head).strip()
    return head[:400] or None


def meta_of(title):
    if not title:
        return None, None, None
    law_type = next((v for k, v in TYPES if k in title), None)
    num = re.search(r"رقم\s*\(?\s*([\d٠-٩]+)\s*\)?", title)
    year = re.search(r"لسنة\s*\(?\s*(\d{4})", title)
    return law_type, (num.group(1) if num else None), (int(year.group(1)) if year else None)


def main():
    txt_dir, out = sys.argv[1], sys.argv[2]
    written = empty = 0
    with open(out, "w", encoding="utf-8") as fh:
        for f in sorted(glob.glob(os.path.join(txt_dir, "*.txt"))):
            law_id = int(os.path.basename(f)[:-4])
            raw = open(f, encoding="utf-8", errors="replace").read()
            text = norm(raw)
            if len(text) < 200:
                empty += 1
                continue
            lost = text.count("�")
            odd = len(SANE.sub("", text))
            title = title_of(text)
            law_type, number, year = meta_of(title)
            rec = {
                "doc_id": "uaeleg:%d" % law_id,
                "jurisdiction": "UAE",
                "law_id": law_id,
                "title": title,
                "law_type": law_type,
                "law_number": number,
                "law_year": year,
                "language": "ar",
                "full_text": text,
                "text_source": "ocr",
                "source_url": "https://uaelegislation.gov.ae/ar/legislations/%d" % law_id,
                "pdf_url": "https://uaelegislation.gov.ae/ar/legislations/%d/download" % law_id,
                "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "metadata_json": {
                    "chars": len(text),
                    "arabic_chars": len(ARABIC.findall(text)),
                    "glyph_loss": round(lost / max(1, len(text)), 5),
                    "odd_script": round(odd / max(1, len(text)), 5),
                    "extraction_ok": lost / max(1, len(text)) < 0.001,
                },
            }
            line = json.dumps(rec, ensure_ascii=False).replace("\x01", " ").replace("\x02", " ")
            fh.write(line + "\n")
            written += 1
    sys.stderr.write("written=%d skipped_empty=%d\n" % (written, empty))


if __name__ == "__main__":
    main()
