"""The proposition parser, against the shapes the instrument actually uses.

Each case here is one the real texts produced: the 2002 notice sets its
heading on the line after "Ziffer 1" and bullets its recitals, 2007 numbers
recitals "(1)" and subparagraphs "(1)" as well, 2022 numbers subparagraphs
with a bare digit and lists its hardcore restrictions with letters.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from propositions import align, columns, dehyphenate, parse, similarity  # noqa: E402


def pids(props):
    return [p.pid for p in props]


def test_roman_recitals_and_units_with_headings():
    text = """
    I.   Gemäss Artikel 6 KG kann die Wettbewerbskommission Bekanntmachungen erlassen.
    II.  Vertikale Vereinbarungen können die Effizienz erhöhen.

Ziffer 1        Vertikale Wettbewerbsabreden
Als vertikale Wettbewerbsabreden gelten Abreden zwischen Unternehmen verschiedener Marktstufen.
"""
    props = parse(text, "v")
    assert [(p.part, p.pid) for p in props] == [("preamble", "I"), ("preamble", "II"), ("operative", "1")]
    assert props[2].heading == "Vertikale Wettbewerbsabreden"
    assert props[0].text.startswith("Gemäss Artikel 6 KG")


def test_a_citation_in_a_recital_is_not_a_unit_heading():
    """"Artikel 6 KG auch andere Grundsätze ..." inside recital I used to read
    as the heading of article 6 and swallowed the whole preamble."""
    text = """
    I.   Gemäss Artikel 6 des Bundesgesetzes kann sie in analoger Anwendung von
         Artikel 6 KG auch andere Grundsätze der Rechtsanwendung in allgemeinen
         Bekanntmachungen veröffentlichen.
    II.  Zweiter Erwägungsgrund.

Artikel 1      Vertikale Wettbewerbsabreden
Text der Regel.
"""
    props = parse(text, "v")
    assert [(p.part, p.pid) for p in props] == [("preamble", "I"), ("preamble", "II"), ("operative", "1")]


def test_the_2002_shape_bullets_and_a_heading_on_the_next_line():
    text = """
Beschluss der Wettbewerbskommission vom 18. Februar 2002
?? Gemäss Artikel 6 KG kann die Wettbewerbskommission in allgemeinen
   Bekanntmachungen die Voraussetzungen umschreiben.
?? Die vorliegende Bekanntmachung soll verdeutlichen, unter welchen
   Voraussetzungen eine Abrede erheblich ist.

Ziffer 1
Vertikale Wettbewerbsabreden
Als vertikale Wettbewerbsabreden gelten erzwingbare oder nicht erzwingbare Vereinbarungen.
"""
    props = parse(text, "v")
    assert [(p.part, p.pid) for p in props] == [("preamble", "1"), ("preamble", "2"), ("operative", "1")]
    assert props[2].heading == "Vertikale Wettbewerbsabreden"
    assert props[2].text.startswith("Als vertikale Wettbewerbsabreden gelten")


def test_subparagraphs_in_both_numbering_styles():
    until_2017 = """
Ziffer 8        Geltungsbereich
(1) Diese Bekanntmachung gilt für vertikale Wettbewerbsabreden.
(2) Sie findet auch Anwendung auf Empfehlungen.
"""
    from_2022 = """
Artikel 10      Geltungsbereich
1 Diese Bekanntmachung gilt für vertikale Wettbewerbsabreden.
2 Sie findet auch Anwendung auf Empfehlungen.
"""
    assert pids(parse(until_2017, "a")) == ["8(1)", "8(2)"]
    assert pids(parse(from_2022, "b")) == ["10(1)", "10(2)"]


def test_lettered_points_are_propositions_and_the_chapeau_is_not():
    text = """
Artikel 12      Vermutungstatbestände
1 Bei vertikalen Wettbewerbsabreden wird die Beseitigung wirksamen Wettbewerbs vermutet,
wenn sie Folgendes zum Gegenstand haben:
a)   Festsetzung von Mindest- oder Festpreisen;
b)   Zuweisung von Gebieten, soweit Verkäufe in diese ausgeschlossen werden.
2 Artikel 5 Absatz 4 KG umfasst auch indirekte Abreden.
"""
    props = parse(text, "v")
    assert pids(props) == ["12(1a)", "12(1b)", "12(2)"]      # the chapeau states no rule alone
    assert props[0].text.startswith("Festsetzung von Mindest-")


def test_a_footnote_is_not_a_subparagraph():
    text = """
Artikel 1      Vertikale Wettbewerbsabreden
1 Als vertikale Wettbewerbsabreden gelten Abreden zwischen Unternehmen verschiedener Stufen.
1 SR 251
2 Vgl. RPW 2010/1, S. 1.
"""
    props = parse(text, "v")
    assert pids(props) == ["1(1)"]
    assert "SR 251" not in props[0].text and "RPW 2010/1" not in props[0].text


def test_dehyphenation_and_column_reconstruction():
    assert dehyphenate("Wettbewerbsabre-\nden sind") == "Wettbewerbsabreden sind"
    two_columns = "\n".join(
        f"links {i} hier steht der linke Text        rechts {i} und hier der rechte" for i in range(8))
    fixed = columns(two_columns)
    assert fixed.index("links 7") < fixed.index("rechts 0")     # left column first, then right
    assert columns("eine einzige Spalte ohne Lücken") == "eine einzige Spalte ohne Lücken"


def test_similarity_is_word_level_with_autojunk_off():
    """Character-level difflib with its default heuristic scored two texts of
    the same recital at 0.178; over 200 characters it treats every frequent
    character as junk, which in German is most of them."""
    a = ("Der Gesetzgeber hat in der KG-Revision 2003 zum Ausdruck gebracht, dass er die Festsetzung "
         "von Mindest- und Festpreisen sowie gebietsabschottende Klauseln als besonders schädlich "
         "erachtet und die Wettbewerbskommission diese Einschätzung konkretisiert hat.")
    b = a.replace("besonders schädlich", "potenziell besonders schädlich")
    assert similarity(a, b) > 0.9
    assert similarity(a, "Ein völlig anderer Satz über Meldeformulare und Fristen.") < 0.3


def test_alignment_follows_a_proposition_through_a_renumbering():
    rule = ("Als vertikale Wettbewerbsabreden gelten Abreden zwischen Unternehmen verschiedener "
            "Marktstufen über den Bezug oder Vertrieb von Waren.")
    old = f"""
Ziffer 1       Vertikale Wettbewerbsabreden
{rule}
"""
    new = f"""
Artikel 3      Vertikale Wettbewerbsabreden
{rule} Erfasst sind auch Empfehlungen.
"""
    tracks = align({"old": parse(old, "old"), "new": parse(new, "new")}, ["old", "new"])
    assert len(tracks) == 1                                  # one proposition, not one gone and one new
    assert tracks[0].per_version["new"]["status"] == "reworded"
    assert tracks[0].per_version["new"]["pid"] == "3"


import propositions  # noqa: E402


def test_the_french_version_printed_after_the_german_is_not_read_as_more_ziffern():
    german = "\n".join(["Ziffer 1", "Begriff", "Als vertikale Abreden gelten Vereinbarungen."]
                       + ["Weiterer Text des Erlasses."] * 20)
    french = "\n".join(["Communication concernant l'appréciation des accords verticaux",
                        "Chiffre 1", "(1) Par accords verticaux, on entend les conventions."])
    props = propositions.parse(german + "\n" + french, "2002-02-18")
    assert all("accords" not in p.text for p in props)


def test_an_indented_continuation_closes_the_word_and_a_real_hyphen_stays():
    assert propositions.dehyphenate("dem Wei-\n  terverkauf") == "dem Weiterverkauf"
    assert propositions.dehyphenate("der EU-\nKommission") == "der EU-\nKommission"
    text = propositions._clean(["die Herstellungs- oder Vertriebskosten und den Wei- terverkauf."])
    assert text == "die Herstellungs- oder Vertriebskosten und den Weiterverkauf."


def test_the_next_sections_heading_and_footnote_calls_are_not_the_propositions():
    lines = ["Ein selektives Vertriebssystem liegt vor, wenn ?? diese Händler nicht verkaufen.", "B.", "Regeln"]
    assert propositions._clean(lines) == "Ein selektives Vertriebssystem liegt vor, wenn diese Händler nicht verkaufen."
    lines = ["nur in ihrem Vertragsgebiet zu beziehen.39",
             "Sachverhalte, die den Tatbestand von Artikel 5 Absatz 4 KG nicht erfüllen"]
    assert propositions._clean(lines) == "nur in ihrem Vertragsgebiet zu beziehen."
    assert propositions._clean(["gemäss den Vertikalleitlinien2 gilt dies."]) == "gemäss den Vertikalleitlinien gilt dies."
    # a lettered rule that ends in "oder" keeps its last line
    assert propositions._clean(["der Anbieter zugleich Hersteller ist;", "oder"]) == "der Anbieter zugleich Hersteller ist; oder"


def test_a_sentence_starting_with_a_statute_reference_is_not_an_article():
    text = "\n".join([
        "Artikel 14   Erheblichkeit",
        "Bei der Prüfung der Frage, ob eine erhebliche Wettbewerbsbeeinträchtigung im Sinne von",
        "Artikel 5 Absatz 1 KG vorliegt, ist Folgendes zu beachten:",
        "a) die Marktanteile."])
    props = propositions.parse(text, "2022-12-12")
    assert not any(p.unit == "5" for p in props)
    assert propositions._UNIT.match("Artikel 5      Selektive Vertriebssysteme")


def test_the_signature_the_annex_and_repealed_points_are_not_propositions():
    body = ["Artikel 1   Gegenstand", "Diese Bekanntmachung regelt etwas."] + ["Text."] * 20
    tail = ["Artikel 2   Inkrafttreten", "Sie tritt am 1. Januar in Kraft.", "Wettbewerbskommission",
            "Der Präsident: Andreas Heinemann", "Anhang 1: Prüfschema", "Schritt 1 prüfen."]
    props = propositions.parse("\n".join(body + tail), "2022-12-12")
    assert props[-1].text == "Sie tritt am 1. Januar in Kraft."
    assert propositions._REPEALED.fullmatch("[…]12")


def test_a_statute_reference_broken_over_two_lines_is_not_a_subparagraph():
    text = "\n".join([
        "Ziffer 8   Geltungsbereich",
        "(1) Die Bekanntmachung schliesst nicht aus, dass ein Sachverhalt gemäss Artikel 5 Absatz",
        "3 KG beurteilt wird.",
        "(2) Sie gilt auch für Wettbewerber."])
    props = propositions.parse(text, "2010-06-28")
    assert [p.pid for p in props] == ["8(1)", "8(2)"]
    assert props[0].text.endswith("Artikel 5 Absatz 3 KG beurteilt wird.")


def test_the_date_and_signature_after_the_last_article_are_cut():
    body = ["Ziffer 1   Gegenstand", "Diese Bekanntmachung regelt etwas."] + ["Text."] * 20
    tail = ["Ziffer 20   Inkrafttreten", "Diese Bekanntmachung tritt am 1. August 2010 in Kraft.",
            "28. Juni 2010                    Wettbewerbskommission"]
    props = propositions.parse("\n".join(body + tail), "2010-06-28")
    assert props[-1].text == "Diese Bekanntmachung tritt am 1. August 2010 in Kraft."


def test_a_long_unit_heading_still_opens_its_unit():
    assert propositions._UNIT.match("Ziffer 13       Unerhebliche Wettbewerbsbeeinträchtigung aufgrund der Marktanteile")


def test_an_article_reference_continuing_a_broken_sentence_is_not_a_heading():
    text = "\n".join([
        "Artikel 9   Geltung",
        "Die Bekanntmachung macht deutlich, dass vertikale Wettbewerbsabreden, die nicht unter",
        "Artikel 12 Bagatellfälle fallen",
        "A. Begriffe",
        "Artikel 10   Begriffe",
        "Als vertikale Abreden gelten Vereinbarungen."])
    props = propositions.parse(text, "2022-12-12")
    assert [p.unit for p in props] == ["9", "10"]


def test_a_letter_on_its_own_line_and_the_journal_header_between_pages():
    text = "\n".join(["Ziffer 3", "Erheblichkeit", "Abreden, die:",
                      "d) die Querlieferungen beschränken;", "", "2002/2", "", "RPW/DPC", "", "406", "",
                      "e)", "Beschränkungen, die den Lieferanten hindern."])
    props = propositions.parse(text, "2002-02-18")
    assert [p.pid for p in props] == ["3(d)", "3(e)"]
    assert props[0].text == "die Querlieferungen beschränken;"
    assert props[1].text == "Beschränkungen, die den Lieferanten hindern."


def test_a_footnote_with_its_continuation_lines_leaves_the_paragraph():
    text = "\n".join([
        "25.    Vertikale Abreden betreffend den Online-Handel können absoluten Gebietsschutz darstellen,",
        "begleitet werden, im Einzelfall.58", "", "",
        "55 Vgl. EuGH, Metro/Kommission; vgl. auch EU-Vertikalleitlinien,",
        "Rz 148 f. Die erste Voraussetzung erfüllt die Zahnpasta Elmex rot nicht",
        "(RPW 2010/1, 84 Rz 157, Gaba).",
        "58 RPW 2011/3, 381 Rz 69; RPW 2014/1, 198 Rz 139, Kosmetikpro-", "", "dukte.",
        "26.    Ein weiterer Absatz."] + ["27.  x."] * 4)
    props = propositions.parse(text, "2022-12-12-erl")
    assert props[0].text.endswith("im Einzelfall.")
    assert "Elmex" not in props[0].text and "dukte" not in props[0].text
    assert props[1].text == "Ein weiterer Absatz."


def test_a_lettered_point_carries_its_opening():
    text = "\n".join(["Ziffer 5", "Rechtfertigung", "(1) Insbesondere gerechtfertigt sind Abreden, die:",
                      "e) Beschränkungen des Weiterverkaufs an Dritte."])
    props = propositions.parse(text, "2002-02-18")
    assert props[-1].pid.endswith("e)")
    assert props[-1].lead.startswith("Insbesondere gerechtfertigt")


def test_a_footnote_carried_over_a_blank_line_and_the_file_number_are_dropped():
    text = "\n".join([
        "14.    Abreden sind vorbehältlich einer Rechtfertigung unzulässig.49", "", "",
        "41 BGer, 2C_44/2020 vom 3.3.2022 E. 9.1, Flammarion/WEKO; vgl. auch RPW 2018/2, 243 Rz 54 f.,", "",
        "gym80.",
        "42 Vgl. BGer 2C_43/2020, Dargaud/WEKO; BVGer,", "",
        "B-3938/2013 vom 30.10.2019, E. 6.2 f., Dargaud/WEKO. Zu beachten sind jedoch die", "",
        " 011-00001/COO.2101.111.3.267536",
        "\fbesteht weiter, wenn die Abrede fortdauert.",
        "15.    Ein weiterer Absatz."] + ["16.  x."] * 4)
    props = propositions.parse(text, "2022-12-12-erl")
    assert props[0].text == "Abreden sind vorbehältlich einer Rechtfertigung unzulässig. besteht weiter, wenn die Abrede fortdauert."
    assert "gym80" not in props[0].text and "COO" not in props[0].text


def test_a_body_line_starting_with_a_number_is_not_a_footnote():
    text = "\n".join(["14.    Die Frist beträgt", "3 Jahre ab Abschluss des Vertrags.",
                      "15.    Ein weiterer Absatz."] + ["16.  x."] * 4)
    props = propositions.parse(text, "2022-12-12-erl")
    assert props[0].text == "Die Frist beträgt 3 Jahre ab Abschluss des Vertrags."
