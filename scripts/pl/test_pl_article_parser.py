#!/usr/bin/env python3
"""Fixture tests for pl_article_parser.

Fixtures are real API responses cached under FIXTURES (default
/data/pl_eli/fixtures). Fetch them once with:

    python3 scripts/pl/test_pl_article_parser.py --fetch

Every expected number below was measured against the live API on 2026-08-14 and
is asserted as an equality. If one of them moves, the source changed the act -
record the new value with the date - or the parser regressed. Do not relax an
assertion to make it pass.

Run:  python3 scripts/pl/test_pl_article_parser.py
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pl_article_parser as P  # noqa: E402

API = "https://api.sejm.gov.pl/eli"
FIXTURES = os.environ.get("FIXTURES", "/data/pl_eli/fixtures")

CASES = [
    # eli, is_consolidation, articles, struct arti in scope, DOM anchors,
    # verdict, non-monotonic count
    #
    # DU/2020/1320: 497 DOM anchors vs 494 articles is correct. The three extras
    # are pass_2-pint_1-arti_5/6 and pass_2-pint_2-arti_86 - articles QUOTED in
    # the obwieszczenie's own passages, which struct excludes from the annex.
    #
    # DU/1964/93 nonmono=1 is a defect in the published source, not in the
    # parser: the article at position 536 is labelled "Art. 538." by both struct
    # and the DOM, while its text is the real article 536. Pinned so that the
    # day it changes - because ISAP fixed it, or because we broke ordering - it
    # shows up instead of passing quietly.
    ("DU/1974/141",  False,  305,  305,  305, P.OK, 0),
    ("DU/2020/1320", True,   494,  494,  497, P.OK, 0),
    ("DU/1964/93",   False, 1088, 1088, 1088, P.OK, 1),
    ("DU/2023/1610", True,  1295, 1295, 1302, P.OK, 0),
    ("DU/1997/553",  False,  363,  363,  363, P.OK, 0),
]


def fname(eli, kind):
    return os.path.join(FIXTURES, eli.replace("/", "_") + kind)


def fetch_all():
    os.makedirs(FIXTURES, exist_ok=True)
    for eli, *_ in CASES:
        for kind, path in (("/text.html", ".html"), ("/struct", ".struct.json")):
            out = fname(eli, path)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                print(f"  have {out}")
                continue
            subprocess.run(["curl", "-s", "-m", "120", f"{API}/acts/{eli}{kind}",
                            "-o", out], check=True)
            print(f"  fetched {out} ({os.path.getsize(out)} bytes)")
    # The negative landmark: no HTML at all, so only the detail is stored.
    out = fname("DU/1997/483", ".detail.json")
    subprocess.run(["curl", "-s", "-m", "60", f"{API}/acts/DU/1997/483", "-o", out],
                   check=True)
    print(f"  fetched {out}")


def run():
    failures = []

    for (eli, is_cons, want_articles, want_struct, want_anchors,
         want_verdict, want_nonmono) in CASES:
        html_p, struct_p = fname(eli, ".html"), fname(eli, ".struct.json")
        if not (os.path.exists(html_p) and os.path.exists(struct_p)):
            failures.append(f"{eli}: fixtures missing, run with --fetch")
            continue

        with open(html_p, "rb") as f:
            html = f.read()
        with open(struct_p, encoding="utf-8") as f:
            struct = json.load(f)

        r = P.parse(struct, html, is_consolidation=is_cons)
        checks = [
            ("verdict", r.verdict, want_verdict),
            ("articles", len(r.articles), want_articles),
            ("struct_articles", r.struct_articles, want_struct),
            ("nonmonotonic", r.nonmonotonic, want_nonmono),
            # Label agreement is the check that catches mis-pairing of repeated
            # struct ids, so it is asserted at zero everywhere rather than only
            # folded into the verdict.
            ("label_mismatches", r.label_mismatches, 0),
        ]
        if want_anchors is not None:
            checks.append(("dom_anchors", r.dom_anchors, want_anchors))

        bad = [f"{n}: got {g}, want {w}" for n, g, w in checks if g != w]
        status = "ok" if not bad else "FAIL"
        print(f"{eli:<14} cons={str(is_cons):<5} arts={len(r.articles):>5} "
              f"struct={r.struct_articles:>5} dom={r.dom_anchors:>5} "
              f"verdict={r.verdict} labelmm={r.label_mismatches} "
              f"nonmono={r.nonmonotonic} {status}")
        for b in bad:
            print(f"    - {b}")
            failures.append(f"{eli}: {b}")
        for note in r.notes:
            print(f"    note: {note}")

    # --- content assertions: the number being right does not mean the text is ---

    def articles_of(eli, is_cons):
        with open(fname(eli, ".html"), "rb") as f:
            html = f.read()
        with open(fname(eli, ".struct.json"), encoding="utf-8") as f:
            struct = json.load(f)
        r = P.parse(struct, html, is_consolidation=is_cons)
        return {a["art_no"]: a for a in r.articles}, r

    if os.path.exists(fname("DU/1974/141", ".html")):
        kp74, _ = articles_of("DU/1974/141", False)
        kp20, r20 = articles_of("DU/2020/1320", True)

        # The base act's text.html is the 1974 ORIGINAL, not a consolidation.
        # This is the assertion that would have caught the original plan's wrong
        # assumption that text.html serves a current consolidated text.
        if "socjalistycznych" not in kp74.get("1", {}).get("text", ""):
            failures.append("DU/1974/141 art. 1 lost the 1974 wording")
        # ...and the obwieszczenie's text.html is the consolidation.
        if "socjalistyczn" in kp20.get("1", {}).get("text", ""):
            failures.append("DU/2020/1320 art. 1 still carries the 1974 wording")
        print(f"\nKP art.1 1974: {kp74.get('1', {}).get('text', '')[:70]!r}")
        print(f"KP art.1 2020: {kp20.get('1', {}).get('text', '')[:70]!r}")

        # Superscript articles survive as addressable numbers.
        if "304^4" not in kp20:
            failures.append("DU/2020/1320 has no art_no '304^4'")
        else:
            a = kp20["304^4"]
            if (a["art_sort_1"], a["art_sort_2"]) != (304, 4):
                failures.append(f"304^4 sorts as {a['art_sort_1']},{a['art_sort_2']}")
            print(f"KP 304^4 display={a['art_display']!r} sort=({a['art_sort_1']},{a['art_sort_2']})")

        # The three quoted articles inside the obwieszczenie's own passages must
        # NOT have become articles of the code.
        quoted = [a for a in r20.articles if a["struct_id"].startswith("pass_")]
        if quoted:
            failures.append(f"{len(quoted)} articles leaked from obwieszczenie passages")

    if os.path.exists(fname("DU/2023/1610", ".html")):
        kc23, _ = articles_of("DU/2023/1610", True)
        want = "Kto z winy swej wyrządził drugiemu szkodę, obowiązany jest do jej naprawienia."
        got = kc23.get("415", {}).get("text", "").strip()
        if got != want:
            failures.append(f"KC art. 415 text mismatch: {got[:90]!r}")
        print(f"KC 415 (t.j. 2023): {got!r}")

    # The negative landmark. Konstytucja RP publishes no HTML and no struct, so
    # the parser must return a verdict rather than an empty success.
    r = P.parse(None, b"", is_consolidation=False)
    if r.verdict != P.NO_STRUCT:
        failures.append(f"no-struct case returned verdict {r.verdict}, want {P.NO_STRUCT}")
    else:
        print(f"\nno-struct case -> verdict {r.verdict} (Konstytucja RP DU/1997/483 path)")

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all fixture tests passed")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="download fixtures first")
    a = ap.parse_args()
    if a.fetch:
        fetch_all()
    sys.exit(run())
