#!/usr/bin/env python3
"""Rebuild npa.article from npa.edition_text with the corrected heading detector.

The first detector required «Стаття N» at the start of a line. That assumption does not survive
the HTML-to-text conversion: a 69 476-character law comes out with 22 newlines, and headings sit
mid-line after a full stop. A law with 39 articles was being read as having none.

Corrected rule: capital «Стаття», a number that may carry a dash suffix with stray spaces, then
a period. References read «статті 5» / «ст. 5» — lower case, and no period straight after the
number — so they do not match.

Validated by monotonicity rather than by eye: in a real act the article numbers climb, in an
amending law quoting articles out of order they do not. 92.8% of 347 sampled documents with 3+
headings climb; the rest are rejected here rather than polluting the article layer.

Reads from the database, not the shards: the DB set is already deduplicated and carries the
re-harvested slash acts. It streams CSV in on stdin and CSV out on stdout, so it needs no
driver and no credentials — the surrounding psql \\copy owns the connection:

  docker exec ... psql -c "\\copy (select nreg, ed_date, body from npa.edition_text) to stdout
                           with (format csv)" | python3 rebuild_articles.py > article.csv
"""
import csv
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import article_number

# A single act runs to 4M characters; the default 128 KB field cap would truncate mid-document
# and silently drop every heading past it.
csv.field_size_limit(64 * 1024 * 1024)

# The trailing dot is required here on purpose and stays: it is what separates a
# heading from a mention. Only the number sub-pattern is shared.
RE_HEAD = re.compile(r"Стаття\s+(" + article_number.NUMBER + r")\s*\.")
MIN_ARTICLES = 3
MONO_MIN = 0.9          # share of steps that must not go backwards

_art_num = article_number.leading_int


def parse(text):
    ms = list(RE_HEAD.finditer(text))
    if len(ms) < MIN_ARTICLES:
        return None
    nums, seen_seq = [], []
    for m in ms:
        n = _art_num(m.group(1))
        nums.append(n)
        if not seen_seq or n != seen_seq[-1]:
            seen_seq.append(n)
    if len(seen_seq) > 1:
        inc = sum(1 for a, b in zip(seen_seq, seen_seq[1:]) if b >= a)
        if inc / (len(seen_seq) - 1) < MONO_MIN:
            return None          # numbers jump around: an amending act, not a structured one
    out, taken = [], set()
    for i, m in enumerate(ms):
        no = article_number.normalize(m.group(1))
        if no in taken:          # a repeat is a contents entry; the first occurrence wins
            continue
        taken.add(no)
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        body = text[m.start():end].strip()
        title = body[:300].split(".", 1)[-1].strip()[:300] if "." in body[:300] else ""
        out.append((no, len(out), title, body))
    return out


def main():
    r = csv.reader(sys.stdin)
    w = csv.writer(sys.stdout)
    n = docs = arts = rejected = 0
    for row in r:
        if len(row) < 3:
            continue
        nreg, ed, body = row[0], row[1], row[2]
        n += 1
        got = parse(body)
        if got is None:
            if len(RE_HEAD.findall(body)) >= MIN_ARTICLES:
                rejected += 1
            continue
        docs += 1
        for no, ordi, title, atext in got:
            w.writerow([nreg, ed, no, ordi, title, atext])
            arts += 1
        if docs % 2000 == 0:
            print(f"[rebuild] scanned={n} structured={docs} articles={arts} "
                  f"rejected_nonmonotonic={rejected}", file=sys.stderr, flush=True)
    print(f"[rebuild] done: scanned={n} structured={docs} articles={arts} "
          f"rejected_nonmonotonic={rejected}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
