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


def test_plain_text_is_empty_for_a_body_less_edition_not_a_raise():
    """A missing <body> is a real Fedlex shape (task 6's live slice found
    eli/cc/1/598_557_598/18750702, a body-less 1875 Bundesbeschluss), not
    proof of a truncated download -- fetch_xml_stage already rejects a
    non-AKN response before anything reaches this function. Recorded
    honestly as empty text, the same way parse_articles() already returns
    zero articles for a document with no <article> elements."""
    no_body = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
               b'<act><meta><identification source="#ch.bk"><FRBRWork>'
               b'<FRBRdate date="1911-03-30" name="jolux:dateDocument"/>'
               b'</FRBRWork></identification></meta></act></akomaNtoso>')
    assert akn.plain_text(no_body) == ""
    assert akn.parse_articles(no_body) == []


def test_plain_text_does_not_fall_back_to_meta_when_body_is_missing():
    """The empty-string result must come from there being no <body>, not
    from meta content leaking in as a side effect of some other change."""
    no_body = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
               b'<act><meta><identification source="#ch.bk"><FRBRWork>'
               b'<FRBRdate date="1911-03-30" name="jolux:dateDocument"/>'
               b'<FRBRname value="should never appear in plain_text"/>'
               b'</FRBRWork></identification></meta></act></akomaNtoso>')
    assert "should never appear" not in akn.plain_text(no_body)


def test_plain_text_still_raises_on_malformed_xml():
    """Only the body-less-but-valid case stopped raising. Genuinely
    malformed XML -- a truncated download, a corrupted response -- must
    still raise, the same as parse_articles()."""
    with pytest.raises(akn.AknParseError):
        akn.plain_text(b"<akomaNtoso><unclosed>")


def test_inline_markup_does_not_split_a_word():
    """A <b> wrapping only part of a word must not manufacture a space --
    the real defect measured on the live OR: art_958_b's text came back as
    'nic ht' instead of 'nicht' because the old _text_of() stripped every
    itertext() fragment individually and rejoined them with a literal " ",
    which cannot tell "these two fragments were never separated by
    whitespace in the source" from "they were"."""
    xml = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           b'<act><body><article eId="art_1"><num>Art. 1</num>'
           b'<content><p>Es ist <b>nic</b>ht gueltig.</p></content>'
           b'</article></body></act></akomaNtoso>')
    art = akn.parse_articles(xml)[0]
    assert "nic ht" not in art.text
    assert "nicht" in art.text


def test_inline_markup_still_keeps_a_real_word_boundary():
    """The fix for the above must not glue two genuinely separate words
    together just because an inline element sits between them."""
    xml = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           b'<act><body><article eId="art_1"><num>Art. 1</num>'
           b'<content><p>Wort eins <ref href="x">Quelle</ref> Wort zwei.</p></content>'
           b'</article></body></act></akomaNtoso>')
    art = akn.parse_articles(xml)[0]
    assert "Wort eins Quelle Wort zwei." in art.text


def test_authorial_notes_are_split_out_of_the_operative_text():
    """Fedlex embeds footnotes and amendment citations as <authorialNote>
    children directly inside the operative text -- inside <num> (an
    amendment citation on the article number) and inside body <paragraph>
    content (a cross-reference note). Folding that text into Article.text
    meant a footnote-only correction (fixing a citation like "BBl 1999
    2829") read as an amendment to the provision itself. Plan 3 needs the
    notes for amendment provenance, so they get their own field instead of
    disappearing."""
    xml = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           b'<act><body><article eId="art_1"><num>Art. 1</num>'
           b'<content><p>Der Vertrag gilt'
           b'<authorialNote><p>Fassung gemaess BBl 1999 2829</p></authorialNote>'
           b'.</p></content></article></body></act></akomaNtoso>')
    art = akn.parse_articles(xml)[0]
    assert "BBl 1999 2829" not in art.text
    assert "Der Vertrag gilt" in art.text
    assert art.notes == ("Fassung gemaess BBl 1999 2829",)


def test_authorial_note_tail_text_stays_in_the_operative_text():
    """The text that follows a note in its parent is real article body, not
    part of the note -- removing the note element must not swallow it."""
    xml = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           b'<act><body><article eId="art_1"><num>Art. 1</num>'
           b'<content><p>Vor'
           b'<authorialNote><p>Fussnote</p></authorialNote>'
           b' und danach.</p></content></article></body></act></akomaNtoso>')
    art = akn.parse_articles(xml)[0]
    assert "Vor" in art.text
    assert "und danach" in art.text
    assert "Fussnote" not in art.text


def test_an_article_with_no_notes_has_an_empty_notes_tuple():
    art = akn.parse_articles(XML)[0]
    assert art.notes == ()


def test_normalise_number_folds_non_breaking_hyphen_and_minus_sign():
    """The _NUMBER regex's dash class only recognises a plain hyphen, en
    dash and em dash; U+2011 (non-breaking hyphen) and U+2212 (minus sign)
    must be folded to a plain hyphen by _DASHES *before* the regex runs, the
    same way U+2013/U+2014 already were, or the digit-range match never
    spans the dash at all."""
    assert akn.normalise_number("Art. 111‑14") == "111-14"    # U+2011
    assert akn.normalise_number("Art. 111−14") == "111-14"    # U+2212



def test_list_item_boundaries_always_get_a_real_separator():
    """Fedlex is not consistent about whether a <p> inside one <item> of a
    <blockList> carries a trailing space before the next <item> starts --
    measured on the live OR (art_963_a): one edition's <p> ends
    '...verlangen;</p>', the next edition's ends '...verlangen; </p>'
    (one added space), with no other difference anywhere in the article.
    Joining itertext() fragments with "" (the fix for the "nic ht" defect
    above) preserved that difference verbatim, so the mere presence or
    absence of a source-level trailing space inside one list item's <p>
    turned into a fabricated "modified" row. <item>/<paragraph>/<blockList>
    are structural block boundaries, not inline markup that can legally
    split a word -- unlike <b>/<i>/<ref>, crossing one of them must always
    count as a real separator, regardless of what whitespace (if any) the
    source happens to carry right at the boundary."""
    with_trailing_space = (
        b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
        b'<act><body><article eId="art_1"><num>Art. 1</num>'
        b'<paragraph eId="art_1/para_1"><num>2</num><content><blockList>'
        b'<item eId="art_1/para_1/lbl_1"><num>2. </num>'
        b'<p>dies verlangen; </p></item>'
        b'<item eId="art_1/para_1/lbl_2"><num>3. </num>'
        b'<p>ein Gesellschafter.</p></item>'
        b'</blockList></content></paragraph></article></body></act></akomaNtoso>')
    without_trailing_space = with_trailing_space.replace(b'verlangen; </p>', b'verlangen;</p>')

    art_a = akn.parse_articles(with_trailing_space)[0]
    art_b = akn.parse_articles(without_trailing_space)[0]
    assert art_a.text == art_b.text, (
        "a source-only trailing space right at a list-item boundary must not "
        "produce a different Article.text")
    assert "verlangen;3." not in art_a.text
    assert "verlangen; 3." in art_a.text or "verlangen; 3" in art_a.text


def test_adjacent_paragraph_siblings_always_get_a_real_separator():
    """Fedlex does not always keep the same structure for the same content
    across editions: measured on the live OR (art_362), one edition renders
    a long cross-reference list as a proper <blockList> of <item> elements
    (already covered -- "item" is block-tagged), the very next edition
    flattens the SAME list into a bare sequence of sibling <p> elements with
    no intervening whitespace in the source at all. Two sibling <p>
    elements are always two separate blocks of text, never one word running
    through a hidden element boundary, so this must never depend on
    whether the source happens to have whitespace between them."""
    xml = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
           b'<act><body><article eId="art_1"><num>Art. 1</num>'
           b'<paragraph eId="art_1/para_1"><num>1</num><content>'
           b'<p>Artikel 321e: (Haftung des Arbeitnehmers)</p>'
           b'<p>Artikel 322a: Absaetze 2 und 3</p>'
           b'</content></paragraph></article></body></act></akomaNtoso>')
    art = akn.parse_articles(xml)[0]
    assert "Arbeitnehmers)Artikel" not in art.text
    assert "Arbeitnehmers) Artikel" in art.text
