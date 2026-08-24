import datetime
import pathlib

import pytest

from chpipe import akn
from chpipe import amendment_notes as an

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"

INSERTED = ("Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit "
            "1. Juli 1991 (AS 1991 846; BBl 1986 II 354).")
REPEALED = ("Aufgehoben durch Anhang Ziff. 2 des BG vom 19. Dez. 2003 über die "
            "elektronische Signatur, mit Wirkung seit 1. Jan. 2005 "
            "(AS 2004 5085; BBl 2001 5679).")
AMENDED = ("Fassung gemäss Ziff. I des BG vom 18. Juni 1993, in Kraft seit "
           "1. Juli 1994 (AS 1994 1359; BBl 1992 II 1).")

# A note that documents TWO amendments -- the shape review finding 1 caught:
# parse_note() on the whole thing would report action='inserted' (first verb
# wins) next to effective_date=2001-01-01 (the LAST "mit Wirkung seit" in the
# string), welding the 1990 insertion's action to the 2000 repeal's date.
TWO_EVENT_NOTE = (
    "Eingefügt durch Ziff. I des BG vom 5. Okt. 1990 (AS 1991 846; "
    "BBl 1986 II 354). Aufgehoben durch Anhang Ziff. 5 des "
    "Gerichtsstandsgesetzes vom 24. März 2000, mit Wirkung seit 1. Jan. 2001 "
    "(AS 2000 2355; BBl 1999 III 2829).")


def _akn_document(note_text: str) -> bytes:
    """The minimal real shape extract() walks: a note with no eId of its
    own, sitting inside an <article>, exactly as verified on the live OR
    (with_eId=0, measured directly -- see amendment_notes.py's
    _owning_article docstring)."""
    return (
        '<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
        '<act><body><article eId="art_40_g"><num><b>Art. 40g</b></num>'
        '<paragraph eId="art_40_g/para_1"><content><p>Text.'
        f'<authorialNote>{note_text}</authorialNote>'
        '</p></content></paragraph></article></body></act></akomaNtoso>'
    ).encode("utf-8")


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


def test_extract_keeps_the_repeal_and_drops_the_change_log_pointer():
    """The fixture's only two inside-article notes, read directly: a real
    repeal with its own citation (kept) and a bare 'Die Änderungen können
    unter AS ... konsultiert werden' pointer to another act's history
    (dropped) -- see disp_u2/art_1 in the fixture. This replaces review
    finding 7's tautological assertion (`r.action or r.as_reference`, a
    literal restatement of the old filter it claimed to test, which could
    not fail for any input); this one fails if either row is wrong."""
    rows = an.extract(FIXTURE.read_bytes())
    assert len(rows) == 1
    row = rows[0]
    assert row.e_id == "art_637_639"
    assert row.action == "repealed"
    assert row.as_reference == "AS 1992 733"
    assert row.effective_date == datetime.date(1992, 7, 1)


def test_french_notes_are_understood():
    fr = ("Introduit par le ch. I de la LF du 5 oct. 1990, en vigueur depuis le "
          "1er juil. 1991 (RO 1991 846; FF 1986 II 354).")
    parsed = an.parse_note(fr, lang="fr")
    assert parsed["action"] == "inserted"
    assert parsed["as_reference"] == "RO 1991 846"


def test_french_accented_month_abbreviations_are_understood():
    """Review finding 3: the brief's _MONTHS keys 'fév', 'déc', 'août' were
    typed as unaccented 'fev', 'dec', 'aout', which never occur in real
    French text (_parse_date does not fold accents) -- every French note
    whose date fell in February, August or December silently lost it."""
    parsed = an.parse_note(
        "Introduit par le ch. I de la LF du 1er déc. 1990, en vigueur depuis "
        "le 1er fév. 1991 (RO 1991 846).",
        lang="fr")
    assert parsed["source_act_date"] == datetime.date(1990, 12, 1)
    assert parsed["effective_date"] == datetime.date(1991, 2, 1)

    aout = an.parse_note("en vigueur depuis le 1er août 1991", lang="fr")
    assert aout["effective_date"] == datetime.date(1991, 8, 1)


def test_italian_notes_are_understood():
    """There was no Italian test at all before review finding 5."""
    it = ("Introdotto dal n. I della LF del 5 ott. 1990, in vigore dal "
          "1° lug. 1991 (RU 1991 846; FF 1986 II 354).")
    parsed = an.parse_note(it, lang="it")
    assert parsed["action"] == "inserted"
    assert parsed["as_reference"] == "RU 1991 846"
    assert parsed["source_act_date"] == datetime.date(1990, 10, 5)
    assert parsed["effective_date"] == datetime.date(1991, 7, 1)


def test_italian_ordinal_degree_sign_is_understood():
    """Review finding 5: _DATE accepted the French 'er' ordinal but not the
    Italian '°' (degree sign), so '1° gen. 2005' never matched -- and
    Italian effective dates are almost always day 1, so this silently
    emptied the IT column."""
    parsed = an.parse_note("in vigore dal 1° gen. 2005", lang="it")
    assert parsed["effective_date"] == datetime.date(2005, 1, 1)


def test_a_two_event_note_produces_two_rows():
    """Review finding 1: a note documenting two successive amendments (an
    insertion later repealed) used to produce ONE row welding fields from
    both acts -- action='inserted' (first verb wins) next to the REPEAL's
    effective date. 61 of 748 rows on the full OR had this shape. Each
    event now gets its own row, each carrying only its own event's fields,
    and both keep the FULL original note in raw_note (see extract()'s
    docstring: the last row for one e_id is that article's current state)."""
    rows = an.extract(_akn_document(TWO_EVENT_NOTE))
    assert len(rows) == 2

    inserted, repealed = rows
    assert inserted.action == "inserted"
    assert inserted.as_reference == "AS 1991 846"
    assert inserted.bbl_reference == "BBl 1986 II 354"
    assert inserted.source_act_date == datetime.date(1990, 10, 5)
    assert inserted.effective_date is None

    assert repealed.action == "repealed"
    assert repealed.as_reference == "AS 2000 2355"
    assert repealed.bbl_reference == "BBl 1999 III 2829"
    assert repealed.source_act_date == datetime.date(2000, 3, 24)
    assert repealed.effective_date == datetime.date(2001, 1, 1)

    # raw_note is the FULL note on every row -- the column exists so a
    # wrong parse stays auditable, and truncating it to one event's
    # sentence would defeat that.
    assert inserted.raw_note == repealed.raw_note == TWO_EVENT_NOTE
    assert inserted.e_id == repealed.e_id == "art_40_g"


def test_a_single_event_note_is_not_split():
    """The common case (0 or 1 verb match) is unaffected by
    _split_events(): one note, one row, same as before finding 1."""
    rows = an.extract(_akn_document(INSERTED))
    assert len(rows) == 1
    assert rows[0].action == "inserted"


def test_extract_raises_on_malformed_xml():
    """Review finding 8: extract() used to call etree.fromstring() directly,
    so malformed XML raised etree.XMLSyntaxError instead of the
    AknParseError the rest of the package raises and callers catch."""
    with pytest.raises(akn.AknParseError):
        an.extract(b"<not><valid")


def test_extract_raises_on_an_unrecognised_language():
    """Review finding 8: an unrecognised lang used to fall back to German
    silently (_ACTIONS.get(lang, _ACTIONS["de"])) rather than raising --
    classifying a note against the wrong language's verbs would read as a
    quiet zero rather than an error."""
    with pytest.raises(ValueError):
        an.extract(_akn_document(INSERTED), lang="es")


def test_parse_note_raises_on_an_unrecognised_language():
    with pytest.raises(ValueError):
        an.parse_note(INSERTED, lang="es")
