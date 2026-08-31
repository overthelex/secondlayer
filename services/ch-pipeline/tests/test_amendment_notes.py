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


def _akn_document(*note_texts: str, e_id: str = "art_40_g") -> bytes:
    """The minimal real shape extract() walks: a note with no eId of its
    own, sitting inside an <article>, exactly as verified on the live OR
    (with_eId=0, measured directly -- see amendment_notes.py's
    _owning_article docstring). One <paragraph> per note_text given -- an
    article with several amended paragraphs carries one <authorialNote>
    each, in paragraph position, which is the real shape review finding 1
    (item 1 of round 2) needed: document order across TWO notes is not
    chronological order, only within one note is."""
    paragraphs = "".join(
        f'<paragraph eId="{e_id}/para_{i}"><content><p>Text.'
        f'<authorialNote>{text}</authorialNote></p></content></paragraph>'
        for i, text in enumerate(note_texts, start=1)
    )
    return (
        '<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
        f'<act><body><article eId="{e_id}"><num><b>Art. 40g</b></num>'
        f'{paragraphs}'
        '</article></body></act></akomaNtoso>'
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
    rows = [r for r in an.extract(FIXTURE.read_bytes())
            if r.anchor_level == an.ANCHOR_ARTICLE]
    assert len(rows) == 1
    row = rows[0]
    assert row.e_id == "art_637_639"
    assert row.action == "repealed"
    assert row.as_reference == "AS 1992 733"
    assert row.effective_date == datetime.date(1992, 7, 1)
    assert row.container_articles is None


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
    and both keep the FULL original note in raw_note -- the column exists
    so a wrong parse stays auditable. (Ordering WITHIN one split note is
    chronological -- see test_document_order_is_not_chronological_across_notes
    for why that does NOT extend to rows from DIFFERENT notes.)"""
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


# --- Round 2 fixes -----------------------------------------------------

def test_document_order_is_not_chronological_across_notes():
    """Review round 2, item 1: an earlier docstring claimed the LAST row
    for one e_id was that article's current state. False across notes --
    an article carries one <authorialNote> per amended paragraph, in
    paragraph position, not chronological position. Measured on the full
    OR: art_740 emits source_act_date 2005-12-16 then 1991-10-04 (19 of 509
    e_ids are non-monotonic this way). This test pins the contract this
    round landed on: extract() makes no ordering promise across notes, so
    it must NOT silently sort -- a consumer wanting current state sorts
    itself. Two single-event notes on the same article, newer one first in
    the document (mirroring art_740's own shape), non-monotonic on output
    if and only if extract() preserves raw document order."""
    newer_first = (
        "Fassung gemäss Ziff. I des BG vom 16. Dez. 2005, in Kraft seit "
        "1. Jan. 2006 (AS 2005 999; BBl 2004 888).")
    older_second = (
        "Fassung gemäss Ziff. I des BG vom 4. Okt. 1991, in Kraft seit "
        "1. Juli 1992 (AS 1991 777; BBl 1990 666).")
    rows = an.extract(_akn_document(newer_first, older_second))
    assert [r.source_act_date for r in rows] == [
        datetime.date(2005, 12, 16), datetime.date(1991, 10, 4)]
    # Non-monotonic: the second row's date is EARLIER than the first's --
    # the last row is not "later", let alone "current".


def test_backreference_citation_is_dropped_not_welded_to_another_events_date():
    """Review round 2, item 2: disp_u16/art_19 on the full OR, verbatim.
    The first sentence describes a real event (this section took its
    current wording from the BG of 1 April 1949); the second sentence
    points at AS 53 185, the citation of the ORIGINAL text that 1949 act
    REPLACED -- not a citation of the 1949 act itself. Before this fix,
    the nearest-match search welded them into one row: as_reference from
    the superseded original, source_act_date from its replacement, the
    same event-blend finding 1 removed, reintroduced through one sentence
    pointing at another. No action verb and (after the back-reference
    citation is stripped) no citation belonging to THIS event puts the
    note in the same category as any other explanatory prose with nothing
    to hang provenance on -- dropped, not repaired with a guessed field."""
    text = ("Dieser Abschnitt ist in der Fassung des BG vom 1. April 1949 "
            "in Kraft gesetzt worden. Für den Text in der ursprünglichen "
            "Fassung siehe AS 53 185.")
    assert an.extract(_akn_document(text)) == []


def test_change_log_pointer_is_dropped_in_french_and_italian():
    """Review round 2, item 3: _CHANGE_LOG_POINTER was German-only while
    extract() takes lang='fr'/'it' (and run-stage.sh exposes CHPIPE_LANG)
    -- a French or Italian run silently re-admitted the entire change-log
    pointer class this rule exists to block."""
    fr = "Les modifications peuvent être consultées au RO 1971 1465."
    assert an.extract(_akn_document(fr), lang="fr") == []

    it = "Le modifiche possono essere consultate nella RU 1971 1465."
    assert an.extract(_akn_document(it), lang="it") == []


def test_extract_drops_a_bracketed_publication_history():
    """Review round 2, item 4: _BRACKETED_LIST had no test of its own --
    all 22 tests stayed green with it deleted. A bracketed list like this
    is the entire note, opening bracket first, citing a DIFFERENT act's
    publication trail, not this article's."""
    text = "[AS 1972 1502; 1977 1269; 1982 1234; 1987 1189]"
    assert an.extract(_akn_document(text)) == []


def test_extract_drops_a_bare_citation_with_no_prose():
    """Review round 2, item 4: the bare-citation residue check had no test
    of its own either -- deleting it left all 22 tests green. 'AS 53 185'
    alone, no verb, no surrounding sentence, is the same shape as an SR
    cross-reference with no AS prefix -- not a description of an event."""
    assert an.extract(_akn_document("AS 53 185")) == []


def test_extract_keeps_a_bbl_only_citation_with_no_recognised_verb():
    """Review round 2, item 5: the docstring always said "require an AS/BBl
    reference"; the code required as_reference alone, silently dropping a
    BBl-only row with no recognised verb (zero occurrences on the full OR,
    so this is a doc/code agreement fix, not something real data forced)."""
    text = ("Ausdruck gemäss Ziff. I des BG vom 5. Okt. 1990 "
            "(BBl 1986 II 354).")
    rows = an.extract(_akn_document(text))
    assert len(rows) == 1
    assert rows[0].as_reference is None
    assert rows[0].bbl_reference == "BBl 1986 II 354"


# --- Round 3 fixes -----------------------------------------------------

def test_french_avec_effet_au_is_the_effective_date():
    """Review round 3, item 1/2: 'avec effet au' is the French counterpart
    of German 'mit Wirkung seit' -- the phrasing French uses for a repeal's
    effective date. Missing before this fix, it left French effective-date
    coverage at 78% (615/788) against German/Italian's 92%. Real sentence
    from the cached French OR (art_13)."""
    text = ("Abrogé par l’annexe ch. 2 de la LF du 19 déc. 2003 sur la "
            "signature électronique, avec effet au 1er janv. 2005 "
            "(RO 2004 5085; FF 2001 5423).")
    parsed = an.parse_note(text, lang="fr")
    assert parsed["action"] == "repealed"
    assert parsed["effective_date"] == datetime.date(2005, 1, 1)
    assert parsed["source_act_date"] == datetime.date(2003, 12, 19)


def test_italian_ordinal_in_the_source_act_date():
    """Review round 3, item 2: _SOURCE_ACT's own day-group needed the same
    Italian ordinal fix _DATE got earlier -- 'della LF del 1° ott. 2021'
    did not match at all, since "1" followed by "°" (not a literal '.')
    failed the old pattern before it ever reached the month. Real sentence
    from the cached Italian OR (an insertion into the transitional
    provisions, dated by the 1 Oct 2021 annex)."""
    text = ("Introdotta dall’all. n. 1 della LF del 1° ott. 2021, in vigore "
            "dal 1° gen. 2023 (RU 2022 468; FF 2019 5841, 6005).")
    parsed = an.parse_note(text, lang="it")
    assert parsed["source_act_date"] == datetime.date(2021, 10, 1)
    assert parsed["effective_date"] == datetime.date(2023, 1, 1)


def test_italian_elided_dell_before_a_source_act_date():
    """Review round 3, item 2: Italian 'del' elides to "dell'" before a
    digit read with a leading vowel sound (8, 11, ...) -- "della LF
    dell'8 ott. 1999" has no bare "del " for the old trigger to match at
    all. 7 occurrences on the full Italian OR against 865 unelided "del ".
    Real sentence from the cached Italian OR (art_360_a, the posted-workers
    act)."""
    text = ("Introdotto dall’all. n. 2 della LF dell’8 ott. 1999 sui "
            "lavoratori distaccati in Svizzera, in vigore dal 1° lug. 2004 "
            "(RU 2003 1370; FF 1999 5092).")
    parsed = an.parse_note(text, lang="it")
    assert parsed["source_act_date"] == datetime.date(1999, 10, 8)
    assert parsed["effective_date"] == datetime.date(2004, 7, 1)



# --- Final gate, B1: inflected French/Italian participles ---------------

# Real notes from the cached French and Italian OR, on art. 226a-226d --
# articles the 1962 Act INSERTED and the 2001 consumer-credit Act REPEALED.
# Both are plural because the note describes four articles at once, so both
# defeated the masculine-singular-only "Introduit"/"Abrogato" patterns.
FR_PLURAL_TWO_EVENTS = (
    "Introduits par le ch. I de la LF du 23 mars 1962 (RO 1962 1082; "
    "FF 1960 I 537). Abrogés par l’annexe 2 ch. II 1 de la LF du 23 mars "
    "2001 sur le crédit à la consommation, avec effet au 1er janv. 2003 "
    "(RO 2002 3846; FF 1999 III 2879).")
IT_PLURAL_TWO_EVENTS = (
    "Introdotti dalla cifra I della LF del 23 mar. 1962 (RU 1962 1085; "
    "FF 1962 593). Abrogati all’all. 2 cifra II n. 2 della LF del 23 mar. "
    "2001 sul credito al consumo, con effetto dal 1° gen. 2003 "
    "(RU 2002 3846; FF 1999 III 2697).")


@pytest.mark.parametrize("lang,text,inserted_ref,repealed_ref", [
    ("fr", FR_PLURAL_TWO_EVENTS, "RO 1962 1082", "RO 2002 3846"),
    ("it", IT_PLURAL_TWO_EVENTS, "RU 1962 1085", "RU 2002 3846"),
])
def test_a_plural_participle_still_splits_into_two_events(
        lang, text, inserted_ref, repealed_ref):
    """B1: with the plural verb invisible, _split_events() saw ONE event and
    parse_note() welded the FIRST event's citation to the SECOND event's
    date -- 'arts. 226a-226d repealed by RO 1962 1082, effective 2003',
    naming the act that introduced them as the act that repealed them. That
    is worse than no row: every field is populated, so the accuracy table
    reads healthy and only cross-language comparison exposes it.

    Asserted as the pairing, not just the row count: a fix that split the
    note but crossed the citations over would still pass a length check.
    """
    rows = an.extract(_akn_document(text, e_id="art_226_a_226_d"), lang=lang)
    assert [(r.action, r.as_reference, r.effective_date) for r in rows] == [
        ("inserted", inserted_ref, None),
        ("repealed", repealed_ref, datetime.date(2003, 1, 1)),
    ]


@pytest.mark.parametrize("lang,text,expected", [
    # Every inflected form that occurs on the full fr/it OR, enumerated
    # from the documents rather than from a grammar table.
    ("fr", "Introduit par le ch. I de la LF du 5 oct. 1990.", "inserted"),
    ("fr", "Introduits par le ch. I de la LF du 5 oct. 1990.", "inserted"),
    ("fr", "Introduite par le ch. I de la LF du 5 oct. 1990.", "inserted"),
    ("fr", "Introduites par le ch. I de la LF du 5 oct. 1990.", "inserted"),
    ("fr", "Abrogé par le ch. I de la LF du 5 oct. 1990.", "repealed"),
    ("fr", "Abrogés par le ch. I de la LF du 5 oct. 1990.", "repealed"),
    ("fr", "Abrogée par le ch. I de la LF du 5 oct. 1990.", "repealed"),
    ("fr", "Abrogées par le ch. I de la LF du 5 oct. 1990.", "repealed"),
    ("it", "Introdotto dalla cifra I della LF del 5 ott. 1990.", "inserted"),
    ("it", "Introdotti dalla cifra I della LF del 5 ott. 1990.", "inserted"),
    ("it", "Introdotta dalla cifra I della LF del 5 ott. 1990.", "inserted"),
    ("it", "Introdotte dalla cifra I della LF del 5 ott. 1990.", "inserted"),
    ("it", "Abrogato dalla cifra I della LF del 5 ott. 1990.", "repealed"),
    ("it", "Abrogati dalla cifra I della LF del 5 ott. 1990.", "repealed"),
    ("it", "Abrogata dalla cifra I della LF del 5 ott. 1990.", "repealed"),
    ("it", "Abrogate dalla cifra I della LF del 5 ott. 1990.", "repealed"),
])
def test_every_inflected_form_found_in_the_corpus_is_classified(
        lang, text, expected):
    assert an.parse_note(text, lang=lang)["action"] == expected


@pytest.mark.parametrize("lang,text", [
    # "Abrogé" carried no trailing boundary, so it matched any word with
    # that prefix. These are the neighbouring words that must NOT be read
    # as a repeal of this article: "Abrogation" is a heading word, and the
    # Italian nominalisation is not a participle at all.
    ("fr", "Abrogation de l’art. 5 de la LF du 5 oct. 1990."),
    ("it", "Abrogazione dell’art. 5 della LF del 5 ott. 1990."),
])
def test_a_nominalisation_is_not_read_as_a_repeal(lang, text):
    assert an.parse_note(text, lang=lang)["action"] is None


# --- Final gate, B5: notes Fedlex hangs on a container ------------------

_CONTAINER_DOC = (
    '<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
    '<act><body>'
    # A <level> wrapping exactly ONE article, with the amendment note on the
    # level's own heading. 51 of the 93 German orphans are this exact shape,
    # and all 51 are a direct parent -- so the note names art_60 and nothing
    # else.
    '<level eId="lvl_G"><heading>Verjährung<authorialNote><p>{single}</p>'
    '</authorialNote></heading>'
    '<article eId="art_60"><paragraph eId="art_60/para_1"><content><p>A.</p>'
    '</content></paragraph></article></level>'
    # A <chapter> holding THREE articles, with an act-wide note on its
    # heading. This one is about the block, not about any of the three.
    '<chapter eId="chap_7"><heading>Transparenz<authorialNote><p>{block}</p>'
    '</authorialNote></heading>'
    '<article eId="art_964_a"><paragraph eId="art_964_a/para_1"><content>'
    '<p>B.</p></content></paragraph></article>'
    '<article eId="art_964_b"><paragraph eId="art_964_b/para_1"><content>'
    '<p>C.</p></content></paragraph></article>'
    '<article eId="art_964_c"><paragraph eId="art_964_c/para_1"><content>'
    '<p>D.</p></content></paragraph></article></chapter>'
    '</body></act></akomaNtoso>')

_SINGLE_LEVEL_NOTE = (
    "Fassung gemäss Anhang Ziff. 2 des BG vom 19. Dez. 2003 über die "
    "elektronische Signatur, in Kraft seit 1. Jan. 2005 "
    "(AS 2004 5085; BBl 2001 5679).")
_CHAPTER_NOTE = (
    "Ursprünglich: Sechster Abschnitt und Art. 964a–964f. Eingefügt durch "
    "Ziff. I des BG vom 19. Juni 2020 (Aktienrecht), in Kraft seit "
    "1. Jan. 2021 (AS 2020 4005; BBl 2017 399).")


def _container_document() -> bytes:
    return _CONTAINER_DOC.format(single=_SINGLE_LEVEL_NOTE,
                                 block=_CHAPTER_NOTE).encode("utf-8")


def test_a_level_wrapping_one_article_anchors_to_that_article():
    """Fedlex puts the article's marginal-note heading on a wrapping
    <level> and hangs the amendment note off the heading. Attributing it to
    the single article beneath is not inheritance -- it is the same "which
    provision is this about" walk, corrected for where the heading lives."""
    rows = [r for r in an.extract(_container_document())
            if r.e_id == "art_60"]
    assert len(rows) == 1
    assert rows[0].anchor_level == an.ANCHOR_ARTICLE
    assert rows[0].container_articles is None
    assert rows[0].as_reference == "AS 2004 5085"
    assert rows[0].effective_date == datetime.date(2005, 1, 1)


def test_a_note_on_a_multi_article_container_is_stored_once_against_it():
    rows = an.extract(_container_document())
    chapter = [r for r in rows if r.e_id == "chap_7"]
    assert len(chapter) == 1
    assert chapter[0].anchor_level == an.ANCHOR_CONTAINER
    assert chapter[0].container_articles == 3
    assert chapter[0].as_reference == "AS 2020 4005"


def test_a_container_note_is_never_pushed_down_to_its_articles():
    """The measurement behind the choice: inheriting the container notes on
    the German OR would have turned 782 rows into 1,590, and 498 of those
    (31%) are contradicted by the receiving article's OWN footnotes naming a
    LATER amending act -- worst case, "Fassung gemäss BG vom 18. Dez. 1936"
    on part_3 asserting that the 1936 Act worded art. 964a, a provision
    inserted in 2021. A row naming the wrong act is worse than no row."""
    rows = an.extract(_container_document())
    inherited = [r for r in rows
                 if r.e_id in {"art_964_a", "art_964_b", "art_964_c"}]
    assert inherited == []


def test_a_note_with_no_eid_bearing_ancestor_is_still_dropped():
    """The only remaining drop: a preamble note has no real identifier to
    anchor to, and a synthetic one would put a made-up value in a column
    callers read as a citation. One such note on the German and French OR."""
    doc = ('<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           '<act><preamble><p>Vorbemerkung<authorialNote><p>' + REPEALED +
           '</p></authorialNote></p></preamble></act></akomaNtoso>')
    assert an.extract(doc.encode("utf-8")) == []


def test_the_full_or_record_is_complete_but_for_the_unanchorable():
    """Anchoring is not a heuristic that happens to catch most notes: every
    amendment event in the fixture is stored under one anchor or the other,
    and the two counts partition the total."""
    rows = an.extract(FIXTURE.read_bytes())
    article = [r for r in rows if r.anchor_level == an.ANCHOR_ARTICLE]
    container = [r for r in rows if r.anchor_level == an.ANCHOR_CONTAINER]
    assert article and container
    assert len(article) + len(container) == len(rows)
    assert all(r.container_articles is None for r in article)
    assert all(r.container_articles is not None for r in container)
