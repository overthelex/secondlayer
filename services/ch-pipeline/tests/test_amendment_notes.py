import datetime
import pathlib
from chpipe import amendment_notes as an

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"

INSERTED = ("Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit "
            "1. Juli 1991 (AS 1991 846; BBl 1986 II 354).")
REPEALED = ("Aufgehoben durch Anhang Ziff. 2 des BG vom 19. Dez. 2003 über die "
            "elektronische Signatur, mit Wirkung seit 1. Jan. 2005 "
            "(AS 2004 5085; BBl 2001 5679).")
AMENDED = ("Fassung gemäss Ziff. I des BG vom 18. Juni 1993, in Kraft seit "
           "1. Juli 1994 (AS 1994 1359; BBl 1992 II 1).")


def test_eingefuegt_is_inserted():
    assert an.parse_note(INSERTED)["action"] == "inserted"


def test_aufgehoben_is_repealed():
    assert an.parse_note(REPEALED)["action"] == "repealed"


def test_fassung_gemaess_is_amended():
    assert an.parse_note(AMENDED)["action"] == "amended"


def test_extracts_the_as_reference():
    assert an.parse_note(INSERTED)["as_reference"] == "AS 1991 846"


def test_extracts_the_bbl_reference():
    assert an.parse_note(INSERTED)["bbl_reference"] == "BBl 1986 II 354"


def test_reads_in_kraft_seit_as_the_effective_date():
    assert an.parse_note(INSERTED)["effective_date"] == datetime.date(1991, 7, 1)


def test_reads_mit_wirkung_seit_as_the_effective_date():
    assert an.parse_note(REPEALED)["effective_date"] == datetime.date(2005, 1, 1)


def test_reads_the_date_of_the_amending_act():
    assert an.parse_note(INSERTED)["source_act_date"] == datetime.date(1990, 10, 5)


def test_abbreviated_months_are_understood():
    """Swiss notes abbreviate: Okt., Dez., Jan. — and spell out Juli, März."""
    for text, expected in (
        ("in Kraft seit 1. Okt. 2001", datetime.date(2001, 10, 1)),
        ("in Kraft seit 1. Dez. 2001", datetime.date(2001, 12, 1)),
        ("in Kraft seit 1. März 2001", datetime.date(2001, 3, 1)),
        ("in Kraft seit 15. Febr. 2001", datetime.date(2001, 2, 15)),
    ):
        assert an.parse_note(text)["effective_date"] == expected


def test_a_plain_cross_reference_is_not_provenance():
    """'SR 943.03' is a pointer to another act, not an amendment."""
    parsed = an.parse_note("SR 943.03")
    assert parsed["action"] is None
    assert parsed["as_reference"] is None


def test_a_publication_footnote_is_not_provenance():
    parsed = an.parse_note("BBl 1905 II 1, 1909 III 725, 1911 I 845")
    assert parsed["action"] is None


def test_extract_attaches_notes_to_their_owning_article():
    rows = an.extract(FIXTURE.read_bytes())
    assert rows, "the fixture must contain at least one amendment note"
    assert all(r.e_id for r in rows)
    assert all(r.raw_note for r in rows)


def test_extract_drops_notes_that_are_not_amendments():
    rows = an.extract(FIXTURE.read_bytes())
    assert all(r.action or r.as_reference for r in rows), \
        "a row with neither an action nor an AS reference is not provenance"


def test_french_notes_are_understood():
    fr = ("Introduit par le ch. I de la LF du 5 oct. 1990, en vigueur depuis le "
          "1er juil. 1991 (RO 1991 846; FF 1986 II 354).")
    parsed = an.parse_note(fr, lang="fr")
    assert parsed["action"] == "inserted"
    assert parsed["as_reference"] == "RO 1991 846"
