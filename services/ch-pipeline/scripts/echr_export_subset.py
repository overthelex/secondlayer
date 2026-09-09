#!/usr/bin/env python3
"""Cut the Swiss slice out of the HUDOC harvest (LEXAI-2040, gap plan phase 3).

The harvest lives on cthulhu, /mnt/bulk_storage/home-offload/hudoc-storage/all:
meta/metadata-ALL.ndjson (209,773 HUDOC items, one JSON object per line
with HUDOC's own field names) and txt/<itemid>.txt (179,304 texts, the
HTML body converted). This script needs nothing but the standard library,
so it runs where the harvest is, and writes one gzipped ndjson with the
rows echr_import_stage loads on lawrider:

    {"meta": {...the HUDOC record...}, "full_text": "..." | null,
     "text_bytes": 12345, "why": "respondent" | "importance"}

Selection (measured 2026-09-09 on the harvest):
  * respondent lists CHE: 3,133 rows over 993 applications -- judgments,
    decisions, communicated cases, execution resolutions, Commission
    reports, Information Note summaries, German/Italian/... translations;
    2,948 have a text file -- 239 of them empty and 6 under 500 bytes (a
    stub the conversion left) -- and 185 have none (HUDOC answered 500
    during the harvest): 424 Swiss rows are metadata-only.
  * Chamber and Grand Chamber judgments of importance 1-3 in English and
    French (HEJUD / HFJUD): 16,436 rows over 7,870 applications, the
    leading cases a Swiss court cites regardless of respondent.
Texts under --min-text-bytes are exported as null so the row exists (the
metadata is the citation) and the text stays honestly absent.

    python3 echr_export_subset.py --harvest /mnt/bulk_storage/home-offload/hudoc-storage/all \
        --out /tmp/echr_ch_subset.ndjson.gz
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import os
import pathlib
import sys

JUDGMENT_TYPES = ("HEJUD", "HFJUD")     # the Court's own English / French judgments
ORIGINAL_LANGS = ("ENG", "FRE")
LEADING_IMPORTANCE = ("1", "2", "3")
MIN_TEXT_BYTES = 500


def respondents(meta: dict) -> list[str]:
    return [r for r in (meta.get("respondent") or "").split(";") if r]


def is_chamber_judgment(meta: dict) -> bool:
    """A Chamber or Grand Chamber judgment in one of the Court's languages;
    a translation (HJUDGER, HJUDITA, ...) is not a leading case on its own."""
    col = meta.get("documentcollectionid2") or ""
    return (meta.get("doctype") in JUDGMENT_TYPES and "CHAMBER" in col
            and meta.get("languageisocode") in ORIGINAL_LANGS)


def why(meta: dict, respondent: str) -> str | None:
    """Why the row is in the slice, or None."""
    if respondent in respondents(meta):
        return "respondent"
    if meta.get("importance") in LEADING_IMPORTANCE and is_chamber_judgment(meta):
        return "importance"
    return None


def export(harvest: pathlib.Path, out: pathlib.Path, respondent: str = "CHE",
           min_text_bytes: int = MIN_TEXT_BYTES) -> dict:
    meta_path = harvest / "meta" / "metadata-ALL.ndjson"
    txt_dir = harvest / "txt"
    counts: collections.Counter = collections.Counter()
    seen: set[str] = set()
    with open(meta_path, encoding="utf-8") as src, gzip.open(out, "wt", encoding="utf-8") as dst:
        for line in src:
            line = line.strip()
            if not line:
                continue
            try:
                meta = json.loads(line)
            except json.JSONDecodeError:
                counts["bad_json"] += 1
                continue
            item = meta.get("itemid")
            if not item or item in seen:
                counts["dup_or_no_itemid"] += 1
                continue
            reason = why(meta, respondent)
            if not reason:
                continue
            seen.add(item)
            text = None
            path = txt_dir / f"{item}.txt"
            size = path.stat().st_size if path.is_file() else 0
            if size and size >= min_text_bytes:
                text = path.read_text(encoding="utf-8", errors="replace")
                counts["with_text"] += 1
            elif size:
                counts["text_too_short"] += 1
            else:
                counts["no_text"] += 1
            counts[reason] += 1
            dst.write(json.dumps({"meta": meta, "full_text": text, "text_bytes": size, "why": reason},
                                 ensure_ascii=False) + "\n")
    counts["rows"] = len(seen)
    return dict(counts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--harvest", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--respondent", default="CHE")
    ap.add_argument("--min-text-bytes", type=int, default=MIN_TEXT_BYTES)
    args = ap.parse_args(argv)
    counts = export(args.harvest, args.out, args.respondent, args.min_text_bytes)
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
