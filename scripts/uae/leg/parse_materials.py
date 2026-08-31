#!/usr/bin/env python3
"""Turn harvested article pages into one JSONL row per article.

Chapter headings sit between the article blocks rather than inside them, so the
current heading is carried forward as the blocks are walked; that is the only
way to attribute an article to its chapter here.

An article whose title carries the "previous texts" tooltip has been amended at
some point, which gives a cheap cross-check against the amendment tables built
from the modifications endpoint.
"""
import glob
import gzip
import hashlib
import json
import os
import re
import sys

from bs4 import BeautifulSoup

ARTICLE_NO = re.compile(r"المادة\s*\(?\s*([\d/\-]+)")
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def clean(node):
    text = node.get_text("\n") if node is not None else ""
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def parse_law(rec, out):
    law_id = rec["law_id"]
    seq = 0
    chapter = None
    written = 0
    for page in rec.get("pages", []):
        soup = BeautifulSoup(page.get("html_data", ""), "lxml")
        root = soup.body or soup
        for node in root.descendants:
            if getattr(node, "name", None) != "div":
                continue
            classes = node.get("class") or []
            if "content_" not in classes:
                continue
            # the nearest preceding gold heading is this article's chapter
            prev = node.find_previous(
                lambda t: t.name == "h4" and "gold_color" in (t.get("class") or []))
            if prev is not None:
                chapter = re.sub(r"\s+", " ", prev.get_text(" ")).strip()
            title = node.select_one(".c_title h4")
            label = None
            if title is not None:
                # the "previous texts" tooltip lives inside the heading and
                # would otherwise be read as part of the article's title
                head = BeautifulSoup(str(title), "lxml")
                for tip in head.select("[data-fancybox-material], .tooltip_holder"):
                    tip.decompose()
                label = re.sub(r"\s+", " ", head.get_text(" ")).strip() or None
            body = node.select_one(".text_area")
            text = clean(body)
            if not text:
                continue
            material_id = (node.get("id") or "").replace("item", "") or None
            art = ARTICLE_NO.search((label or "").translate(DIGITS))
            out.write(json.dumps({
                "article_id": "uaeleg:%d:%s" % (law_id, material_id or seq),
                "law_id": law_id,
                "material_id": int(material_id) if material_id and material_id.isdigit() else None,
                "seq": seq,
                "chapter": chapter,
                "article_label": label,
                "article_no": art.group(1) if art else None,
                "text": text,
                "has_previous": bool(node.select_one("[data-fancybox-material]")),
                "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }, ensure_ascii=False) + "\n")
            seq += 1
            written += 1
    return written


def main():
    src, out_path = sys.argv[1], sys.argv[2]
    laws = amended = total = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for path in sorted(glob.glob(os.path.join(src, "*.json.gz")),
                           key=lambda p: int(os.path.basename(p).split(".")[0])):
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                rec = json.load(fh)
            n = parse_law(rec, out)
            if n:
                laws += 1
                total += n
    with open(out_path, encoding="utf-8") as fh:
        amended = sum(1 for line in fh if json.loads(line)["has_previous"])
    print("articles %d across %d acts, %d carry previous versions" % (total, laws, amended))


if __name__ == "__main__":
    main()
