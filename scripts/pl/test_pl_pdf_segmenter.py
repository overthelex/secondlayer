#!/usr/bin/env python3
"""Tests for pl_pdf_segmenter on synthetic PyMuPDF pages (no PDF, no database).

  python3 scripts/pl/test_pl_pdf_segmenter.py

The span shapes (sizes, flags, bracketed superscripts, the separate footnote
marker column) are copied from DU/2026/1245 (Kodeks pracy 2026), see the
module docstring of pl_pdf_segmenter.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pl_pdf_segmenter as seg  # noqa: E402

N, B, SUP, BSUP = 4, 20, 5, 21  # flag values seen in the source: normal, bold, sup, bold sup


def span(text, flags=N, size=10.0, x=60.0, y=0.0):
    return {"text": text, "flags": flags, "size": size, "origin": (x, y)}


class Page:
    def __init__(self, lines):
        """lines: list of span lists; y is assigned in order unless a span sets it."""
        self.blocks = []
        for i, spans in enumerate(lines):
            for s in spans:
                if not s["origin"][1]:
                    s["origin"] = (s["origin"][0], 80.0 + 12 * i)
            self.blocks.append({"lines": [{"spans": spans}]})

    def get_text(self, kind):
        assert kind == "dict"
        return {"blocks": self.blocks}


def art(no, sup=None, rest=" Treść artykułu.", note=None):
    spans = [span(f"Art. {no}", B)]
    if sup:
        spans += [span(f"[{sup}]", BSUP, 6.5), span(".", B)]
    else:
        spans[0]["text"] += "."
    if note:
        spans.append(span(f"{note})", SUP, 6.5))
    spans.append(span(rest))
    return spans


def line(text, flags=N, size=10.0):
    return [span(text, flags, size)]


HEAD = [line("Dziennik Ustaw"), line("– 3 –"), line("Poz. 1245")]
ANNEX = [line("Załącznik do obwieszczenia Marszałka Sejmu", size=8.0)]


def run(pages, consolidation=True):
    lines, notes = seg.read_lines(pages)
    return seg.segment(lines, consolidation, notes)


class SegmentTest(unittest.TestCase):
    def test_superscript_numbers_and_letters(self):
        st, arts, _ = run([Page(HEAD + ANNEX + [art(1), art(3, "1"), art(18, "3a"), art(25, None)])])
        self.assertEqual(st, seg.OK)
        self.assertEqual([a["art_no"] for a in arts], ["1", "3^1", "18^3a", "25"])
        self.assertEqual(arts[1]["text"], "Treść artykułu.")

    def test_obwieszczenie_part_and_running_heads_are_skipped(self):
        quoted = [span("„Art. 3.", N), span(" Ustawa wchodzi w życie...")]
        st, arts, _ = run([Page(HEAD + [line("Art. 9. cytowany", B), quoted] + ANNEX + [art(1)])])
        self.assertEqual([a["art_no"] for a in arts], ["1"])
        self.assertNotIn("Dziennik", arts[0]["text"])

    def test_no_annex_in_a_consolidation_is_rejected(self):
        st, _, _ = run([Page([art(1)])])
        self.assertEqual(st, seg.NO_ANNEX)
        st, arts, _ = run([Page([art(1)])], consolidation=False)
        self.assertEqual(st, seg.OK)

    def test_body_lines_hyphenation_and_paragraph_breaks(self):
        st, arts, _ = run([Page(ANNEX + [
            art(5, rest=" § 1. Pracodawca jest obowią-"), line("zany zapewnić warunki."),
            line("§ 2. Drugi paragraf:"), line("1)"), line("punkt pierwszy;")])])
        self.assertEqual(arts[0]["text"],
                         "§ 1. Pracodawca jest obowiązany zapewnić warunki.\n\n§ 2. Drugi paragraf:\n\n1)\npunkt pierwszy;")

    def test_footnotes_attached_with_their_cross_references(self):
        page = Page(ANNEX + [
            art(7, "1", note="11", rest=" Stara wersja."),
            art(7, "1", note="12", rest=" Nowa wersja."),
            [span("11)", N, 9.0, x=60, y=700), span("W tym brzmieniu obowiązuje do wejścia w życie zmiany, o której mowa w odnośniku 12.", N, 9.0, x=80, y=700)],
            [span("12)", N, 9.0, x=60, y=711), span("W brzmieniu ustalonym przez ustawę, o której mowa w odnośniku 6.", N, 9.0, x=80, y=711)],
            [span("6)", N, 9.0, x=60, y=722), span("Ustawa z dnia 19 czerwca 2026 r., która wejdzie", N, 9.0, x=80, y=722)],
            [span("w życie z dniem 5 listopada 2026 r.", N, 9.0, x=80, y=733)],
        ])
        st, arts, _ = run([page])
        self.assertEqual([a["art_no"] for a in arts], ["7^1", "7^1"])
        self.assertTrue(arts[0]["text"].startswith("Stara wersja.\n\nPrzypisy:\n11) W tym brzmieniu"))
        self.assertIn("6) Ustawa z dnia 19 czerwca 2026 r., która wejdzie w życie z dniem 5 listopada 2026 r.",
                      arts[1]["text"])
        self.assertNotIn("11)", arts[1]["text"])
        # footnote text never leaks into the body
        self.assertNotIn("W tym brzmieniu", arts[0]["text"].split("Przypisy:")[0])

    def test_headings_with_titles_and_units(self):
        st, arts, heads = run([Page(ANNEX + [
            line("DZIAŁ PIERWSZY"), line("Przepisy ogólne"), line("Rozdział I"), line("Przepisy wstępne"),
            art(1), [span("TYTUŁ VI"), span("[1]", SUP, 6.5)], art(2),
            line("DZIAŁ JEDENASTY"), line("(uchylony)"), art(242)])])
        self.assertEqual([(h["kind"], h["name"], h["title"]) for h in heads], [
            ("dział", "PIERWSZY", "Przepisy ogólne"), ("rozdział", "I", "Przepisy wstępne"),
            ("tytuł", "VI^1", None), ("dział", "JEDENASTY", "(uchylony)")])
        units = seg.heading_units(heads, arts)
        self.assertEqual(units[0]["title"], "Dział PIERWSZY - Przepisy ogólne")
        self.assertEqual(units[1]["parent"], 0)
        self.assertEqual(units[2]["unit_type"], "arti")
        self.assertEqual(units[2]["article_ord"], 1)

    def test_superscript_heading_name(self):
        lines = [(t, "", False, []) for t in ("Załącznik do obwieszczenia", "TYTUŁ VI^1", "Odpowiedzialność")]
        lines.append(("Art. 12‒14. (pominięte)", "Art. 12", True, []))
        lines.append(("Art. 449^1. Tekst.", "Art. 449^1.", True, []))
        st, arts, heads = seg.segment(lines, True)
        self.assertEqual(heads[0]["name"], "VI^1")
        self.assertEqual([a["art_no"] for a in arts], ["12-14", "449^1"])


class ValidateTest(unittest.TestCase):
    def arts(self, *nos):
        return [{"art_no": n, "text": "x"} for n in nos]

    def test_backwards_numbering_is_rejected(self):
        self.assertEqual(seg.validate(self.arts("1", "3", "2"), None)[0], seg.NONMONOTONIC)

    def test_two_versions_of_one_article_are_allowed(self):
        self.assertEqual(seg.validate(self.arts("1", "2^1", "2^1", "3"), None)[0], seg.OK)

    def test_superscripts_sort_after_their_base(self):
        self.assertEqual(seg.validate(self.arts("1", "9", "9^1", "9^2", "10", "18^3", "18^3a", "18^3b", "19"), None)[0], seg.OK)

    def test_polish_letter_suffixes(self):
        self.assertEqual(seg.validate(self.arts("1", "9", "9a", "9z", "9aa", "9ab", "10"), None)[0], seg.OK)
        self.assertEqual(seg.validate(self.arts("1", "13", "13d", "13da", "13e", "14"), None)[0], seg.OK)
        self.assertEqual(seg.validate(self.arts("1", "22", "22^1", "22a", "22a^1", "23"), None)[0], seg.OK)
        self.assertEqual(seg.validate(self.arts("1", "22^2", "22^1"), None)[0], seg.NONMONOTONIC)

    def test_a_step_back_is_tolerated_only_against_a_previous_edition(self):
        cur = self.arts("1", "2", "4", "3", "5")
        self.assertEqual(seg.validate(cur, None)[0], seg.NONMONOTONIC)
        st, detail = seg.validate(cur, ["1", "2", "3", "4", "5"])
        self.assertEqual((st, detail["backwards"]), (seg.OK, 1))

    def test_coverage_against_the_previous_edition(self):
        prev = [str(i) for i in range(1, 101)]
        cur = self.arts(*[str(i) for i in range(1, 101) if i not in (50, 51, 52, 53)])
        st, detail = seg.validate(cur, prev)
        self.assertEqual(st, seg.COVERAGE)
        self.assertIn("50", detail["missing"])

    def test_a_repealed_unit_explains_its_missing_articles(self):
        prev = [str(i) for i in range(1, 101)]
        cur = self.arts(*[str(i) for i in range(1, 101) if not 40 <= i <= 60])
        heads = [{"kind": "dział", "name": "XI", "title": "(uchylony)", "article_ord": 39}]
        st, detail = seg.validate(cur, prev, heads)
        self.assertEqual(st, seg.OK)
        self.assertEqual(detail["repealed_units"], 21)
        # the same gap without the repealed heading is not explained
        self.assertEqual(seg.validate(cur, prev, [])[0], seg.COVERAGE)

    def test_an_omitted_range_explains_its_articles(self):
        prev = ["79", "80", "80a", "81", "81a", "82", "85", "85a", "85d", "86"]
        st, detail = seg.validate(self.arts("79", "80", "80a-85d", "86"), prev)
        self.assertEqual(st, seg.OK)

    def test_range_heading_with_figure_dash(self):
        lines = [("Załącznik do obwieszczenia", "", False, []),
                 ("Art. 12‒14. (pominięte)", "Art. 12‒14.", True, []),
                 ("Art. 238–241^31. (uchylone)", "Art. 238–241^31.", True, [])]
        st, arts, _ = seg.segment(lines, True)
        self.assertEqual([a["art_no"] for a in arts], ["12-14", "238-241^31"])
        self.assertEqual(arts[0]["text"], "(pominięte)")

    def test_without_previous_edition_numbering_must_start_at_one(self):
        self.assertEqual(seg.validate(self.arts("5", "6"), None)[0], seg.NONMONOTONIC)

    def test_empty_articles(self):
        cur = [{"art_no": str(i), "text": "" if i < 5 else "x"} for i in range(1, 50)]
        self.assertEqual(seg.validate(cur, None)[0], seg.EMPTY_ARTICLES)


if __name__ == "__main__":
    unittest.main()
