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
