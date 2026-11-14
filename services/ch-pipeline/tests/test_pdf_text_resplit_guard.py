"""Phase C regression (CHPIPE_RESPLIT=all, rolled back 2026-11-14): the
cleaned splitter lost articles the pre-cleanup one read. split_text now
keeps the cleaned split's articles only when they lose no article number
pdf_text_legacy finds; full_text is the cleaned text either way.

Fixtures are page excerpts (form feeds kept) of the editions the rolled-back
run damaged most:
  pdftext_zh_181_10_indented_headings.txt   zhlex 294662, pages 1-4
  pdftext_zh_glued_footnote_number.txt      zhlex 294885, pages 11-12
  pdftext_ai_270_000_citation_list.txt      lexwork_pdf 90361, pages 3 and 10
  pdftext_ne_414_110_21_left_column.txt     lexfind 336684, pages 1-2
"""
import pathlib

import pytest

from chpipe import pdf_text, pdf_text_legacy, text_clean

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text()


def _numbers(articles) -> list[str]:
    return [a.article_number for a in articles]


def _legacy(raw: str) -> list[str]:
    return _numbers(pdf_text_legacy.split_text(text_clean.normalise_chars(raw))[0])


def test_lost_numbers_is_a_multiset_and_admits_a_letter_suffix():
    assert pdf_text.lost_numbers(["1", "2", "3"], ["1", "3"]) == ["2"]
    assert pdf_text.lost_numbers(["3", "3"], ["3"]) == ["3"]
    # "§ 43 a.26": the old splitter read 43, the cleaned one 43a
    assert pdf_text.lost_numbers(["43", "44"], ["43a", "44"]) == []
    # not the other way round, and not across numbers
    assert pdf_text.lost_numbers(["29a"], ["29"]) == ["29a"]
    assert pdf_text.lost_numbers(["4"], ["43"]) == ["4"]


def test_zh_indented_heading_on_a_marginal_column_page_is_an_article():
    """ZH 181.10 (Kirchenordnung, 294662): once the marginal column is off,
    "   Art. 12 1 Das Bekenntnis ..." keeps its first-line indent. The
    rolled-back run read it as body text: Art. 12 mid-line in full_text,
    123 articles -> 2."""
    raw = _read("pdftext_zh_181_10_indented_headings.txt")
    articles, full_text = pdf_text.split_text(raw, "de")
    assert _numbers(articles) == [str(n) for n in range(3, 21)]
    art12 = articles[_numbers(articles).index("12")]
    assert art12.marginal_note == "Ökumene und interreligiöser Dialog"
    assert art12.text.startswith("1 Das Bekenntnis zu Jesus Christus verpflichtet zur Ökumene. 2 ")
    assert "Art. 13" not in art12.text
    lines = full_text.split("\n")
    assert "Art. 12 Ökumene und interreligiöser Dialog" in lines
    # no heading of the column pages sits inside a line any more
    assert not [l for l in lines if " Art. 1" in l and not l.startswith("Art. ")]
    # the cleaned split itself carries them now (the legacy one misses 8-13)
    assert set(_numbers(pdf_text._split_clean(raw, "de")[0])) >= {"8", "9", "10", "11", "12", "13"}
    assert "12" not in _legacy(raw)


def test_zh_footnote_glued_number_does_not_swallow_the_next_articles():
    """294885: "Art. 4321 1 Die Rekurskommission" (art. 43, footnote 21)
    puts the cleaned split's order at 4321, so art. 44-46 read as citations.
    The legacy split's articles are kept."""
    raw = _read("pdftext_zh_glued_footnote_number.txt")
    articles, full_text = pdf_text.split_text(raw, "de")
    assert {"44", "45", "46"} <= set(_numbers(articles))
    assert full_text == pdf_text._split_clean(raw, "de")[1]


def test_lexwork_ai_citation_list_does_not_eat_the_articles():
    """AI 270.000 (90361): the cleaned rules drop the "270.000   4" page
    header, the page dedents, and the citation list "Art. 185 Anordnung der
    Gütertrennung ..." reaches column 0 -- the order jumps to 185 and every
    real article after it (Art. 48, Art. 50 ...) is rejected: 137 -> 11."""
    raw = _read("pdftext_ai_270_000_citation_list.txt")
    articles, full_text = pdf_text.split_text(raw, "de")
    assert _numbers(articles) == ["48", "50"]
    assert "Der Präsident des Gerichtes bestimmt die Reihenfolge" in articles[0].text
    # full_text is the cleaned one: the marginal column is off the body
    assert full_text == pdf_text._split_clean(raw, "de")[1]
    assert "Der Präsident des Gerichtes bestimmt die Reihenfolge der zu beurteilenden Geschäfte." \
        in full_text


def test_lexfind_ne_left_column_page_keeps_its_first_articles():
    """NE 414.110.21 (336684): on page 1 the date column ("8 / juillet /
    2022") is not taken off with the marginal column, the body stays
    indented and "Art. 2" / "Art. 3" are not at column 0 for the cleaned
    rules: 19 -> 13 in the rolled-back run."""
    raw = _read("pdftext_ne_414_110_21_left_column.txt")
    articles, _ = pdf_text.split_text(raw, "fr")
    assert _numbers(articles) == ["2", "3", "4", "5", "6", "7", "8"]


@pytest.mark.parametrize("name", sorted(p.name for p in FIXTURES.glob("pdftext_*.txt")
                                         if "decision" not in p.name and "fedlex" not in p.name))
def test_split_never_loses_an_article_the_legacy_split_finds(name):
    raw = _read(name)
    for lang in (None, "de", "fr"):
        articles, _ = pdf_text.split_text(raw, lang)
        assert pdf_text.lost_numbers(_legacy(raw), _numbers(articles)) == [], (name, lang)


def test_full_text_is_always_the_cleaned_text():
    for name in ("pdftext_zh_181_10_indented_headings.txt", "pdftext_ai_270_000_citation_list.txt",
                 "pdftext_zh_marginal_splice.txt"):
        raw = _read(name)
        assert pdf_text.split_text(raw, "de")[1] == pdf_text._split_clean(raw, "de")[1], name
