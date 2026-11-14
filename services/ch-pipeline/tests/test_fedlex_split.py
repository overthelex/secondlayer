"""chpipe.fedlex_split on synthetic pdftotext-shaped text built from the
shapes measured on prod full_texts (scripts/fedlex_pdf_gate.py, 63 pairs,
2026-08-31). The fixtures are text, not PDFs: the module's input IS the
stored full_text -- pdftotext -layout output with the form feeds already
stripped by text_extract._strip_control_characters, which is why no
fixture here contains a \\f.
"""
from chpipe import fedlex_split
from chpipe.fedlex_split import _resolve_number, split_fedlex_text

# The col0 layout of the 1999 Bundesverfassung print (560209): running
# header with the dotless SR number, footnote references glued to the
# article numbers ("Art. 12" = article 1 + note 2), the footnote block
# above the folio, an even-page folio at column 0.
COL0 = """\
Übersetzung1
                                                                              101

Bundesverfassung
der Schweizerischen Eidgenossenschaft

Angenommen in der Volksabstimmung vom 19. April 1874


Erster Abschnitt: Allgemeine Bestimmungen

Art. 12
Die durch gegenwärtigen Bund vereinigten Völkerschaften bilden in ihrer
Gesamtheit die Schweizerische Eidgenossenschaft.

Art. 2
Der Bund hat zum Zweck: Behauptung der Unabhängigkeit des Vaterlandes gegen
aussen, Handhabung von Ruhe und Ordnung im Innern.

AS 1 1; BS 1 3
1   Angenommen in der Volksabstimmung vom 19. April 1874 (AS 1 38).
2   Angenommen in der Volksabstimmung vom 24. Sept. 1978, in Kraft seit
    1. Jan. 1979 (AS 1978 1579).

                                                                                1
101                                                                Bundesverfassung


Art. 3
1 Alle Schweizer sind vor dem Gesetze gleich. Es gibt in der Schweiz keine Unterta-

nenverhältnisse, keine Vorrechte des Orts, der Geburt, der Familien oder Personen.
2 Mann und Frau sind gleichberechtigt.3


Art. 4          Grundsatz
Die Kantone sind souverän, soweit ihre Souveränität nicht durch die Bundesverfas-
sung beschränkt ist.

3   Angenommen in der Volksabstimmung vom 14. Juni 1981 (AS 1981 1243).
2
"""


def test_col0_layout_articles_furniture_and_glued_heading_footnotes():
    articles, text = split_fedlex_text(COL0)
    assert [a.article_number for a in articles] == ["1", "2", "3", "4"]
    assert [a.e_id for a in articles] == ["art_1", "art_2", "art_3", "art_4"]
    assert articles[3].marginal_note == "Grundsatz"
    # the wrap over the page seam is rejoined, the footnote block is gone
    art3 = articles[2].text
    assert "keine Unterta- nenverhältnisse" not in art3
    assert "Untertanenverhältnisse" in art3
    assert "Volksabstimmung vom 24. Sept. 1978" not in art3
    assert "1 Alle Schweizer" in art3
    # the glued reference after "gleichberechtigt.3" is stripped
    assert "gleichberechtigt." in art3 and "gleichberechtigt.3" not in art3
    # running header, folio and AS line are furniture
    assert "Bundesverfassung der" not in articles[1].text
    for a in articles:
        assert "AS 1 1" not in a.text
        assert "101" not in a.e_id


# The marginal-column layout of the post-1997 consolidations (560236): the
# body in one indented column, marginal titles in the left column across
# wrapped lines, footnote references glued to the numbers.
MARGINAL = """\
281.1
Loi fédérale
sur la poursuite pour dettes et la faillite

du 11 avril 1889 (Etat le 1er janvier 2010)


                    Titre premier: Dispositions générales

                    Art. 1
A. Arrondisse-      1 Le territoire de chaque canton forme un ou plusieurs arrondissements
ments de pour-
suite et de         de poursuite pour dettes et d'administration des faillites.
faillite4
                    2 Les cantons déterminent le nombre et l'étendue de ces arrondisse-
                    ments.

                    Art. 25
B. Offices des      1 Chaque arrondissement de poursuite est pourvu d'un office des pour-
poursuites et des
faillites           suites qui est dirigé par le préposé aux poursuites.
1. Organisation     2 Chaque arrondissement de faillite est pourvu d'un office des faillites
                    qui est dirigé par le préposé aux faillites.

RO 11 488 et RS 3 3
4   Chaque article est pourvu d'un titre marginal selon le ch. I de la LF du
    16 déc. 1994 (RO 1995 1227).
5   Nouvelle teneur selon le ch. I de la LF du 16 déc. 1994 (RO 1995 1227).

                                                                              1
281.1                                                              Poursuite


                  Art. 36
2 Rémunération    Le mode de traitement des préposés et de leurs substituts est de la
                  compétence des cantons.
"""


def test_marginal_column_layout_numbers_marginals_and_bodies():
    articles, _ = split_fedlex_text(MARGINAL)
    assert [a.article_number for a in articles] == ["1", "2", "3"]
    assert articles[0].marginal_note.startswith("A. Arrondisse")
    # the wrapped marginal keeps extending while the body flows beside it
    assert "faillite" in articles[0].marginal_note
    assert "arrondissements de poursuite" in articles[0].text
    assert "2 Les cantons déterminent" in articles[0].text
    # the mid-article sub-marginal ("1. Organisation") is not body text
    assert "Organisation" not in articles[1].text
    assert "préposé aux faillites" in articles[1].text
    # the footnote block between the pages is furniture
    assert "Nouvelle teneur" not in articles[1].text
    assert "compétence des cantons" in articles[2].text


ROMAN = """\
Traduzione1
                                                                    0.192.030

Convenzione

Conchiusa il 18 ottobre 1907


Art. I
Il territorio delle Potenze neutrali è inviolabile.

Art. II
È vietato ai belligeranti di far passare attraverso il territorio di una Potenza
neutrale truppe o convogli.

Art. V5
Una Potenza neutrale non deve tollerare sul suo territorio alcuno degli atti
menzionati.
"""


def test_roman_articles_keep_akn_shape_number_none_e_id_roman():
    articles, _ = split_fedlex_text(ROMAN)
    assert [a.e_id for a in articles] == ["art_I", "art_II", "art_V"]
    # akn.normalise_number finds no digits in a Roman number -- None on the
    # AKN side of the same acts, so None here too
    assert [a.article_number for a in articles] == [None, None, None]
    assert "inviolabile" in articles[0].text


REPEALS = """\
831.201
Règlement
sur l'assurance-invalidité

du 17 janvier 1961 (Etat le 12 janvier 1999)


Art. 1               Obligation de s'assurer
Les dispositions du chapitre premier sont applicables par analogie.

Art. 1bis5           Taux des cotisations
1 Dans les limites du barème dégressif, les cotisations sont calculées.


Art. 2
Abrogé

Art. 3 et 46

Art. 5 à 8

Art. 9 ...

Art. 10          Principe
Les assurés ont droit aux mesures de réadaptation.
"""


def test_repeal_shapes_pairs_runs_and_ellipsis():
    articles, _ = split_fedlex_text(REPEALS)
    assert [a.article_number for a in articles] == [
        "1", "1bis", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    assert articles[1].marginal_note == "Taux des cotisations"
    by_number = {a.article_number: a for a in articles}
    assert by_number["3"].text == "" and by_number["4"].text == ""
    assert by_number["7"].text == ""
    assert by_number["9"].text == ""
    assert "mesures de réadaptation" in by_number["10"].text
    assert by_number["2"].text == "Abrogé"


DECIMAL = """\
747.223.1
Ordonnance
concernant la navigation sur le lac de Constance

Arrêtée le 13 janvier 1976


Première partie: Prescriptions générales

Art. 0.01        Champ d'application
La présente ordonnance s'applique au lac de Constance.

Art. 0.02        Définitions
Dans la présente ordonnance le terme «bâtiment» désigne les bateaux.

Art. 1.01       Conducteurs
Tout bâtiment doit avoir un conducteur.
"""


def test_decimal_article_numbers_of_the_technical_ordinances():
    articles, _ = split_fedlex_text(DECIMAL)
    assert [a.article_number for a in articles] == ["0.01", "0.02", "1.01"]
    # the AKN parse of the same act keys these art_0_01 ... (measured on
    # version 564195); the e_id follows so the two eras key alike
    assert [a.e_id for a in articles] == ["art_0_01", "art_0_02", "art_1_01"]


def test_resolve_number_sequence_disambiguates_glued_footnotes():
    # "Art. 12" after article 1 is 1+note 2; after article 11 it is 12
    assert _resolve_number("12", 1)[0] == "12"   # a jump, never a duplicate "1"
    assert _resolve_number("12", 11)[0] == "12"
    # three-digit notes: "Art. 33103" = 33 + note 103 (seen on 561767)
    assert _resolve_number("33103", 32)[0] == "33"
    # letters end the number, everything after is the note: "1bis5", "4a8"
    assert _resolve_number("1bis5", 1) == ("1bis", 1)
    assert _resolve_number("4a8", 4) == ("4a", 4)
    assert _resolve_number("30bis97", 30) == ("30bis", 30)
    # runs and pairs, with a glued note on the right end
    assert _resolve_number("15 et 1637", 14) == ("15+16", 16)
    assert _resolve_number("91 a 94 ", 90) is None      # trailing junk: no match
    assert _resolve_number("91 a 94153"[:8], 90)[0] == "91-94"
    assert _resolve_number("2–311", 1) == ("2-3", 3)
    # French first article
    assert _resolve_number("premier", 0) == ("1", 1)
    # a number that only goes backwards is not a heading
    assert _resolve_number("3", 40) is None


def test_no_articles_in_an_unstructured_note():
    text = ("412.101.220.77\nOrdinanza\nsulla formazione professionale\n\n"
            "del 12 dicembre 2007\n\nEntrata in vigore: 1° febbraio 2008\n")
    articles, _ = split_fedlex_text(text)
    assert articles == []


def test_citation_at_column_zero_is_not_a_heading():
    text = ("101\nGesetz\nüber etwas\n\nArt. 1\nDer Kanton regelt die "
            "Aufsicht. Die Einzelheiten richten sich nach\n"
            "Art. 45 Abs. 2  der Verordnung vom 1. Januar.\n")
    articles, _ = split_fedlex_text(text)
    assert [a.article_number for a in articles] == ["1"]
    assert "Art. 45" in articles[0].text


# A page whose running header was NOT recognised: the footnote block of the
# previous page sits mid-stream, between two articles, in the col0 layout;
# a 3-digit reference is glued to a word; a table row and a two-space
# paragraph number must survive.
MIDSTREAM = """\
                                                                              281.1

Bundesgesetz
über Schuldbetreibung und Konkurs

Art. 1
1 In der einem Erben für die Erklärung über den Erwerb der Erbschaft
eingeräumten Überlegungsfrist besteht Rechtsstillstand.102
2 Eine zu Lebzeiten des Erblassers angehobene Betreibung kann fortgesetzt
werden.

AS 1889 III 1
99  Fassung gemäss Ziff. I des BG vom 16. Dez. 1994, in Kraft seit 1. Jan. 1997
    (AS 1995 1227; BBl 1991 III 1).
100 Eingefügt durch Ziff. I des BG vom 16. Dez. 1994, in Kraft seit 1. Jan. 1997
    (AS 1995 1227; BBl 1991 III 1).
101 Fassung gemäss Ziff. I des BG vom 16. Dez. 1994, in Kraft seit 1. Jan. 1997
    (AS 1995 1227; BBl 1991 III 1).
102 Eingefügt durch Ziff. I des BG vom 16. Dez. 1994, in Kraft seit 1. Jan. 1997
    (AS 1995 1227; BBl 1991 III 1).

Art. 2
Wird ein Schuldner verhaftet, so kann er die Betreibung bestreiten.
31  70,46 72,73 72,73
2  Mann und Frau sind gleichberechtigt.
Das gilt auch für Bürgschaften.
"""


def test_a_footnote_block_in_mid_stream_is_removed_and_three_digit_refs_stripped():
    articles, _ = split_fedlex_text(MIDSTREAM)
    assert [a.article_number for a in articles] == ["1", "2"]
    art59, art60 = articles[0].text, articles[1].text
    assert "Fassung gemäss" not in art59 and "Eingefügt durch" not in art59
    assert "AS 1889" not in art59 and "BBl 1991" not in art59
    assert "Rechtsstillstand." in art59 and "Rechtsstillstand.102" not in art59
    assert "fortgesetzt werden." in art59
    # a table row and a paragraph number set with two spaces are not footnotes
    assert "31 70,46 72,73 72,73" in art60
    assert "2 Mann und Frau sind gleichberechtigt." in art60


MARGINAL_MIDSTREAM = """\
Schweizerisches Zivilgesetzbuch                                             210

                Art. 268a
A. Adoption     1 Die Adoption darf erst nach umfassender Untersuchung aller
                wesentlichen Umstände ausgesprochen werden.
                2 Namentlich ist die Einstellung zur Adoption zu würdigen.

61    Fassung gemäss Ziff. I 1 des BG vom 25. Juni 1976, in Kraft seit 1. Jan. 1978 (AS 1977
      237 264; BBl 1974 II 1).
62    Fassung gemäss Ziff. I 1 des BG vom 25. Juni 1976, in Kraft seit 1. Jan. 1978
      (AS 1977 237 264; BBl 1974 II 1).

                Art. 268b
B. Wirkung      Das Kind erhält die Rechtsstellung eines Kindes der Adoptiv-
                eltern.
"""


def test_marginal_layout_footnote_block_does_not_leak_into_the_body():
    articles, _ = split_fedlex_text(MARGINAL_MIDSTREAM)
    assert [a.article_number for a in articles] == ["268a", "268b"]
    assert "gemäss" not in articles[0].text and "BBl" not in articles[0].text
    assert "würdigen." in articles[0].text
    assert articles[1].text.startswith("Das Kind erhält")


# --- the text product (Task 2 of the CH text cleanup) ------------------------
# The splitter's second return value is the whole clean document; the
# articles must not move by one byte. Golden captures below were taken from
# the splitter at 03ae9520, BEFORE the text product existed.

import json
import re
from pathlib import Path

from chpipe.fedlex_split import clean_fedlex_text

_FIXTURES = Path(__file__).parent / "fixtures"

# chars 19,000-22,000 of the SR 220 de 2020-04-01 edition (version_id 610366):
# marginal-column layout, a running header ("Ergänzung des Schweizerischen
# Zivilgesetzbuches. BG   220") and a folio ("8") at a page seam that the
# furniture strip does not catch (the cut has no SR number at its head).
SR220_MARGINAL = (_FIXTURES / "pdftext_fedlex_sr220_marginal.txt").read_text()

# SchKG SR 281.1 de 2020-01-01 (version_id 560275): pages 1-5 (Art. 1-12),
# the page holding Art. 37-39 and the one holding Art. 78-80, cut from the
# stored full_text. Marginal-column layout whose body column drifts from
# column 15 to 22 between pages and inside a page (pdftotext -layout), and
# whose marginal titles wrap over up to five lines -- the 2026-11 pilot spliced
# "rung von Geld" / "oder Wertsachen" into the Art. 9 body here.
SCHKG_DE = (_FIXTURES / "pdftext_fedlex_schkg_281_1_de_margins.txt").read_text()
# LP RS 281.1 fr 1996-07-01 (version_id 560212): pages 1-3 (Art. 1-9).
SCHKG_FR = (_FIXTURES / "pdftext_fedlex_schkg_281_1_fr_margins.txt").read_text()
# Cst 1874 RS 101 fr (version_id 560210): the head and the page of the
# transitional Art. 19-21, whose fee table ends right above the page's
# footnote block ("c. pour les autocars      650"), then the next page's
# running header.
CST_FEE_ROWS = (_FIXTURES / "pdftext_fedlex_cst_101_fr_fee_rows.txt").read_text()
# Cst 1874 RS 101 fr (version_id 560210): the head and two pages of Art.
# 41bis/41ter with footnotes 88-98. Their continuation lines hang at column
# 9-10 (deeper than the page strip's 2-8) and their text opens with
# "Accepté en votation populaire", which the shared vocabulary lacks: the
# shared strips miss these blocks, so they stay in the article stream.
CST_FOOTNOTES = (_FIXTURES / "pdftext_fedlex_cst_101_fr_footnotes_93_98.txt").read_text()
# The shape of RS 0.515.102 fr (version_id 560289): a treaty's scope table
# whose last row ("Turquie ... 1907") stands right above the page's footnote
# block -- the shape of a missed running header ("title   number") at a
# page seam, with no folio, no SR number and no repetition to back it.
TREATY_TABLE = """\
0.515.102
Convention
concernant les droits et les devoirs des Puissances neutrales

Conclue le 18 octobre 1907

Art. 1
Le territoire des Puissances neutres est inviolable.

Champ d’application le 1er janvier 20204
Thaïlande                                 4 septembre     1900          4 septembre        1900
Turquie                                  12 juin          1907         12 juin             1907




4     Une version du champ d’application mise à jour est publiée sur le site web du DFAE

                                                                                        3
0.515.102                                                                       Neutralité


Art. 2
Il est interdit aux belligérants de faire passer à travers le territoire d’une Puissance
neutre des troupes.
"""

# (e_id, article_number, marginal_note, text, ordinal) of COL0, captured from
# the old splitter.
EXPECTED_COL0_ARTICLES = [
    ("art_1", "1", None, "Die durch gegenwärtigen Bund vereinigten Völkerschaften bilden in "
     "ihrer Gesamtheit die Schweizerische Eidgenossenschaft.", 0),
    ("art_2", "2", None, "Der Bund hat zum Zweck: Behauptung der Unabhängigkeit des Vaterlandes "
     "gegen aussen, Handhabung von Ruhe und Ordnung im Innern.", 1),
    ("art_3", "3", None, "1 Alle Schweizer sind vor dem Gesetze gleich. Es gibt in der Schweiz "
     "keine Untertanenverhältnisse, keine Vorrechte des Orts, der Geburt, der Familien oder "
     "Personen. 2 Mann und Frau sind gleichberechtigt.", 2),
    ("art_4", "4", "Grundsatz", "Die Kantone sind souverän, soweit ihre Souveränität nicht "
     "durch die Bundesverfassung beschränkt ist.", 3),
]

_NOTE = ("412.101.220.77\nOrdinanza\nsulla formazione professionale\n\n"
         "del 12 dicembre 2007\n\nEntrata in vigore: 1° febbraio 2008\n")
_CITATION = ("101\nGesetz\nüber etwas\n\nArt. 1\nDer Kanton regelt die "
             "Aufsicht. Die Einzelheiten richten sich nach\n"
             "Art. 45 Abs. 2  der Verordnung vom 1. Januar.\n")
_GOLDEN_INPUTS = {
    "COL0": COL0, "MARGINAL": MARGINAL, "ROMAN": ROMAN, "REPEALS": REPEALS,
    "DECIMAL": DECIMAL, "MIDSTREAM": MIDSTREAM, "MARGINAL_MIDSTREAM": MARGINAL_MIDSTREAM,
    "NOTE": _NOTE, "CITATION": _CITATION, "SR220_MARGINAL": SR220_MARGINAL,
    "SCHKG_DE": SCHKG_DE, "SCHKG_FR": SCHKG_FR,
    "CST_FEE_ROWS": CST_FEE_ROWS, "TREATY_TABLE": TREATY_TABLE,
    "CST_FOOTNOTES": CST_FOOTNOTES,
}


def _rows(articles):
    return [[a.e_id, a.article_number, a.marginal_note, a.text, a.ordinal, a.parent_e_id]
            for a in articles]


def test_text_keeps_preamble_and_tail():
    _, text = split_fedlex_text(COL0)
    assert text.startswith("Bundesverfassung\nder Schweizerischen Eidgenossenschaft")
    assert "Angenommen in der Volksabstimmung vom 19. April 1874" in text
    assert "Erster Abschnitt: Allgemeine Bestimmungen" in text
    assert "AS 1 1; BS 1 3" not in text                 # the publication line is furniture
    assert "Übersetzung1" not in text and "\n1\n" not in text
    # headings and bodies in reading order, paragraphs one blank line apart
    assert "Art. 4 Grundsatz\n\nDie Kantone sind souverän" in text
    assert "Untertanenverhältnisse" in text
    assert "\n\n\n" not in text


def test_text_marginal_layout_drops_margin_and_joins_hyphens():
    _, text = split_fedlex_text(SR220_MARGINAL)
    assert "Art. 34" in text
    after = text.split("Art. 34", 1)[1]
    body = after.split("\n\n", 2)[1]            # the paragraph after the heading line
    assert "2. Auf Grund" not in body                   # marginal column not spliced in
    # ruling R15: every marginal title level is kept, one per heading line
    assert "Art. 34 2. Auf Grund von Rechtsgeschäft\na. Beschränkung und Widerruf\n\n1 Eine" in text
    assert "Art. 35 b. Einfluss von Tod, Handlungsunfähigkeit u.a.\n\n1 Die" in text
    assert "1. Im Allgemeinen\na. Wirkung der Vertretung" in text
    assert "Ergänzung des Schweizerischen Zivilgesetzbuches. BG" not in text
    assert "izerischen Zivilgesetzbuches" not in text
    assert "mitgeteilt, so beurteilt" in text           # "mit-\ngeteilt" joined
    assert "\n8\n" not in text and not text.startswith("8\n")


def test_text_paragraph_numbers_start_paragraphs():
    _, text = split_fedlex_text(SR220_MARGINAL)
    assert "\n\n2 Ist die Ermächtigung durch Rechtsgeschäft eingeräumt" in text
    assert "\n\n3 Wird die Ermächtigung" in text


def test_text_drops_bare_number_lines_outside_articles_without_sysnr():
    raw = "Gesetz\nüber etwas\n\n12\n\nEinleitung des Gesetzes\n"
    text = clean_fedlex_text(raw)
    assert text == "Gesetz\nüber etwas\n\nEinleitung des Gesetzes"


def test_text_keeps_everything_after_the_tail_break():
    raw = ("Gesetz\n\nArt. 1\nDer Kanton regelt.\n\nDatum des Inkrafttretens: 1. Januar 2001\n"
           "Anhang 1\nListe der Ämter\n")
    articles, text = split_fedlex_text(raw)
    assert [a.text for a in articles] == ["Der Kanton regelt."]
    assert text.endswith("Datum des Inkrafttretens: 1. Januar 2001\n\nAnhang 1\nListe der Ämter")


def test_text_hyphen_vocabulary_by_language():
    # "contre" and "partie" are both fr words, "contrepartie" is not in the
    # wordlist: with the fr vocabulary the hyphen is real and kept
    raw = "Loi\n\nArt. 1\nLa contre-\npartie est due.\n"
    assert "La contrepartie est due." in clean_fedlex_text(raw)
    assert "La contre-partie est due." in clean_fedlex_text(raw, "fr")
    assert clean_fedlex_text(raw) != clean_fedlex_text(raw, "fr")
    # a plain wrap is joined either way
    _, text = split_fedlex_text(MARGINAL, "fr")
    assert "arrondissements de poursuite" in text
    assert clean_fedlex_text(COL0) == split_fedlex_text(COL0)[1]


def test_text_printed_heading_keeps_connectors_and_repeal_markers():
    # ruling R16: the printed heading, number tokens footnote-stripped
    text = clean_fedlex_text(REPEALS, "fr")
    assert "Art. 9 ..." in text
    assert "Art. 3 et 4" in text
    assert "Art. 5 à 8" in text
    assert "Art. 1bis Taux des cotisations" in text      # "Art. 1bis5": note 5 gone
    assert "\n\nArt. 1\n\nDie durch" in clean_fedlex_text(COL0)   # "Art. 12" = 1 + note 2
    assert "Art. 12" not in clean_fedlex_text(COL0)


def test_text_marginal_sub_titles_are_heading_lines():
    text = clean_fedlex_text(MARGINAL, "fr")
    assert "Art. 1 A. Arrondissements de poursuite et de faillite\n\n1 Le territoire" in text
    assert "Art. 2 B. Offices des poursuites et des faillites\n1. Organisation\n\n1 Chaque" in text


# Marginal layout with fee rows (title, wide gap, amount) inside an article
# and in an annex: the running-header shape, but neither at a page seam, nor
# recurring, nor the SR number -- they must survive. The real missed header
# sits at a seam (folio, blank run) and goes.
FEES = """                  Art. 1
A. Gebühren       1 Die Gebühren betragen:
Grundgebühr für die Erteilung einer Bewilligung      300
Zuschlag für jede weitere Bewilligung im Jahr        150
                  2 Die Gebühr wird mit der Verfügung erhoben.

                  Art. 2
B. Fälligkeit     Die Gebühr ist innert 30 Tagen zu bezahlen.

4
Verordnung über die Gebühren                                              172.041


                  Art. 3
C. Inkrafttreten  Diese Verordnung tritt am 1. Januar 2001 in Kraft.

Anhang
Tarif
Gebühr für eine Kopie          10
Gebühr für eine Beglaubigung   20
"""


def test_text_fee_rows_kept_missed_header_dropped():
    articles, text = split_fedlex_text(FEES)
    assert [a.article_number for a in articles] == ["1", "2", "3"]
    assert "Grundgebühr für die Erteilung einer Bewilligung 300" in text
    assert "Zuschlag für jede weitere Bewilligung im Jahr 150" in text
    assert "Verordnung über die Gebühren" not in text
    assert "\n4\n" not in text


def test_text_marginal_layout_tail_break_and_annex_rows_kept():
    _, text = split_fedlex_text(FEES)
    assert text.endswith("Anhang\nTarif\nGebühr für eine Kopie 10\nGebühr für eine Beglaubigung 20")
    assert "Art. 3 C. Inkrafttreten\n\nDiese Verordnung tritt" in text


def test_articles_unchanged_by_text_product():
    rows = [(a.e_id, a.article_number, a.marginal_note, a.text, a.ordinal)
            for a in split_fedlex_text(COL0)[0]]
    assert rows == EXPECTED_COL0_ARTICLES


def test_articles_equal_golden_capture_on_every_fixture():
    golden = json.loads((_FIXTURES / "fedlex_split_golden_articles.json").read_text())
    assert set(golden) == set(_GOLDEN_INPUTS)
    for name, raw in _GOLDEN_INPUTS.items():
        assert _rows(split_fedlex_text(raw)[0]) == golden[name], name
        for lang in ("de", "fr", "it"):
            assert _rows(split_fedlex_text(raw, lang)[0]) == golden[name], (name, lang)


def test_text_product_equals_the_golden_capture_on_every_fixture():
    # the text product (second return value) for every fixture x lang, a
    # regression net for the full resplit. Captured at 375d1595 (ruling
    # R27) and re-captured by the 2026-11 margins/footnotes fix, which
    # changed the text product on purpose (the articles did not move: see
    # the golden test above)
    golden = json.loads((_FIXTURES / "fedlex_split_golden_text.json").read_text())
    assert set(golden) == set(_GOLDEN_INPUTS)
    for name, raw in _GOLDEN_INPUTS.items():
        assert split_fedlex_text(raw)[1] == golden[name][""], name
        for lang in ("de", "fr", "it"):
            assert split_fedlex_text(raw, lang)[1] == golden[name][lang], (name, lang)


# --- the marginal column and the footnotes (2026-11 pilot defects) -----------

def _lines(text):
    return text.split("\n")


def test_marginal_column_of_art_9_is_not_spliced_into_the_body():
    text = clean_fedlex_text(SCHKG_DE, "de")
    assert ("Art. 9 F. Aufbewahrung von Geld oder Wertsachen\n\n"
            "Die Betreibungs- und die Konkursämter haben Geldsummen, Wertpapiere "
            "und Wertsachen, über welche nicht binnen drei Tagen nach dem Eingange "
            "verfügt wird, der Depositenanstalt zu übergeben.") in text
    for line in _lines(text):
        assert "Wert- oder" not in line and "Wertsachen papiere" not in line
        assert "rung von Geld" not in line or line.startswith("Art. 9 F.")


def test_marginal_titles_wrapping_over_several_lines_stay_whole():
    text = clean_fedlex_text(SCHKG_DE, "de")
    assert ("Art. 38 A. Gegenstand der Schuldbetreibung und Betreibungsarten\n\n"
            "1 Auf dem Wege der Schuldbetreibung werden die Zwangsvollstreckungen "
            "durchgeführt, welche auf eine Geldzahlung oder eine Sicherheitsleistung "
            "gerichtet sind.") in text
    assert ("Art. 79 D. Beseitigung des Rechtsvorschlages\n"
            "1. Im Zivilprozess oder im Verwaltungsverfahren\n\n"
            "Ein Gläubiger, gegen dessen Betreibung Rechtsvorschlag erhoben worden ist, "
            "hat seinen Anspruch im Zivilprozess oder im Verwaltungsverfahren geltend "
            "zu machen. Er kann die Fortsetzung der Betreibung nur aufgrund eines "
            "vollstreckbaren Entscheids erwirken, der den Rechtsvorschlag ausdrücklich "
            "beseitigt.") in text
    # the body column at 17 on two lines and 19 on the next (one page)
    assert ("Art. 8 E. Protokolle und Register\n1. Führung, Beweiskraft und Berichtigung"
            "\n\n1 Die Betreibungs- und die Konkursämter führen über ihre Amtstätigkeiten "
            "sowie die bei ihnen eingehenden Begehren und Erklärungen Protokoll; "
            "sie führen die Register.") in text
    # a marginal fragment glued to the body by ONE space ("Sachwalterbe- 1 Vor"),
    # the body at column 15 on the heading's line and 19 below it
    assert ("Art. 304 H. Sachwalterbericht; öffentliche Bekanntmachung der Verhandlung "
            "vor dem Nachlassgericht\n\n1 Vor Ablauf der Stundung unterbreitet der "
            "Sachwalter dem Nachlassgericht alle Aktenstücke. Er orientiert in seinem "
            "Bericht über bereits erfolgte Zustimmungen und empfiehlt die Bestätigung "
            "oder Ablehnung des Nachlassvertrages.") in text
    assert "Art. 10 G. Ausstandspflicht\n\n1 Die Beamten" in text


def test_marginal_column_fr():
    text = clean_fedlex_text(SCHKG_FR, "fr")
    assert ("Art. 9 F. Dépôt d'espèces et d'objets de prix\n\n"
            "Les offices de poursuites et de faillites sont tenus de consigner à la "
            "caisse des dépôts et consignations les sommes, valeurs et objets de prix "
            "dont ils n'ont pas emploi dans les trois jours.") in text
    assert "Art. 1 A. Arrondissements de poursuite et de faillite\n\n" in text


def test_footnotes_are_kept_one_per_paragraph_after_the_article():
    text = clean_fedlex_text(SCHKG_DE, "de")
    # page 4's notes follow Art. 9, the article the page ended in
    assert ("der Depositenanstalt zu übergeben.\n\n"
            "13 Eingefügt durch Ziff. I des BG vom 16. Dez. 1994, in Kraft seit "
            "1. Jan. 1997 (AS 1995 1227; BBl 1991 III 1).\n\n"
            "14 Ausdruck gemäss Anhang 1 Ziff. II 17 der Zivilprozessordnung vom "
            "19. Dez. 2008, in Kraft seit 1. Jan. 2011 (AS 2010 1739; BBl 2006 7221)."
            "\n\n15 Eingefügt durch Ziff. I des BG vom 16. Dez. 2016") in text
    # a wrap hyphen inside a footnote is joined
    assert ("10 Fassung gemäss Anhang Ziff. 4 des BG vom 15. Juni 2018 (Revision des "
            "Verjährungsrechts), in Kraft seit 1. Jan. 2020") in text
    # every footnote of the excerpt is there, each opening its own paragraph
    heads = re.findall(r"^(\d{1,3}) +(\S+ \S+)", SCHKG_DE, re.MULTILINE)
    assert len(heads) == 35
    for number, words in heads:
        assert f"\n\n{number} {words}" in text, number
    # the publication line and the running headers are still furniture
    assert "AS 11 529 und BS 3 3" not in text
    assert "Ordentliches Verfahren bei Schuldbetreibung und Konkurs" not in text


def test_footnotes_fr():
    text = clean_fedlex_text(SCHKG_FR, "fr")
    assert ("\n\n12 Introduit par le ch. I de la LF du 16 déc. 1994, en vigueur depuis "
            "le 1er janv. 1997 (RO 1995 1227 1309; FF 1991 III 1).") in text
    assert "\n\n2 RS 101" in text


def test_footnotes_kept_in_the_col0_layout():
    text = clean_fedlex_text(COL0)
    assert ("\n\n2 Angenommen in der Volksabstimmung vom 24. Sept. 1978, in Kraft seit "
            "1. Jan. 1979 (AS 1978 1579).") in text
    assert "\n\n3 Angenommen in der Volksabstimmung vom 14. Juni 1981 (AS 1981 1243)." in text
    assert "AS 1 1; BS 1 3" not in text


def test_footnotes_found_mid_stream_are_kept_too():
    _, text = split_fedlex_text(MIDSTREAM)
    assert "Fassung gemäss" in text and "Eingefügt durch" in text
    _, text = split_fedlex_text(MARGINAL_MIDSTREAM)
    assert ("61 Fassung gemäss Ziff. I 1 des BG vom 25. Juni 1976, in Kraft seit "
            "1. Jan. 1978 (AS 1977 237 264; BBl 1974 II 1).") in text


def test_column_zero_text_no_column_owns_is_kept():
    # ruling R28: a full-width line in the marginal layout (the preamble,
    # a line pdftotext set from column 0 across the column boundary) is kept
    # whole, never cut into a margin and a body -- and in its place: a short
    # column-0 line ("beschliesst:") with no body beside it is no marginal
    # fragment, so it is not hoisted above the lines before it
    preamble = ("Die Bundesversammlung der Schweizerischen Eidgenossenschaft,\n"
                "gestützt auf Artikel 64 der Bundesverfassung (BV),\n"
                "beschliesst:\n\nErster Titel: Allgemeine Bestimmungen")
    assert preamble in clean_fedlex_text(SCHKG_DE, "de")
    # a double space near the body column inside such a line cuts nothing
    spaced = SCHKG_DE.replace("gestützt auf Artikel 64", "gestützt auf  Artikel 64")
    assert preamble in clean_fedlex_text(spaced, "de")


# --- R28 at page seams: a table row is not a running header ------------------

def test_last_table_row_before_the_footnote_block_is_kept():
    # 560289: the scope table's last row looks like "title   number" at a
    # seam; only the SR number, a folio, a publication line or a repeat on
    # two pages may make a line furniture
    text = clean_fedlex_text(TREATY_TABLE, "fr")
    assert "Turquie 12 juin 1907 12 juin 1907" in text
    assert "Thaïlande 4 septembre 1900 4 septembre 1900" in text
    assert "Neutralité" not in text                 # the real running header
    assert "\n\n4 Une version du champ d’application mise à jour" in text


def test_last_fee_row_before_the_footnote_block_is_kept():
    # 560210: "c. pour les autocars   650" above footnote 179
    text = clean_fedlex_text(CST_FEE_ROWS, "fr")
    assert "c. pour les autocars 650" in text
    assert "– de plus de 10 tonnes 2000" in text
    assert "Constitution fédérale 101" not in text    # running header still dropped
    assert "\n\n179 Accepté en votation populaire du 23 sept. 1990" in text


def test_missed_header_next_to_a_folio_is_still_dropped():
    # the SR220 excerpt (no SR number learnt) and FEES: the header shape
    # beside a folio is a page seam, the folio is the corroboration
    assert "Ergänzung des Schweizerischen" not in clean_fedlex_text(SR220_MARGINAL)
    assert "Verordnung über die Gebühren" not in clean_fedlex_text(FEES)


# --- footnote heads that read like headers; footnotes the strips miss -------

# two footnotes whose wording repeats: the number-first header shape
# ("93        Accepté ...") must not make them a recurring running header
REPEATED_NOTES = ("101\nConstitution\n\nArt. 1\nPremier texte.\n\n"
                  "1        Accepté en votation populaire du 28 nov. 1993 (ACF du 27 janv. 1994\n"
                  "         - RO 1994 268).\n\nArt. 2\nSecond texte.\n\n"
                  "2        Accepté en votation populaire du 28 nov. 1993 (ACF du 27 janv. 1994\n"
                  "         - RO 1994 270).")


def test_repeated_footnote_heads_are_not_running_headers():
    text = clean_fedlex_text(REPEATED_NOTES, "fr")
    assert "Premier texte. - RO" not in text
    assert ("\n\n1 Accepté en votation populaire du 28 nov. 1993 (ACF du 27 janv. 1994 "
            "- RO 1994 268).") in text
    assert ("\n\n2 Accepté en votation populaire du 28 nov. 1993 (ACF du 27 janv. 1994 "
            "- RO 1994 270).") in text


def test_footnotes_the_strips_miss_leave_the_sentence():
    # 560210 Art. 9: the page's only footnote between the two halves of a
    # sentence ("les rapports de" / page seam / "voisinage et de police")
    raw = ("101\nConstitution fédérale\n\nArt. 9\n"
           "Exceptionnellement, les cantons conservent le droit de conclure des traités\n"
           "sur des objets concernant l’économie publique, les rapports de\n\n"
           "3        Accepté en votation populaire du 14 juin 1981 (ACF du 17 août 1981 – RO 1981 1243 –\n"
           "         et AF du 10 oct. 1980– FF 1980 III 713 787, 1980 I 73, 1981 II 1216).\n\n\n\n"
           "voisinage et de police; néanmoins, ces traités ne doivent rien contenir de contraire à\n"
           "la Confédération.\n\nArt. 10\n1 Les rapports officiels ont lieu par le Conseil fédéral.\n")
    articles, text = split_fedlex_text(raw, "fr")
    assert "3 Accepté" in articles[0].text                # the articles do not move
    assert "les rapports de voisinage et de police; néanmoins" in text
    assert ("la Confédération.\n\n3 Accepté en votation populaire du 14 juin 1981 (ACF du "
            "17 août 1981 – RO 1981 1243 – et AF du 10 oct. 1980– FF 1980 III 713 787, "
            "1980 I 73, 1981 II 1216).\n\nArt. 10") in text


def test_bv_1874_footnote_block_is_footnotes_not_prose():
    text = clean_fedlex_text(CST_FOOTNOTES, "fr")
    for number in range(88, 99):
        heads = re.findall(r"(?:^|\n\n)%d (?:Accepté|Phrase)" % number, text)
        assert len(heads) == 1, number
    # every footnote's text is there as often as in the raw
    for ref in ("RO 1994 268", "RO 1994 262", "RO 1982 140", "RO 1994 266"):
        assert text.count(ref) == CST_FOOTNOTES.count(ref), ref
    # and no footnote is glued into a sentence
    for m in re.finditer(r"Accepté en votation populaire", text):
        assert re.search(r"(?:^|\n\n)\d{1,3} $", text[:m.start()]), text[m.start() - 60:m.start()]
