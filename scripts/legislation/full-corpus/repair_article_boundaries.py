#!/usr/bin/env python3
"""Trim structural headings off the end of stored npa.article bodies (LEXAI-2123).

rebuild_articles.py used to end an article only at the next «Стаття N.», so the
Розділ / Глава / § headings in between, and the whole final-provisions section after
the last article, were stored as part of the preceding article. The rebuild now
trims them; this script brings the existing rows to the same state without a full
rebuild.

Stream filter, same shape as rebuild_articles.py: CSV (nreg, ed_date, art_no, body)
in on stdin, CSV (nreg, ed_date, art_no, title, body) of only the rows whose body
changes out on stdout; the title is recomputed the way rebuild_articles.py does it. Idempotent:
trim_article is a no-op on a trimmed body, so a second run emits nothing.

Run it one act at a time so no single statement detoasts the 4 GB table:

  ./repair_article_boundaries.sh            # all acts, see the wrapper
  python3 repair_article_boundaries.py --dry-run < rows.csv   # counts only
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import structural_heading
from rebuild_articles import article_title

csv.field_size_limit(64 * 1024 * 1024)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="count changes, write nothing")
    args = ap.parse_args()

    r = csv.reader(sys.stdin)
    w = csv.writer(sys.stdout)
    seen = changed = cut_chars = 0
    for row in r:
        if len(row) < 4:
            continue
        nreg, ed, art_no, body = row[0], row[1], row[2], row[3]
        seen += 1
        new = structural_heading.trim_article(body)
        if new == body:
            continue
        changed += 1
        cut_chars += len(body) - len(new)
        if not args.dry_run:
            w.writerow([nreg, ed, art_no, article_title(new), new])
    print(f"[repair] rows={seen} changed={changed} chars_cut={cut_chars}",
          file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
