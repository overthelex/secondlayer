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
