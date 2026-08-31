"""Detector-first gate for chpipe/fedlex_split.py: the split of a stored
fedlex_pdf full_text against the AKN parse of the CLOSEST-DATED edition of
the same act and language.

Unlike scripts/pdf_gate.py (where the PDF and the HTML parse are the SAME
version and 1.000 similarity is the pass mark), the two sides here are
different consolidations of the same act -- the pdf-a era ends where the
AKN era begins -- so high-but-not-perfect is the expected shape and the
gate reports distributions, not equalities.

Usage (from services/ch-pipeline, .venv python):

  1. run the pool query (see the phase-B worklog; 63 (act, lang) pairs
     spread over 7 decades x {de, fr, it}, each pair = one parsed
     fedlex_pdf edition + the closest-dated source='fedlex' edition with
     articles) on the prod DB read-only -> gate.jsonl, one JSON object per
     line: {pdf_version_id, act_id, lang, pdf_date, akn_version_id,
     akn_date, akn_article_count, pdf_full_text, akn_articles:[{e_id,n,t}]}
  2. python scripts/fedlex_pdf_gate.py gate.jsonl [--dump] [--only VID]

Metrics per pair:
  overlap   article-number set overlap |pdf ∩ akn| / |akn| (Roman-numbered
            articles have number None on BOTH sides -- akn.normalise_number
            finds no digits -- and are matched by e_id art_I/art_II instead)
  ratio     median per-article SequenceMatcher ratio over the matched
            numbers (different consolidations: amended articles differ)
  count     len(pdf articles) / len(akn articles)

ACCEPTANCE (defined before the apply run): median article-number overlap
>= 0.80 overall AND >= 0.90 for pairs whose pdf and AKN dates are within
5 years; no systematic failure class left unexplained. Per-article text
similarity is diagnostic only -- a 1950 consolidation SHOULD differ from a
2016 one -- but a median ratio below ~0.5 on a same-decade pair marks a
splitter defect, not an amendment.

MEASURED 2026-08-31 (63 pairs, gate.jsonl of the same date):

  overall         median overlap 1.000   mean 0.962
  gap <= 5y (n=8) median overlap 1.000   mean 1.000
  text ratio      median of per-pair medians 1.000

  distribution of overlap over the 63: 1.00 x46, 0.90-0.99 x8,
  0.80-0.89 x4, 0.60-0.79 x5, <0.60 x0

  every pair under 0.90, each checked against the PDF text itself (are the
  missing AKN numbers even PRINTED as headings in the pdf-a edition? --
  after the last splitter fix the answer is no for all of them, so the gap
  is the consolidation date, not the splitter):
    568779 it 1994 (0.62)  the 19 missing articles are the 2017 AKN's
                           ANNEX articles (e_id annex_u1/lvl_u2/art_I...);
                           the 1994 print predates that annex; text ratio
                           0.15 because the convention was renumbered
    561767 fr 1999 (0.69)  RAI: 76 missing numbers are 1bis..21novies
                           inserted after 1999, none printed in the pdf
    560966 de 2001 (0.72)  \
    560968 it 2001 (0.75)   same act pre/post the 2003-2019 insertions
    560718 fr 2010 (0.71)  missing 1a-3l etc. inserted 2011, not printed
    562788 de 1984 (0.88), 564195 fr 1996 (0.82, the "Art. 0.01" decimal
    ordinance), 560512 fr 2011 (0.86), 560632 it 2011 (0.87): the same
    temporal shape, partial

Dry run over 203 random parsed fedlex_pdf rows (version_id % 251 = 7,
prod full_texts read-only, 2026-08-31): 199/203 = 98.0% split into >= 1
article, 11,028 articles, 0 exceptions. The four zeros inspected by hand:
one it 2008 training ordinance whose whole body is "not published in the
RU" (correctly zero articles), two siblings of it, and one ITU amendment
instrument with a single indented "Art. 33" under a numbered-margin layout
this splitter does not claim.

Expected recovery at these numbers: ~98% of the 50,998 rows gain articles
(~50,000 rows, ~2.5-2.8M articles extrapolating 54 articles/row from the
dry run); article-number fidelity per the overlap distribution above.
"""
from __future__ import annotations

import collections
import difflib
import json
import pathlib
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from chpipe import fedlex_split  # noqa: E402

_WS_NORM = str.maketrans({"\xa0": " "})


def norm(text: str | None) -> str:
    return " ".join((text or "").translate(_WS_NORM).split())


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, norm(a), norm(b), autojunk=False).ratio()


def compare_one(record: dict) -> dict:
    articles, _ = fedlex_split.split_fedlex_text(record["pdf_full_text"])
    akn_articles = record["akn_articles"] or []
    pdf_by_number = {}
    pdf_by_eid = {}
    for article in articles:
        if article.article_number is not None:
            pdf_by_number.setdefault(article.article_number, article)
        pdf_by_eid.setdefault(article.e_id, article)
    hits = 0
    ratios = []
    for ref in akn_articles:
        # e_id first: it is the key that stays unique when numbers repeat
        # (the "Art. 0.01" ordinances normalise every number in part 0 to
        # "0"); the number covers e_id drift between consolidations
        match = pdf_by_eid.get(ref["e_id"])
        if match is None and ref["n"] is not None:
            match = pdf_by_number.get(ref["n"])
        if match is not None:
            hits += 1
            if norm(ref["t"]) or norm(match.text):
                ratios.append(ratio(ref["t"], match.text))
    return {
        "vid": record["pdf_version_id"], "lang": record["lang"],
        "pdf_date": record["pdf_date"], "akn_date": record["akn_date"],
        "n_pdf": len(articles), "n_akn": len(akn_articles),
        "overlap": hits / len(akn_articles) if akn_articles else 0.0,
        "med_ratio": statistics.median(ratios) if ratios else 0.0,
        "articles": articles,
    }


def main(argv: list[str]) -> None:
    if not argv:
        print(__doc__)
        sys.exit(2)
    dump = "--dump" in argv
    only = None
    if "--only" in argv:
        only = int(argv[argv.index("--only") + 1])
    results = []
    for line in pathlib.Path(argv[0]).read_text().splitlines():
        if not line.strip().startswith("{"):
            continue
        record = json.loads(line)
        if only and record["pdf_version_id"] != only:
            continue
        r = compare_one(record)
        results.append(r)
        gap = abs(int(r["pdf_date"][:4]) - int(r["akn_date"][:4]))
        print(f"{r['vid']} {r['lang']} {r['pdf_date']}/{r['akn_date']} gap {gap:2d}y "
              f"arts {r['n_pdf']:3d}/{r['n_akn']:3d} overlap {r['overlap']:.2f} "
              f"ratio {r['med_ratio']:.2f}")
        if dump:
            for a in r["articles"]:
                print("   ", a.e_id, a.article_number, repr(a.marginal_note), a.text[:100])
    if not results:
        return
    overlaps = [r["overlap"] for r in results]
    near = [r for r in results
            if abs(int(r["pdf_date"][:4]) - int(r["akn_date"][:4])) <= 5]
    print()
    print(f"n={len(results)} overlap median {statistics.median(overlaps):.3f} "
          f"mean {statistics.mean(overlaps):.3f}")
    if near:
        print(f"gap<=5y n={len(near)} overlap median "
              f"{statistics.median([r['overlap'] for r in near]):.3f} mean "
              f"{statistics.mean([r['overlap'] for r in near]):.3f}")
    print("text ratio median of medians "
          f"{statistics.median([r['med_ratio'] for r in results]):.3f}")
    buckets = collections.Counter()
    for o in overlaps:
        buckets["1.00" if o >= 0.995 else "0.90+" if o >= 0.9 else "0.80+" if o >= 0.8
                else "0.60+" if o >= 0.6 else "<0.60"] += 1
    print("distribution", dict(buckets))


if __name__ == "__main__":
    main(sys.argv[1:])
