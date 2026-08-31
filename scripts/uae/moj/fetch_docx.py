#!/usr/bin/env python3
"""Handle the handful of judgments published as .docx rather than PDF.

Three of 4 469 records point at a Word file.  The index calls them
"application/pdf" all the same, so they are found by the link extension, not by
the declared mime type.  Text comes straight out of word/document.xml - no
converter needed, and no broken text layer to repair either.
"""
import json
import os
import re
import subprocess
import sys
import unicodedata
import zipfile

INDEX, TXT_DIR = sys.argv[1], sys.argv[2]
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
PAGE = ("https://www.moj.gov.ae/ar/about-moj/union-supreme-court/"
        "e-services/latest-court-interpretations.aspx")
TAG = re.compile(r"<[^>]+>")

os.makedirs(TXT_DIR, exist_ok=True)
done = 0
for item in json.load(open(INDEX, encoding="utf-8"))["d"]["items"]:
    asset = (item.get("assets") or [{}])[0]
    link = asset.get("downloadLink", "")
    if ".docx" not in link.lower():
        continue
    doc_id = str(item["id"])
    tmp = os.path.join(TXT_DIR, doc_id + ".docx")
    subprocess.run(["curl", "-sS", "--max-time", "120",
                    "https://www.moj.gov.ae/" + link, "-o", tmp,
                    "-H", "User-Agent: " + UA, "-H", "Referer: " + PAGE], check=True)
    try:
        with zipfile.ZipFile(tmp) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
    except (zipfile.BadZipFile, KeyError) as exc:
        print("SKIP %s: %s" % (doc_id, exc))
        os.unlink(tmp)
        continue
    xml = re.sub(r"</w:p>", "\n", xml)
    text = unicodedata.normalize("NFKC", TAG.sub("", xml))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*\n+", "\n\n", text).strip()
    with open(os.path.join(TXT_DIR, doc_id + ".txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    os.unlink(tmp)
    done += 1
    print("%s: %d chars" % (doc_id, len(text)))
print("docx handled: %d" % done)
