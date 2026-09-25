"""Fetch the 2026 Методика from the register, because our stores do not have it.

`z1043-26` was adopted on 11 June 2026 and registered on 14 July 2026. The npa
tables hold no AMCU act later than 9 August 2025 and the EDRNPA card registry
none later than 11 March 2026, so the successor falls in the gap and has to come
from zakon.rada.gov.ua directly, like everything else in this study.

The page carries the whole act inside one `id="article"` div, with the table of
contents above it and the portal's footer below. Both are cut off by the act's
own landmarks rather than by offsets, which would rot the moment the page
changes.

Usage:
    python3 harvest_successor.py --out /data/amcu/z1043-26.txt
"""
from __future__ import annotations

import argparse
import html
import pathlib
import re
import subprocess

URL = "https://zakon.rada.gov.ua/laws/show/{nreg}"
# Where the act's own text starts, and where the portal's chrome takes over.
START = re.compile(r"^АНТИМОНОПОЛЬНИЙ\s+КОМІТЕТ\s+УКРАЇНИ", re.M)
END = re.compile(r"^(Публікації документа|© Офіційний вебпортал|Будемо вдячні)", re.M)


def fetch(nreg: str) -> str:
    raw = subprocess.run(
        ["curl", "-s", "--compressed", "--max-time", "120", "-A", "Mozilla/5.0",
         URL.format(nreg=nreg)],
        capture_output=True, check=True).stdout.decode("utf-8", "replace")
    start = raw.find('id="article"')
    if start < 0:
        raise SystemExit("the article div is not on the page")
    chunk = raw[start:]
    chunk = re.sub(r"<script.*?</script>|<style.*?</style>", "", chunk, flags=re.S)
    # Rada wraps every cross-reference in an anchor on its own line, which
    # breaks "пункту 11 частини першої статті 7" into three lines. Inline tags
    # become nothing, block tags become a newline.
    chunk = re.sub(r"</?(a|b|i|em|strong|span|sup|sub)\b[^>]*>", "", chunk, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", chunk))
    text = text.replace(" ", " ").replace("﻿", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text).strip()

    m = START.search(text)
    if m:
        text = text[m.start():]
    m = END.search(text)
    if m:
        text = text[:m.start()]
    return text.strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nreg", default="z1043-26")
    ap.add_argument("--out", default="/data/amcu/z1043-26.txt")
    args = ap.parse_args()

    text = fetch(args.nreg)
    pathlib.Path(args.out).write_text(text, encoding="utf-8")
    items = re.findall(r"^(\d{1,2}(?:\.\d{1,2}){1,3})\.\s+\S", text, re.M)
    sections = re.findall(r"^([IVX]+|\d{1,2})\.\s+([А-ЯІЇЄҐ][^.\n]{6,120})$", text, re.M)
    print(f"{args.nreg}: {len(text)} символів -> {args.out}")
    print(f"  нумерованих пунктів: {len(items)}")
    print(f"  заголовків розділів: {len(sections)}")
    for n, title in sections[:14]:
        print(f"    {n}. {title[:70]}")


if __name__ == "__main__":
    main()
