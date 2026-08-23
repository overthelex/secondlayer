"""Akoma Ntoso (Fedlex flavour) -> articles and plain text.

Structure verified 2026-08-23 against the OR, German, edition 2026-01-01:

  <akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">
    <act>
      <meta>... <FRBRdate name="jolux:dateApplicability" date="2026-01-01"/> ...</meta>
      <body>
        <article eId="art_1">
          <num><b>Art. 1</b></num>
          <paragraph eId="art_1/para_1"><num>1</num><content><p>…</p></content></paragraph>

Two facts that shape this module:
  * eIds can be paths ("disp_u17/art_7"), so article NUMBERS repeat inside one
    act and only the eId identifies an article.
  * That act contains zero <heading> elements as direct children of <article>,
    so marginal_note is usually None and must not be treated as required.

A missing <body> is a real Fedlex shape, not always a broken download. The
OASIS AKN 3.0 XSD makes <body> mandatory inside <act>, so an earlier version
of this module treated its absence as proof of truncation and raised. A
small live slice of real editions (task 6) disproved that: eli/cc/1/
598_557_598/18750702 -- a one-page 1875 Bundesbeschluss whose <act> holds
only <meta>, <preface> and <preamble> -- is schema-invalid by that rule and
is still exactly what Fedlex serves; nothing about the download is
truncated. Nineteenth-century Swiss federal resolutions predate the
<body>/<article> structure this schema assumes. plain_text() now returns ""
for a body-less document instead of raising -- see its docstring for the
full reasoning, including why the fallback to the whole document is still
refused.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import etree

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
_AKN = "{%s}" % AKN_NS
_AKN_AUTHORIAL_NOTE = _AKN + "authorialNote"

# "Art. 12a" -> "12a"; "Art. 111-14" -> "111-14"
_NUMBER = re.compile(r"(\d+[a-zA-Z]*(?:[-–—]\d+[a-zA-Z]*)?)")
# Every dash variant the regex's own [-–—] class does NOT already recognise
# (U+2010 hyphen, U+2011 non-breaking hyphen, U+2212 minus sign), folded to a
# plain hyphen before the regex runs -- and a real non-breaking space fold,
# not the U+0020->U+0020 no-op this table used to carry (that entry read as
# an NBSP fold and was not one; see diff_articles.py's identical table and
# fix for the same defect).
_DASHES = str.maketrans({
    "–": "-", "—": "-", "‐": "-", "‑": "-", "−": "-", " ": " ",
})
_WS = re.compile(r"\s+")

# Structural (block-level) AKN elements: a numbered paragraph, a list item, a
# list, the num/heading label on either of those. Crossing one of these is
# ALWAYS a real boundary between two separate units of law -- a numbered
# clause never runs on into the next one the way a word can run through an
# inline <b>/<i>/<ref> -- so _text_of() guarantees at least one separator at
# their edges regardless of what whitespace (if any) the source happens to
# carry right at the boundary. Fedlex is not consistent about that source
# whitespace: measured on the live OR (art_963_a), one edition's <p> inside a
# <blockList> <item> ends "...verlangen;</p>", the very next edition's ends
# "...verlangen; </p>" (one added space, no other difference anywhere in the
# article) -- joining itertext() fragments with "" (see _text_of's docstring
# for why that is right for INLINE markup) preserved that difference
# verbatim and fabricated a "modified" row out of nothing.
#
# "p" is in this set too, for a related but distinct reason: Fedlex does not
# keep the same STRUCTURE for the same content across editions. Measured on
# the live OR (art_362): one edition renders a long cross-reference list as
# a <blockList> of <item> elements (already covered by "item"/"blockList"
# above); the very next edition flattens the identical list into a bare
# sequence of sibling <p> elements with no whitespace between them in the
# source at all -- "(Haftung des Arbeitnehmers)Artikel 322a: ..." rather
# than "... Arbeitnehmers) Artikel 322a: ...". Two sibling <p> elements are
# always two separate blocks of text, never one word running through a
# hidden boundary, exactly like two <item>s.
#
# Anything NOT in this set (b, i, ref, and any other markup that can
# legally sit mid-word) is treated as inline: no separator is forced
# around it.
_BLOCK_TAGS = frozenset({
    "paragraph", "subparagraph", "clause", "point", "indent", "alinea",
    "list", "blockList", "item", "level", "content", "mainBody",
    "listIntroduction", "num", "heading", "subheading", "intro", "wrapUp",
    "tblock", "hcontainer", "p",
})


class AknParseError(ValueError):
    pass


@dataclass(frozen=True)
class Article:
    e_id: str
    article_number: str | None
    marginal_note: str | None
    text: str
    ordinal: int
    parent_e_id: str | None
    # Fedlex embeds footnotes and amendment-effective-date citations as
    # <authorialNote> children directly inside the operative text -- inside
    # <num> (an amendment citation on the article number itself) and inside
    # body <paragraph> content (a cross-reference note). They are stripped
    # out of `text` (see _strip_notes()) and kept here instead: a
    # footnote-only correction (fixing a citation from "BBl 1999 2829" to
    # "BBl 1999 III 2829") must not read as an amendment to the provision,
    # but the note's own text is not nothing -- it is exactly the amendment
    # provenance a future stage over this corpus wants, so it gets a field
    # of its own rather than disappearing. Default () for any article with
    # none, so a positional or keyword construction elsewhere that predates
    # this field keeps working.
    notes: tuple[str, ...] = ()


def _root(xml: bytes):
    try:
        return etree.fromstring(xml)
    except etree.XMLSyntaxError as exc:
        raise AknParseError(str(exc)) from exc


def _text_of(element) -> str:
    """Concatenate `element`'s text content, collapsing the source's own
    whitespace runs (line-wraps, indentation) into single spaces -- WITHOUT
    manufacturing a space at an INLINE-markup boundary that had none in the
    source, but ALWAYS inserting one at a BLOCK-level boundary (a list item,
    a numbered paragraph -- see _BLOCK_TAGS) whether the source had one
    there or not.

    Two distinct defects motivate the two halves of this rule, both
    measured on the live OR:

      * A <b> wrapping only "nic" inside the word "nicht" (no surrounding
        whitespace in the source) came back as two words, "nic ht", when an
        earlier version of this function stripped every itertext() fragment
        individually and rejoined them with a literal " " -- that cannot
        tell "no whitespace here in the source" from "there was, but I just
        stripped it off". Concatenating raw (unstripped) fragments fixes
        this: a real word boundary in mixed content always has real
        whitespace in the source's own text nodes already.

      * The opposite fix, applied uniformly, broke the next thing: two
        <item> elements of the same <blockList> are separate numbered
        clauses, never a word split across an element boundary, but Fedlex
        is not consistent about whether a source <p> just inside one
        <item> carries a trailing space before the next <item> starts (one
        edition: "...verlangen;</p>"; the next: "...verlangen; </p>", no
        other difference in the article). Concatenating those fragments
        raw would preserve that difference verbatim and fabricate a
        "modified" row out of a single re-typeset space. Crossing a
        _BLOCK_TAGS boundary therefore always counts as a separator,
        independent of the source's own whitespace right at that edge.
    """
    pieces: list[str] = []

    def walk(el) -> None:
        if el.text:
            pieces.append(el.text)
        for child in el:
            local = etree.QName(child).localname
            if local in _BLOCK_TAGS:
                pieces.append(" ")
            walk(child)
            if local in _BLOCK_TAGS:
                pieces.append(" ")
            if child.tail:
                pieces.append(child.tail)

    walk(element)
    return _WS.sub(" ", "".join(pieces)).strip()


def _strip_notes(element) -> tuple[str, ...]:
    """Remove every <authorialNote> subtree under `element` in place, and
    return the removed notes' own text, in document order.

    with_tail=False keeps the removed note's tail text (whatever follows it
    in its parent) instead of discarding it -- that tail is real operative
    content that happens to sit right after a footnote reference, not part
    of the note. See the Article.notes docstring for why the notes are kept
    at all rather than just discarded along with their text.
    """
    notes = tuple(_text_of(note) for note in element.iter(_AKN_AUTHORIAL_NOTE))
    etree.strip_elements(element, _AKN_AUTHORIAL_NOTE, with_tail=False)
    return notes


def normalise_number(raw: str | None) -> str | None:
    """'Art. 1' -> '1'. Folds en and em dashes, which occur inside a single act."""
    if not raw:
        return None
    match = _NUMBER.search(raw.translate(_DASHES))
    return match.group(1) if match else None


def parse_articles(xml: bytes) -> list[Article]:
    root = _root(xml)
    articles: list[Article] = []
    for ordinal, element in enumerate(root.iter(_AKN + "article"), start=1):
        e_id = element.get("eId")
        if not e_id:
            continue
        # Strip authorial notes (and capture their text) before reading num,
        # heading or body text off this element, so none of the three picks
        # up a footnote's wording. See Article.notes and _strip_notes().
        notes = _strip_notes(element)
        num_element = element.find(_AKN + "num")
        heading_element = element.find(_AKN + "heading")

        body_parts: list[str] = []
        for child in element:
            if child.tag in (_AKN + "num", _AKN + "heading"):
                continue
            body_parts.append(_text_of(child))
        text = " ".join(p for p in body_parts if p)

        articles.append(Article(
            e_id=e_id,
            article_number=normalise_number(
                _text_of(num_element) if num_element is not None else None),
            marginal_note=(_text_of(heading_element)
                           if heading_element is not None else None),
            text=text,
            ordinal=ordinal,
            parent_e_id=e_id.rsplit("/", 1)[0] if "/" in e_id else None,
            notes=notes,
        ))
    return articles


def plain_text(xml: bytes) -> str:
    """Text of the act's <body> only.

    Deliberately does NOT fall back to the whole document when <body> is
    missing: the root also holds <meta> (FRBRdate values, identifiers,
    classifications), and silently vacuuming that into what a later stage
    stores as "the edition's text" would put metadata junk into a field
    meant to hold only the act's substantive content.

    A missing <body> does NOT raise. The OASIS AKN 3.0 schema makes <body>
    mandatory inside <act>, which is why an earlier version of this function
    treated a missing one as proof of a truncated download. A live Fedlex
    edition disproved that: eli/cc/1/598_557_598/18750702 (a one-page 1875
    Bundesbeschluss, "betreffend die Leistungen der Stadt Bern an den
    Bundessitz") is schema-INVALID by that rule -- its <act> holds only
    <meta>, <preface> and <preamble>, no <body> anywhere, and the resolution
    text itself is IN the <preamble> -- yet it parses cleanly and is exactly
    what Fedlex serves for that consolidation; there is no truncation, no
    HTTP error, nothing to retry. fetch_xml_stage now checks the AKN
    namespace before anything is stored, so a genuinely broken or non-AKN
    download is already caught before this function ever sees it -- a
    missing <body> here can only mean a real edition shaped like this one.
    It is recorded honestly instead: empty text, same as parse_articles()
    already returns zero articles for a body-less document with no
    <article> elements to find.
    """
    root = _root(xml)
    body = root.find(".//" + _AKN + "body")
    if body is None:
        return ""
    lines = [t.strip() for t in body.itertext() if t and t.strip()]
    return "\n".join(lines)


def frbr_dates(xml: bytes) -> dict[str, str]:
    """The dates the document asserts about itself, for cross-checking SPARQL."""
    root = _root(xml)
    dates: dict[str, str] = {}
    for element in root.iter(_AKN + "FRBRdate"):
        name, value = element.get("name"), element.get("date")
        if name and value and name not in dates:
            dates[name] = value
    return dates
