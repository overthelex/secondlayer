#!/usr/bin/env python3
"""Turn harvested amendment pages into three JSONL streams.

  laws.jsonl       one row per act: gazette reference, dates, status
  amendments.jsonl one row per amending act, with its date and PDF
  changes.jsonl    one row per article touched, holding the new text and the
                   text it replaced - the pair that answers "how did it change"

Dates arrive as Arabic month names ("08 مايو 2016") and Arabic-Indic digits
appear in article labels, so both are normalised here rather than downstream.
"""
import datetime
import glob
import gzip
import hashlib
import json
import os
import re
import sys

from bs4 import BeautifulSoup

MONTHS = {
    "يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "ابريل": 4, "مايو": 5,
    "يونيو": 6, "يوليو": 7, "أغسطس": 8, "اغسطس": 8, "سبتمبر": 9,
    "أكتوبر": 10, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12,
}
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
ARTICLE_NO = re.compile(r"المادة\s*\(?\s*([\d/\-]+)")
MOD_ID = re.compile(r"/modifications/(\d+)/download")
STATUS = {"ساري": "in_force", "ملغي": "repealed", "ملغى": "repealed",
          "معدل": "amended", "موقوف": "suspended"}


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).translate(DIGITS).strip()


def parse_date(raw):
    raw = norm(raw)
    m = re.search(r"(\d{1,2})\s+(\S+)\s+(\d{4})", raw)
    if not m or m.group(2) not in MONTHS:
        return None
    try:
        return datetime.date(int(m.group(3)), MONTHS[m.group(2)],
                             int(m.group(1))).isoformat()
    except ValueError:
        return None


def sha(text):
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def block_text(node, drop=()):
    """Visible text of a node, minus whole subtrees we account for separately."""
    clone = BeautifulSoup(str(node), "lxml")
    for sel in drop:
        for tag in clone.select(sel):
            tag.decompose()
    return re.sub(r"\n{3,}", "\n\n",
                  re.sub(r"[ \t]+", " ", clone.get_text("\n"))).strip()


def parse_law(rec, laws, amendments, changes):
    law_id = rec["law_id"]
    meta = rec.get("meta") or {}
    status_ar = norm(meta.get("حالة التشريع"))
    laws.write(json.dumps({
        "law_id": law_id,
        "issue_date": parse_date(meta.get("تاريخ إصدار التشريع")),
        "effective_date": parse_date(meta.get("تاريخ نفاذ التشريع")),
        "gazette_date": parse_date(meta.get("تاريخ الجريدة الرسمية")),
        "gazette_number": norm(meta.get("عدد الجريدة الرسمية")) or None,
        "status_ar": status_ar or None,
        "status": STATUS.get(status_ar),
        "last_update": parse_date(rec.get("last_update")),
        "amendments_declared": norm(meta.get("تعديلات التشريع")) or None,
        "no_modifications": bool(rec.get("no_modifications")),
    }, ensure_ascii=False) + "\n")

    n_amend = n_change = 0
    for year, html in sorted((rec.get("lists") or {}).items()):
        soup = BeautifulSoup(html, "lxml")
        for item in soup.select(".law_modification_item"):
            head = item.select_one(".law_modification_head")
            date_raw = norm(head.select_one(".date_").get_text(" ")) if head and head.select_one(".date_") else ""
            title = norm(head.select_one(".name_").get_text(" ")) if head and head.select_one(".name_") else None
            link = item.select_one('a[href*="/modifications/"]')
            href = link.get("href", "") if link else ""
            mod = MOD_ID.search(href)
            mod_id = int(mod.group(1)) if mod else None
            amendment_id = "uaeleg:%d:%s" % (law_id, mod_id if mod_id else "%s-%d" % (year, n_amend))

            article_rows = []
            for seq, area in enumerate(item.select(".law_modification_body .item_area")):
                text_area = area.select_one(".text_area")
                if text_area is None:
                    continue
                heading = text_area.select_one("h4")
                label = norm(heading.get_text(" ")) if heading else None
                new_text = block_text(text_area, drop=("h4",))
                previous = [
                    {"label": norm(prev.select_one(".name_").get_text(" ")) if prev.select_one(".name_") else None,
                     "text": block_text(prev.select_one(".text_")) if prev.select_one(".text_") else None}
                    for prev in area.select(".inner_modification_wrapper .i_m_item")
                ]
                art = ARTICLE_NO.search(label or "")
                prev_text = previous[0]["text"] if previous else None
                article_rows.append({
                    "change_id": "%s:%d" % (amendment_id, seq),
                    "amendment_id": amendment_id,
                    "law_id": law_id,
                    "seq": seq,
                    "article_label": label,
                    "article_no": art.group(1) if art else None,
                    "new_text": new_text or None,
                    "previous_text": prev_text,
                    "new_sha256": sha(new_text) if new_text else None,
                    "previous_sha256": sha(prev_text) if prev_text else None,
                    "previous_versions": len(previous),
                    "text_changed": bool(new_text and prev_text and new_text != prev_text),
                })

            amendments.write(json.dumps({
                "amendment_id": amendment_id,
                "law_id": law_id,
                "modification_id": mod_id,
                "amend_date": parse_date(date_raw),
                "amend_year": int(year),
                "amend_date_raw": date_raw or None,
                "amending_title": title,
                "amending_pdf_url": href or None,
                "articles_changed": len(article_rows),
            }, ensure_ascii=False) + "\n")
            n_amend += 1
            for row in article_rows:
                changes.write(json.dumps(row, ensure_ascii=False) + "\n")
                n_change += 1
    return n_amend, n_change


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    totals = [0, 0, 0]
    with open(os.path.join(out_dir, "laws.jsonl"), "w", encoding="utf-8") as laws, \
         open(os.path.join(out_dir, "amendments.jsonl"), "w", encoding="utf-8") as amendments, \
         open(os.path.join(out_dir, "changes.jsonl"), "w", encoding="utf-8") as changes:
        for path in sorted(glob.glob(os.path.join(src, "*.json.gz")),
                           key=lambda p: int(os.path.basename(p).split(".")[0])):
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                rec = json.load(fh)
            if rec.get("missing"):
                continue
            a, c = parse_law(rec, laws, amendments, changes)
            totals[0] += 1
            totals[1] += a
            totals[2] += c
    print("laws %d, amendments %d, article changes %d" % tuple(totals))


if __name__ == "__main__":
    main()
