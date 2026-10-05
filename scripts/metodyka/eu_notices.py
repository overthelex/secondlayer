"""The two Commission notices on market definition, as numbered paragraphs (PAPER-246).

The 1997 notice (OJ C 372, 9.12.1997, p. 5; CELEX 31997Y1209(01)) and the
2024 notice (OJ C, C/2024/1645, 22.2.2024; CELEX 52024XC01645), fetched as
XHTML from the Publications Office cellar (EUR-Lex itself answers scripts
with an empty 202). A third, unrelated notice is the control.
A paragraph is a top-level numbered row of the body;
lettered points and indented rows join the paragraph above them; footnote
markers and footnotes are dropped; headings are kept as the paragraph's
section. The parse asserts that paragraph numbers run 1..n without a gap.

    python3 eu_notices.py --out ../../data/metodyka/eu_notices.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import urllib.request

from bs4 import BeautifulSoup

NOTICES = {"1997": "31997Y1209%2801%29", "2024": "52024XC01645",
           # the control: a Commission notice on another subject (the notion of
           # State aid, OJ C 262, 19.7.2016), which no Ukrainian market-definition
           # rule can come from
           "stateaid2016": "52016XC0719%2805%29"}
CELLAR = "http://publications.europa.eu/resource/celex/{}"
NUM = re.compile(r"^(\d{1,3})\.$")


def fetch(celex: str) -> str:
    req = urllib.request.Request(CELLAR.format(celex), headers={"Accept": "application/xhtml+xml", "Accept-Language": "eng"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def paragraphs(xhtml: str, body_class: str, head_class: str) -> list[dict]:
    soup = BeautifulSoup(xhtml, "html.parser")
    for tag in soup.select("a[href^='#ntr'], a[href^='#ntc'], p.note, p.oj-note, span.super, span.oj-super"):
        tag.decompose()
    out, section = [], ""
    started = False
    for el in soup.find_all(["p", "table"]):
        if el.name == "p" and head_class in (el.get("class") or []):
            section = el.get_text(" ", strip=True)
            continue
        if el.name != "table" or el.find_parent("table"):
            continue
        cells = [c.get_text(" ", strip=True) for c in el.find_all("td", recursive=False) or el.select("tr > td")]
        cells = [c for c in cells if c]
        if not cells:
            continue
        m = NUM.match(cells[0])
        if m and len(cells) > 1 and not re.fullmatch(r"\d+", cells[-1]):
            n = int(m.group(1))
            if n == 1:
                started = True
                out = []
            if started and (not out or n == out[-1]["n"] + 1):
                out.append({"n": n, "section": section, "text": " ".join(cells[1:])})
                continue
        if started and out:
            out[-1]["text"] += " " + " ".join(cells)
    for p in out:
        p["text"] = re.sub(r"\s+", " ", p["text"]).strip()
        p["text"] = re.sub(r"\s+([,.;:)])", r"\1", p["text"])
    assert [p["n"] for p in out] == list(range(1, len(out) + 1)), "paragraph numbers skip"
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=pathlib.Path, default=pathlib.Path("."))
    ap.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()
    res = {}
    for year, celex in NOTICES.items():
        f = args.cache / f"{year}.xhtml"
        if not f.exists():
            f.write_text(fetch(celex), encoding="utf-8")
        old = year != "2024"
        res[year] = {"celex": celex.replace("%28", "(").replace("%29", ")"),
                     "paragraphs": paragraphs(f.read_text(encoding="utf-8"), "normal" if old else "oj-normal",
                                              "ti-grseq-1" if old else "oj-ti-grseq-1")}
        ps = res[year]["paragraphs"]
        print(f"{year}: {len(ps)} paragraphs, {sum(len(p['text']) for p in ps)} chars; last: {ps[-1]['text'][:80]!r}")
    args.out.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
