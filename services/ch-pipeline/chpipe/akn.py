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
# A sentinel block-boundary separator for plain_text(), safe to split on
# afterward: not whitespace (so _WS never touches it while it's still in
# the pieces list) and not a character any real AKN document text would
# ever contain.
_LINE_BREAK = "\x00"

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
    return _WS.sub(" ", "".join(_walk_pieces(element, " "))).strip()


def _walk_pieces(element, block_sep: str) -> list[str]:
    """The recursive walk _text_of() runs, factored out so plain_text() can
    reuse the exact same inline-vs-block logic with a different separator
    (a sentinel that becomes a real newline, rather than a space) -- see
    plain_text()'s docstring for why the two must not diverge."""
    pieces: list[str] = []
    if element.text:
        pieces.append(element.text)
    for child in element:
        local = etree.QName(child).localname
        is_block = local in _BLOCK_TAGS
        if is_block:
            pieces.append(block_sep)
        pieces.extend(_walk_pieces(child, block_sep))
        if is_block:
            pieces.append(block_sep)
        if child.tail:
            pieces.append(child.tail)
    return pieces


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
    return _articles_of(_root(xml))


def _articles_of(root) -> list[Article]:
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

    Kept consistent with Article.text by construction, not just by intent:
    this used to strip and join every raw itertext() fragment independently
    (one fragment per line), which both re-introduced the inline-markup
    word-splitting defect _text_of() exists to avoid (a <b> splitting a
    word would come back as two separate LINES, not just two words) and
    left <authorialNote> footnote text in the output after Article.text
    stopped carrying it -- so ch_act_version.full_text and
    ch_act_article.text disagreed about what an article actually says.
    Notes are stripped the same way parse_articles() strips them (see
    _strip_notes()), and the same _walk_pieces() logic that builds
    Article.text builds this too, with "\\n" as the block-boundary
    separator instead of " " -- one paragraph/item/p per line, same
    inline-vs-block distinction, same word boundaries.
    """
    return _plain_text_of(_root(xml))


def _plain_text_of(root) -> str:
    body = root.find(".//" + _AKN + "body")
    if body is None:
        return ""
    _strip_notes(body)
    raw = "".join(_walk_pieces(body, _LINE_BREAK))
    lines = [_WS.sub(" ", segment).strip() for segment in raw.split(_LINE_BREAK)]
    return "\n".join(line for line in lines if line)


def parse_edition(xml: bytes) -> tuple[list[Article], str]:
    """Both products of ONE parse: the articles and the plain text.

    parse_articles() and plain_text() each did their own etree.fromstring()
    and their own note-stripping walk over the same document, which roughly
    doubled the cost of parse_akn_stage -- 12,033 editions, the stage with
    the least headroom on a box serving live traffic.

    THE ORDER HERE IS LOAD-BEARING, and it is why this is a function rather
    than two calls at the call site. _strip_notes() removes <authorialNote>
    subtrees IN PLACE and returns their text. _articles_of() uses that return
    value to populate Article.notes; _plain_text_of() only wants them gone.
    So articles must be read first: doing it the other way round strips every
    note out of the body before the articles are walked, and each Article
    comes back with notes=() -- the amendment provenance migration 197's
    ch_act_article.notes column exists to hold, lost in silence.

    Running them in this order over one tree is otherwise identical to two
    independent parses: _strip_notes() is idempotent (a second call finds
    nothing left to remove), and neither reader depends on the notes still
    being in the tree.
    """
    root = _root(xml)
    articles = _articles_of(root)
    return articles, _plain_text_of(root)


def frbr_dates(xml: bytes) -> dict[str, str]:
    """The dates the document asserts about itself, for cross-checking SPARQL."""
    root = _root(xml)
    dates: dict[str, str] = {}
    for element in root.iter(_AKN + "FRBRdate"):
        name, value = element.get("name"), element.get("date")
        if name and value and name not in dates:
            dates[name] = value
    return dates
