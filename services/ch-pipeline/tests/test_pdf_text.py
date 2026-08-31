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


# --- the three heading shapes found on the first prod pass ------------------
# 389 lexwork_pdf editions had text but no articles on 2026-08-27; the raw
# pdftotext output of the affected shapes, trimmed, is the fixture text.

def test_article_number_with_a_trailing_dot_so_concordat():
    articles, text = pdf_text.split_text((FIXTURES / "pdftext_so_111_53_art_dot.txt").read_text())
    assert [(a.article_number, a.marginal_note) for a in articles] == [
        ("1", "Ziele"), ("2", "Gebiet"), ("3", "Mitglieder")]
    assert articles[0].text.startswith("Im Oberrheinrat schliessen sich")   # body, not marginal
    assert articles[0].e_id == "t-0--t-1‐‐Kapitel‐--a-1"                   # "1. Kapitel: Grundlagen"
    assert "Präambel" in text


def test_centred_paragraph_sign_with_the_marginal_on_the_next_line_zg():
    articles, _ = pdf_text.split_text((FIXTURES / "pdftext_zg_centered_par.txt").read_text())
    assert [(a.article_number, a.marginal_note) for a in articles] == [
        ("1", "Beitrittserklärung"), ("2", "Inkrafttreten")]
    assert articles[0].text.startswith("Der Kanton Zug tritt der Interkantonalen Vereinbarung")
    assert articles[1].text.startswith("1 Dieser Kantonsratsbeschluss untersteht")


def test_left_column_marginals_with_inline_paragraph_numbers_ar():
    articles, _ = pdf_text.split_text((FIXTURES / "pdftext_ar_left_column.txt").read_text())
    assert [(a.article_number, a.marginal_note) for a in articles] == [
        ("1", "Gegenstand"), ("2", "Grundsätze"), ("3", "Allgemeine Bestimmungen")]
    assert articles[0].text.startswith("Die Gebühren, welche die ATIOZ")
    assert "2 Bei der Gebührenerhebung wird zwischen folgenden Bereichen" in articles[1].text
    assert "Aufsichtstätigkeit" in articles[2].text        # "Auf-" + column word + "sichtstätigkeit" untangled


def test_a_citation_in_an_indented_line_is_still_not_a_heading():
    articles, _ = pdf_text.split_text(_doc(
        "Art. 1\n1\n  Eins.\n\n   Art. 45 Abs. 4 KV kann daher die Nichtwählbarkeit der Mitglieder des\n"
        "   Kantonsrates nicht begründen.\n\n"
        "          Art. 24 FV92  . . . . . . . . . . . . . . . . . . . 12\n"))
    assert [a.article_number for a in articles] == ["1"]


# --- clause mode (phase B): decisions in numbered clauses -----------------
# Gate, 2026-08-31: 41 clause-splitting editions over 17 hosts (2-3 per
# host, from 380 article-less prod rows sampled), emitted clause count vs
# the visible top-level numbering chain of the cleaned text -- 41/41 equal.
# The table (host, version_id, emitted=chain):
#   ai.clex.ch 87676=5 87678=3 88476=20 | ar.clex.ch 88132=15 96108=2 99830=2
#   bdlf.fr.ch 125406=12 | bgs.so.ch 95103=3 98336=5 107792=3
#   bgs.zg.ch 108288=4 108651=7 108662=3 | gdb.ow.ch 90281=5 98012=3 98196=3
#   gesetze.gl.ch 88402=2 92178=3 92644=2 | gesetze.nw.ch 107434=3
#   gesetzessammlungen.ag.ch 108417=6 108418=6 108439=6
#   srl.lu.ch 86159=2 86208=2 100781=2 | gesetzessammlung.bs.ch 101513=3 111345=3
#   gesetzessammlung.sg.ch 115110=4 121372=2 121373=2
#   gr-lex.gr.ch 118536=4 121124=4 125372=4 | lexfind.ch 379938* 386050=2 400514=3
#   notes.zh.ch 444977=3 | rechtsbuch.tg.ch 89739=7 90152=5 90625=2
#   (* 379938 later split into 10 REAL articles by the wide-gap heading fix
#      and left the clause set; its clause split had matched its enumeration)
# Misfires found by the gate and closed by guards asserted below: BS's
# left-column "§ 5." EG ZGB (93527, was 8 clause-articles from the numbered
# marginal chain), AR's road-class register (96108's visible "30." was the
# date "30. April 1972" -- month guard), GR lexfind ordinances with the
# wide-gap "Art.     1" headings (379655/379938/380538: real articles now).

CLAUSE_DECISION = """\
Kantonsratsbeschluss
betreffend den Beitritt zur Vereinbarung

(Vom 24. September 1980)

Der Kantonsrat des Kantons Schwyz beschliesst:

1. Der Kanton Schwyz tritt der Vereinbarung über die Schulkoordination bei.

2. Massgebend ist die Fassung vom 1. Januar 1980 der Vereinbarung.

3. Dieser Beschluss tritt am 1. Januar 1981 in Kraft.
"""


def test_clause_decision_splits_into_clause_articles():
    articles, text = pdf_text.split_text(CLAUSE_DECISION)
    assert [a.e_id for a in articles] == ["cl_1", "cl_2", "cl_3"]
    assert [a.article_number for a in articles] == ["1", "2", "3"]
    assert articles[0].text.startswith("Der Kanton Schwyz tritt")
    # "1. Januar 1980" mid-clause is a date, not clause 1 again; the
    # in-force clause keeps its own date too
    assert articles[1].text == "Massgebend ist die Fassung vom 1. Januar 1980 der Vereinbarung."
    assert articles[2].text.endswith("1981 in Kraft.")
    assert all(a.marginal_note is None for a in articles)
    # the preamble stays in the full text, outside every article
    assert "Kantonsratsbeschluss" in text
    assert "Kantonsratsbeschluss" not in articles[0].text


def test_clause_mode_never_fires_on_a_document_with_article_headings():
    doc = ("Verordnung\n\nArt. 1\nDie Aufsicht regelt:\n"
           "1. die Zulassung;\n2. die Gebühren.\n\nArt. 2\nSie tritt in Kraft.\n")
    articles, _ = pdf_text.split_text(doc)
    assert [a.article_number for a in articles] == ["1", "2"]
    assert not any(a.e_id.startswith("cl_") for a in articles)
    assert "1. die Zulassung" in articles[0].text


def test_clause_mode_declines_paragraph_sign_layouts_and_broken_chains():
    # BS's EG ZGB shape: numbered marginals at column 0, "§ 5." at the body
    # column -- article structure the main split missed, never clauses
    bs = ("1. Namensschutz\n                 § 5. Für Klagen ist das Gericht zuständig.\n"
          "2. Namensänderung\n                 § 6. Die Regierung entscheidet.\n")
    assert pdf_text.split_text(bs)[0] == []
    # a numbered register whose labels do not chain ("1." then "5.")
    register = ("Verzeichnis\n\n1. Klasse A der Strassen.\n\n5. Klasse B der Strassen.\n")
    assert pdf_text.split_text(register)[0] == []
    # a date is not a clause
    dated = "Beschluss\n\n1. Januar 2008: Inkrafttreten.\n2. Januar 2008: Nachtrag.\n"
    assert pdf_text.split_text(dated)[0] == []


def test_roman_clause_decision_numbers_arabically():
    doc = ("Kantonsratsbeschluss über die Wasserrechtskonzession\n\n"
           "Der Kantonsrat beschliesst:\n\nI.\nDie vorliegende Konzession wird genehmigt.\n\n"
           "II.\nDer Regierungsrat wird mit dem Vollzug beauftragt.\n")
    articles, _ = pdf_text.split_text(doc)
    assert [(a.e_id, a.article_number) for a in articles] == [("cl_1", "1"), ("cl_2", "2")]
    assert articles[0].text == "Die vorliegende Konzession wird genehmigt."


def test_wide_gap_heading_of_the_gr_lexfind_pdfs():
    # "Art.     1    Condizione di ammissione" (427.240 it): the number a
    # tab-stop away from the label, the marginal after it
    doc = ("Ordinanza sulla formazione\n\n"
           "Art.     1    Condizione di ammissione\n"
           "1 È ammesso alle formazioni di base chi soddisfa i presupposti specifici"
           " per i corsi secondo il regolamento.\n\n"
           "Art.     2    Iscrizione\n"
           "La direzione scolastica fissa un termine di iscrizione e lo rende noto"
           " a tutte le persone interessate.\n")
    articles, _ = pdf_text.split_text(doc)
    assert [(a.article_number, a.marginal_note) for a in articles] == [
        ("1", "Condizione di ammissione"), ("2", "Iscrizione")]
