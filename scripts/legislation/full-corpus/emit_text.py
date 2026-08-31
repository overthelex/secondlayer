#!/usr/bin/env python3
"""Step 1b: one streaming pass over the shards, emitting CSV for npa.edition_text and npa.article.

CSV, not TSV: legal text carries tabs and newlines and both must survive intact — paragraph
structure is part of the document. Proper quoting plus COPY ... FORMAT csv handles embedded
newlines; stripping them would silently reflow every act.

Deduplication: 677 shard lines are duplicates of ~670 pairs (nodes overlapped across re-splits).
Those pairs are passed in and buffered in memory so the best row wins — lowest http_status, then
longest text, so a truncated retry can never overwrite a complete fetch. Everything else streams
straight through.
"""
import csv
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import article_number

DUPS_FILE = sys.argv[1]
OUT_TEXT = sys.argv[2]
OUT_ART = sys.argv[3]
CURRENT_FILE = sys.argv[4]

# Anchored at line start so a passing mention of «статті 5» in the body cannot masquerade as a
# heading. Captures «5», «5-1», «5(1)».
RE_ART = re.compile(r"(?m)^[ \t]*Стаття\s+(" + article_number.NUMBER + r")\s*[.．]?\s*(.*)$")
MIN_ARTICLES = 3          # below this it is a mention, not a structure
RE_ERRORISH = re.compile(r"(Помилка|не знайдено|Доступ обмежено|Технічні роботи)", re.I)


def articles_of(text):
    """Split into (art_no, ord, title, body). Body runs to the next heading."""
    ms = list(RE_ART.finditer(text))
    if len(ms) < MIN_ARTICLES:
        return []
    out, seen = [], set()
    for i, m in enumerate(ms):
        no = article_number.normalize(m.group(1))
        if no in seen:            # a repeated heading is a table of contents entry; keep the first
            continue
        seen.add(no)
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        out.append((no, len(out), (m.group(2) or "").strip()[:500], text[m.start():end].strip()))
    return out


def main():
    dups = set()
    with open(DUPS_FILE, encoding="utf-8") as f:
        for line in f:
            a, _, b = line.rstrip("\n").partition("\t")
            if a and b:
                dups.add((a, b))
    current = set()
    with open(CURRENT_FILE, encoding="utf-8") as f:
        for line in f:
            a, _, b = line.rstrip("\n").partition("\t")
            if a and b:
                current.add((a, b))
    print(f"[emit] {len(dups)} duplicated pairs, {len(current)} current editions", flush=True)

    held = {}       # only the duplicated pairs live here
    n_text = n_art = skipped = 0

    ft = open(OUT_TEXT, "w", encoding="utf-8", newline="")
    fa = open(OUT_ART, "w", encoding="utf-8", newline="")
    wt, wa = csv.writer(ft), csv.writer(fa)

    def emit(nreg, ed, text):
        nonlocal n_text, n_art
        iso = f"{ed[0:4]}-{ed[4:6]}-{ed[6:8]}"
        wt.writerow([nreg, iso, "t" if (nreg, ed) in current else "f", text])
        n_text += 1
        for no, ordi, title, body in articles_of(text):
            wa.writerow([nreg, iso, no, ordi, title, body])
            n_art += 1

    for path in sorted(glob.glob("/data/rada_npa/texts/*/shard_*.ndjson")):
        for line in open(path, encoding="utf-8"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("http_status") != 200:
                continue
            text = r.get("text") or ""
            # same verdicts the metadata load applied, so the two tables cannot disagree
            if not text or RE_ERRORISH.search(text[:1500]):
                skipped += 1
                continue
            key = (r["nreg"], r["ed_date"])
            if key in dups:
                prev = held.get(key)
                if prev is None or len(text) > len(prev):
                    held[key] = text
                continue
            emit(key[0], key[1], text)

    for (nreg, ed), text in held.items():
        emit(nreg, ed, text)

    ft.close()
    fa.close()
    print(f"[emit] texts={n_text} articles={n_art} skipped_unusable={skipped} "
          f"resolved_dups={len(held)}", flush=True)


if __name__ == "__main__":
    main()
