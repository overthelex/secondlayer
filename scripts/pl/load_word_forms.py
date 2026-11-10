#!/usr/bin/env python3
"""PoliMorfologik 2.1 into pl_word_forms (migration 257).

  python3 scripts/pl/load_word_forms.py ~/lawrider/dict/polimorfologik-2.1.txt

Input lines are lemma;form;tag+tag+... Everything is lower-cased, because the search
indexes are. The table is replaced in one transaction, so a failed load changes nothing.
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

WORD = re.compile(r"^[^\W\d_]+$")
# Variants of one paradigm. Everything else is grouped by its own head tag.
GROUP = {"depr": "subst", "adja": "adj", "adjp": "adj", "adjc": "adj",
         "pant": "verb", "pcon": "verb"}


def pos_of(tag):
    head = tag.split(":", 1)[0]
    pos = GROUP.get(head, head)
    return pos + ":neg" if ":neg" in tag else pos


def rows(path):
    seen = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split(";")
            if len(parts) != 3:
                continue
            lemma, form = parts[0].lower(), parts[1].lower()
            if WORD.match(form) and WORD.match(lemma):
                for tag in parts[2].split("+"):
                    seen.add((form, lemma, pos_of(tag)))
    return seen


def main():
    data = rows(sys.argv[1])
    p = subprocess.Popen(plprod._argv(), stdin=subprocess.PIPE, text=True)
    p.stdin.write("\\set ON_ERROR_STOP on\nBEGIN;\nTRUNCATE pl_word_forms;\n"
                  "COPY pl_word_forms (form, lemma, pos) FROM STDIN WITH (FORMAT text);\n")
    for r in data:
        p.stdin.write("\t".join(r) + "\n")
    p.stdin.write("\\.\nCOMMIT;\nANALYZE pl_word_forms;\n")
    p.stdin.close()
    rc = p.wait()
    print(f"{len(data)} rows, psql exit {rc}", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
