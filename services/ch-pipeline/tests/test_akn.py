import pathlib
import pytest
from chpipe import akn

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
XML = FIXTURE.read_bytes()


def test_finds_the_articles():
    arts = akn.parse_articles(XML)
    assert len(arts) >= 3
    assert arts[0].e_id == "art_1"


def test_article_number_is_the_digits_not_the_label():
    art = akn.parse_articles(XML)[0]
    assert art.article_number == "1", "'Art. 1' must normalise to '1'"


def test_article_text_is_the_paragraph_content():
    art = akn.parse_articles(XML)[0]
    assert "Willensäusserung" in art.text
    assert "<p>" not in art.text


def test_ordinal_follows_document_order():
    arts = akn.parse_articles(XML)
    assert [a.ordinal for a in arts] == list(range(1, len(arts) + 1))


def test_a_nested_e_id_keeps_its_path_and_its_parent():
    arts = akn.parse_articles(XML)
    nested = [a for a in arts if "/" in a.e_id]
    assert nested, "fixture must contain one nested-eId article"
    assert nested[0].parent_e_id == nested[0].e_id.rsplit("/", 1)[0]


def test_two_articles_may_share_a_number_but_not_an_e_id():
    arts = akn.parse_articles(XML)
    assert len({a.e_id for a in arts}) == len(arts)


def test_marginal_note_is_none_when_the_act_has_no_headings():
    """Verified: the OR carries zero <heading> elements."""
    assert akn.parse_articles(XML)[0].marginal_note is None


def test_plain_text_contains_article_bodies_and_no_tags():
    text = akn.plain_text(XML)
    assert "Willensäusserung" in text
    assert "<" not in text


def test_frbr_dates_are_read_from_the_document_itself():
    dates = akn.frbr_dates(XML)
    assert dates["jolux:dateApplicability"] == "2026-01-01"
    assert dates["jolux:dateDocument"] == "1911-03-30"


def test_malformed_xml_raises_rather_than_returning_nothing():
    """Silently returning [] would let a broken download look like an empty act."""
    with pytest.raises(akn.AknParseError):
        akn.parse_articles(b"<akomaNtoso><unclosed>")


def test_an_empty_document_yields_no_articles():
    empty = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
             b'<act><body/></act></akomaNtoso>')
    assert akn.parse_articles(empty) == []


def test_a_real_en_dash_numbered_article_normalises_to_a_plain_hyphen():
    """art_637_639 is a real repealed OR article whose <num> reads
    'Art. 637–639' with an actual en dash (U+2013) in the source, not a
    hand-typed one. article_number must come back with a plain hyphen."""
    arts = akn.parse_articles(XML)
    dashed = [a for a in arts if a.e_id == "art_637_639"]
    assert dashed, "fixture must contain the real dash-numbered article"
    assert dashed[0].article_number == "637-639"


def test_normalise_number_folds_en_and_em_dashes():
    assert akn.normalise_number("Art. 111–14") == "111-14"
    assert akn.normalise_number("Art. 111—14") == "111-14"


def test_plain_text_raises_rather_than_falling_back_to_the_whole_document():
    """A missing <body> must not silently pull <meta> (FRBR dates,
    identifiers) into what a later stage stores as the edition's text."""
    no_body = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
               b'<act><meta><identification source="#ch.bk"><FRBRWork>'
               b'<FRBRdate date="1911-03-30" name="jolux:dateDocument"/>'
               b'</FRBRWork></identification></meta></act></akomaNtoso>')
    with pytest.raises(akn.AknParseError):
        akn.plain_text(no_body)
