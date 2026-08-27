"""chpipe.pdf_text on four trimmed host PDFs (BS de, GR rm, LU de, BE fr;
the first 2-3 pages of real editions, so each fixture stays under 150 KB)
and on synthetic pdftotext -layout text for the rules the fixtures do not
exercise. The numbers this asserts are the HTML parse's for the same
versions (scripts/pdf_gate.py: 60/60 editions with the same article count,
median per-article ratio 1.000)."""
import pathlib
import shutil

import pytest

from chpipe import pdf_text

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
BS = FIXTURES / "lexwork_bs_117_440_v3152.pdf"
GR = FIXTURES / "lexwork_gr_110_200_v3523_rm.pdf"
LU = FIXTURES / "lexwork_lu_185_v2285.pdf"
BE = FIXTURES / "lexwork_be_101_5_v1898_fr.pdf"

needs_poppler = pytest.mark.skipif(shutil.which("pdftotext") is None,
                                   reason="pdftotext not installed")


@needs_poppler
def test_bs_edition_articles_match_the_html_parse():
    ex = pdf_text.extract(BS)
    assert [a.article_number for a in ex.articles] == [str(n) for n in range(1, 9)]
    assert [a.e_id for a in ex.articles] == [f"t-0--a-{n}" for n in range(1, 9)]
    assert all(a.marginal_note is None for a in ex.articles)
    first = ex.articles[0].text
    assert first.startswith("1 Der Verlauf der neuen Grenze")
    assert "eingetragenen Bestimmungsmasse" in first          # "eingetrage-\nnen" rejoined
    assert "14'916,5 m²" in ex.articles[1].text
    assert "Delegierten zu unterzeichnen" in ex.articles[3].text   # "Dele -\ngierten"
    last = ex.articles[7].text
    assert last.endswith("vom Landrat und vom Grossen Rat genehmigt ist.")
    assert "Liestal" not in last                               # signature block is not art. 8
    assert "Liestal, den 28. Mai 1948" in ex.full_text
    assert "Kantonsgrenze bei St. Jakob 117.440" not in ex.full_text   # running header
    assert "Änderungstabelle" not in ex.full_text              # modification table cut
    assert "Änderungstabelle" in ex.raw_text                   # but kept in the raw text


@needs_poppler
def test_gr_romansh_edition_keeps_marginal_titles_and_drops_footnotes():
    ex = pdf_text.extract(GR)
    assert [(a.article_number, a.marginal_note) for a in ex.articles] == [
        ("1", "Divisiun"), ("2", "Fusiuns da vischnancas"), ("3", "Archivs")]
    assert "Regiun Alvra: a) vischnancas d'Alvra" in ex.articles[0].text
    assert "PCG 2013/2014" not in ex.full_text                  # footnote text
    assert "Divisiun4)" not in ex.full_text                     # footnote reference
    assert ex.full_text.startswith("Lescha davart la divisiun dal chantun Grischun en regiuns")


@needs_poppler
def test_lu_edition_paragraph_signs_bare_footnotes_and_page_break():
    ex = pdf_text.extract(LU)
    assert [a.article_number for a in ex.articles] == [str(n) for n in range(1, 8)]
    assert ex.articles[6].marginal_note == "…" and ex.articles[6].text == ""   # repealed
    assert "GR 1871 122" not in ex.full_text                   # bare-numbered footnote
    assert "Nr. 185" not in ex.full_text                       # header, both page shapes
    assert "Siehe Tabellen" not in ex.full_text
    art2 = ex.articles[1].text
    assert "2 Wo für Beholzung der Pfründen" in art2           # continues after the page break
    assert "Regierungsrates und das Gutachten" in ex.full_text  # "Regierungsrates1" reference


@needs_poppler
def test_be_french_edition_single_space_marginals_and_adjacent_headings():
    ex = pdf_text.extract(BE)
    assert [(a.article_number, a.marginal_note) for a in ex.articles] == [
        ("1", "Objet"), ("2", "Principe"), ("3", "Dépôt des demandes"),
        ("4", "Traitement des données"), ("5", "Compétence"), ("6", "…"), ("7", "Financement")]
    assert ex.articles[5].text == ""
    assert ex.articles[6].text.startswith("1 … 2 Les indemnités pour pertes financières")
    assert "101.5" not in ex.full_text


@needs_poppler
def test_extract_bytes_equals_extract_of_the_file():
    assert pdf_text.extract_bytes(BS.read_bytes()) == pdf_text.extract(BS)


@needs_poppler
def test_not_a_pdf_raises(tmp_path):
    bad = tmp_path / "x.pdf"
    bad.write_bytes(b"<html>login</html>")
    with pytest.raises(pdf_text.PdfTextError):
        pdf_text.raw_text(bad)


# --- split_text on synthetic -layout output ---------------------------------

def _doc(body: str) -> str:
    return "                                   101.1\n\nTitel des Erlasses\n\n" + body


def test_section_headings_give_lexwork_shaped_e_ids():
    articles, text = pdf_text.split_text(_doc(
        "1 Allgemeines\n\nArt. 1       Zweck\n1\n  Text eins.\n\n"
        "1.1 Besonderes\n\nArt. 2       Ziel\n1\n  Text zwei.\n\n"
        "2. Kapitel: Schluss\n\nArt. 3\n1\n  Text drei.\n"))
    assert [a.e_id for a in articles] == [
        "t-0--t-1--a-1", "t-0--t-1--t-1‐1--a-2", "t-0--t-2‐‐Kapitel‐--a-3"]
    assert [a.parent_e_id for a in articles] == ["t-0--t-1", "t-0--t-1--t-1‐1", "t-0--t-2‐‐Kapitel‐"]
    assert articles[1].marginal_note == "Ziel" and articles[1].text == "1 Text zwei."
    assert "1.1 Besonderes" in text.split("\n")


def test_a_citation_at_column_zero_is_not_a_heading():
    articles, _ = pdf_text.split_text(_doc(
        "Art. 4       Verfahren\n1\n  Für das Verfahren gilt sinngemäss\n"
        "Art. 9 Absatz 1 Buchstabe c, soweit nichts anderes bestimmt ist.\n\n"
        "Art. 5       Schluss\n1\n  Ende.\n"))
    assert [a.article_number for a in articles] == ["4", "5"]
    assert "Art. 9 Absatz 1 Buchstabe c" in articles[0].text


def test_repealed_and_annex_articles_and_duplicate_numbers():
    articles, _ = pdf_text.split_text(_doc(
        "Art. 1 *     Zweck\n1\n  Eins. *\n\nArt. 2 * …\nArt. 3       Drei\n1\n  Drei.\n\n"
        "A1 Anhang 1\n\nArt. A1-1    Berechnung\n1\n  Formel.\n\nArt. A1-1    Nochmals\n1\n  Zwei.\n"))
    assert [(a.article_number, a.marginal_note, a.text) for a in articles] == [
        ("1", "Zweck", "1 Eins."), ("2", "…", ""), ("3", "Drei", "1 Drei."),
        ("1-1", "Berechnung", "1 Formel."), ("1-1", "Nochmals", "1 Zwei.")]
    assert articles[3].e_id == "t-0--t-A1--a-A1‐1"
    assert articles[4].e_id == "t-0--t-A1--a-A1‐1-2"


def test_hyphen_before_a_conjunction_is_a_compound():
    articles, _ = pdf_text.split_text(_doc(
        "Art. 1\n1\n  Die Kantons-\nund Gemeindesteuern sowie die Basel-\nStadt betreffen-\nden Fragen.\n"))
    assert articles[0].text == "1 Die Kantons- und Gemeindesteuern sowie die Basel-Stadt betreffenden Fragen."


def test_french_modification_table_and_enactment_lines_are_cut():
    articles, text = pdf_text.split_text(_doc(
        "Art. 1       But\n1\n  Texte.\n\nArt. 2       Fin\n1\n  Dernier.\n\n"
        "Adopté le 3 mars 2020.\n\n\fTableau des modifications par date de décision\n"
        "Art. 1   03.03.2020   modifié\n"))
    assert articles[1].text == "1 Dernier."
    assert "Adopté le 3 mars 2020." in text
    assert "Tableau des modifications" not in text and "modifié" not in text


def test_repeated_header_and_footer_lines_are_dropped_across_pages():
    page = "Kurztitel                    101.1\n\nArt. {n}\n1\n  Absatz.\n\n\n\n* Änderungstabellen am Schluss des Erlasses\n{n}\n"
    raw = "\f".join(page.format(n=n) for n in (1, 2, 3))
    articles, text = pdf_text.split_text(raw)
    assert [a.article_number for a in articles] == ["1", "2", "3"]
    assert "Kurztitel" not in text and "Änderungstabellen" not in text
    assert all(a.text == "1 Absatz." for a in articles)


def test_paren_footnotes_at_the_page_foot_are_dropped_but_not_enumerations():
    articles, _ = pdf_text.split_text(_doc(
        "Art. 1\n1\n  Es gelten:\n   a)    die Regel1);\n   b)    die Ausnahme.\n\n"
        "1)   BSG 101.1\n2)\n     GS 2013/014\n                          1\n"))
    assert articles[0].text == "1 Es gelten: a) die Regel; b) die Ausnahme."


def test_empty_and_textless_input():
    assert pdf_text.split_text("") == ([], "")
    assert pdf_text.split_text("\f\f") == ([], "")
