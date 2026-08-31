#!/usr/bin/env python3
"""Join the index metadata with the extracted text into loadable JSONL.

Emits one line per judgment matching ae_court_decisions, so the same loader
shape as the Dubai and legislation corpora applies.
"""
import datetime
import hashlib
import json
import os
import re
import sys

INDEX, TXT_DIR, REPORT, OUT = sys.argv[1:5]

COURT = "المحكمة الاتحادية العليا"
LISTING = ("https://www.moj.gov.ae/ar/about-moj/union-supreme-court/"
           "e-services/latest-court-interpretations.aspx")
# "الطعن رقم 181 لسنة 2026 جزائي"
CASE_NO = re.compile(r"رقم\s*([\d٠-٩/\-]+)\s*(?:لسنة|لسنه)\s*(\d{4})")
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

quality = {}
for line in open(REPORT, encoding="utf-8"):
    r = json.loads(line)
    quality[r["id"]] = r


def parse_date(raw):
    if not raw:
        return None
    try:
        return datetime.datetime.strptime(raw.split(" ")[0], "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


written = missing = 0
with open(OUT, "w", encoding="utf-8") as out:
    for item in json.load(open(INDEX, encoding="utf-8"))["d"]["items"]:
        doc_id = str(item["id"])
        path = os.path.join(TXT_DIR, doc_id + ".txt")
        if not os.path.exists(path) or os.path.getsize(path) < 200:
            missing += 1
            continue
        text = open(path, encoding="utf-8").read()
        asset = (item.get("assets") or [{}])[0]
        title = (item.get("title") or "").strip()
        m = CASE_NO.search(title)
        case_number = ("%s/%s" % (m.group(1).translate(DIGITS), m.group(2))) if m else None
        q = quality.get(doc_id)
        # no quality row means the document was never a PDF - see fetch_docx.py
        source_kind = "docx" if q is None else ("pdf_text" if q["ok"] else "ocr")
        q = q or {}
        out.write(json.dumps({
            "doc_id": "moj_fsc_" + doc_id,
            "source": "moj_fsc",
            "jurisdiction": "AE-FED",
            "court_name": COURT,
            "court_level": "supreme",
            "case_number": case_number,
            "case_title": title,
            "decision_date": parse_date(item.get("date")),
            "language": "ar",
            "decision_type": item.get("category"),
            "full_text": text,
            "text_source": source_kind,
            "source_url": LISTING,
            "pdf_url": "https://www.moj.gov.ae/" + asset.get("downloadLink", ""),
            "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "metadata_json": {
                "moj_id": item["id"],
                "asset_id": asset.get("id"),
                "asset_size": asset.get("size"),
                "download_count": asset.get("downloadCount"),
                "chamber": item.get("category"),
                "year": item.get("year"),
                "group_title": item.get("groupTitle"),
                "pages": q.get("pages"),
                "dup_per_1000": q.get("dup_per_1000"),
                "extraction_ok": bool(q.get("ok")),
            },
        }, ensure_ascii=False) + "\n")
        written += 1

print("wrote %d rows, %d without text" % (written, missing))
