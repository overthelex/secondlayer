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

# "Art. 12a" -> "12a"; "Art. 111-14" -> "111-14"
_NUMBER = re.compile(r"(\d+[a-zA-Z]*(?:[-–—]\d+[a-zA-Z]*)?)")
_DASHES = str.maketrans({"–": "-", "—": "-", " ": " "})


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


def _root(xml: bytes):
    try:
        return etree.fromstring(xml)
    except etree.XMLSyntaxError as exc:
        raise AknParseError(str(exc)) from exc


def _text_of(element) -> str:
    parts = [t.strip() for t in element.itertext() if t and t.strip()]
    return " ".join(parts)


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
