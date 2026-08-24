"""Amendment provenance from Akoma Ntoso footnotes.

Fedlex publishes no "amends" relation -- verified by enumerating every
predicate on jolux:Act and jolux:ConsolidationAbstract on 2026-08-23 (see
migration 198's header comment: jolux:basicAct is establishment, not
amendment, and jolux:rectifies / jolux:isFollowingAct are the only other
structured links there are). What it does publish is the traditional Swiss
footnote, in prose, attached to the amended article:

    Eingefügt durch Ziff. I des BG vom 5. Okt. 1990, in Kraft seit 1. Juli 1991
    (AS 1991 846; BBl 1986 II 354).

This module and the computed edition diff (chpipe/diff_articles.py) are the
only two sources of amendment history that exist for this corpus. This one
turns the footnote prose into rows. It is a best effort over natural
language, so every row keeps its raw_note; a parse that silently drops the
source text is a parse nobody can audit.

Not every <authorialNote> is an amendment note. A plain cross-reference
("SR 943.03") or a bare publication footnote ("BBl 1905 II 1, 1909 III 725,
1911 I 845" -- three OLD BBl citations for one law's original enactment, no
verb at all) carries neither a recognised action nor an AS reference, and
extract() drops both rather than inventing provenance for them.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

from lxml import etree

from chpipe.akn import AKN_NS

_AKN = "{%s}" % AKN_NS
_AKN_ARTICLE = _AKN + "article"
_AKN_AUTHORIAL_NOTE = _AKN + "authorialNote"

# German AS/BBl and their French/Italian equivalents: RO/FF (fr), RU/FF (it).
# FF serves both French and Italian, so it appears once.
#
# The volume number is 1-4 digits, not fixed at 4: the Amtliche Sammlung
# switched to year-numbered volumes only in 1948 ("AS 1991 846"); footnotes
# on articles from before that still cite the old sequential-volume scheme
# ("AS 53 185", "AS 27 317" -- volume 53, page 185) and the OR (in force
# since 1912) carries plenty of those. The optional roman numeral between
# the volume and the page is the same half-year-volume marker BBl already
# needed ("AS 1949 I 802"), just less common on AS because AS was not
# generally split into half-year volumes; both were found live in the OR,
# not assumed from the format's history.
_AS_REFERENCE = re.compile(r"\b(AS|RO|RU)\s+(\d{1,4}\s+(?:[IVX]+\s+)?\d+)")
_BBL_REFERENCE = re.compile(r"\b(BBl|FF)\s+(\d{4}\s+[IVX]+\s+\d+|\d{4}\s+\d+)")

# Ordered so a more specific phrase (German "Fassung gemäss") is tried before
# a shorter one could ever false-positive on the same note -- none currently
# overlap, but the order documents that the check is "first match wins",
# not "all match and the last one sticks".
#
# Case-insensitive: measured on the full OR, "Eingefügt"/"Aufgehoben" are not
# always sentence-initial -- "Zweiter Satz eingefügt durch ..." and "Zweiter
# Satz aufgehoben durch ..." lower-case the verb because it now follows a
# noun phrase mid-sentence (7 and 28 occurrences respectively). The verb is
# the same amendment either way; the classification must not depend on
# where in the sentence it lands.
_ACTIONS = {
    "de": (
        ("inserted", re.compile(r"\bEingefügt\b", re.IGNORECASE)),
        ("repealed", re.compile(r"\bAufgehoben\b", re.IGNORECASE)),
        ("amended", re.compile(r"\bFassung gemäss\b", re.IGNORECASE)),
    ),
    "fr": (
        ("inserted", re.compile(r"\bIntroduit\b", re.IGNORECASE)),
        ("repealed", re.compile(r"\bAbrogé", re.IGNORECASE)),
        ("amended", re.compile(r"\bNouvelle teneur selon\b", re.IGNORECASE)),
    ),
    "it": (
        ("inserted", re.compile(r"\bIntrodotto\b", re.IGNORECASE)),
        ("repealed", re.compile(r"\bAbrogato\b", re.IGNORECASE)),
        ("amended", re.compile(r"\bNuovo testo giusta\b", re.IGNORECASE)),
    ),
}

# German abbreviates ("Okt.", "Dez.", "Jan.") but spells "Juli" and "März"
# out in full -- both forms are real, measured in the brief's examples, so
# the regex below strips a trailing "." unconditionally and this table
# keys on the abbreviation with the dot already removed. French and
# Italian months are here too: parse_note is a single function for all
# three languages, keyed by lang only for which _ACTIONS entry to try.
_MONTHS = {
    "jan": 1, "januar": 1, "janv": 1, "janvier": 1, "gennaio": 1, "genn": 1,
    "feb": 2, "febr": 2, "februar": 2, "février": 2, "fev": 2, "febbraio": 2,
    "mär": 3, "märz": 3, "mars": 3, "marzo": 3, "mar": 3,
    "apr": 4, "april": 4, "avril": 4, "aprile": 4, "avr": 4,
    "mai": 5, "maggio": 5, "magg": 5,
    "jun": 6, "juni": 6, "juin": 6, "giugno": 6, "giu": 6,
    "jul": 7, "juli": 7, "juil": 7, "juillet": 7, "luglio": 7, "lug": 7,
    "aug": 8, "august": 8, "aout": 8, "agosto": 8, "ago": 8,
    "sep": 9, "sept": 9, "september": 9, "septembre": 9, "settembre": 9,
    "set": 9,
    "okt": 10, "oktober": 10, "oct": 10, "octobre": 10, "ottobre": 10,
    "ott": 10,
    "nov": 11, "november": 11, "novembre": 11,
    "dez": 12, "dezember": 12, "dec": 12, "décembre": 12, "decembre": 12,
    "dicembre": 12, "dic": 12,
}

# "5. Okt. 1990", "1er juil. 1991", "15. Febr. 2001": day, optional French
# ordinal suffix, optional trailing dot on the day, month word (with or
# without its own trailing dot), year. Month word matched greedily up to
# the next space so "Febr." and "Juli" are both captured whole; the dot is
# stripped in _parse_date before the _MONTHS lookup.
_DATE = re.compile(
    r"(\d{1,2})(?:er)?\.?\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})")

# The verb that introduces the EFFECTIVE date, as opposed to the amending
# act's own date (see _SOURCE_ACT below) -- a single note carries both and
# they are different fields (see test_reads_the_date_of_the_amending_act
# alongside test_reads_in_kraft_seit_as_the_effective_date). The 40-char cap
# on the capture keeps a runaway match from crossing into an unrelated
# sentence later in a long note.
_EFFECTIVE = re.compile(
    r"(?:in\s+Kraft\s+seit|mit\s+Wirkung\s+seit|"
    r"en\s+vigueur\s+depuis(?:\s+le)?|con\s+effetto\s+dal|"
    r"in\s+vigore\s+dal)\s*(.{0,40})",
    re.IGNORECASE)

# "vom 5. Okt. 1990" (de), "du 5 oct. 1990" (fr), "del 5 ott. 1990" (it) --
# the date of the amending act itself, always introduced by this
# preposition right after the act's own designation ("BG", "LF", "LF").
_SOURCE_ACT = re.compile(
    r"\b(?:vom|du|del)\s+(\d{1,2}(?:er)?\.?\s+[A-Za-zÀ-ÿ]+\.?\s+\d{4})",
    re.IGNORECASE)


@dataclass(frozen=True)
class Provenance:
    e_id: str
    action: str | None
    as_reference: str | None
    bbl_reference: str | None
    effective_date: datetime.date | None
    source_act_date: datetime.date | None
    raw_note: str


def _parse_date(fragment: str | None) -> datetime.date | None:
    if not fragment:
        return None
    match = _DATE.search(fragment)
    if not match:
        return None
    day, month_word, year = match.groups()
    month = _MONTHS.get(month_word.rstrip(".").lower())
    if not month:
        return None
    try:
        return datetime.date(int(year), month, int(day))
    except ValueError:
        return None


def parse_note(text: str, lang: str = "de") -> dict:
    """Parse one footnote's already-flattened text.

    Collapses whitespace first: extract() hands this raw itertext() output
    (see chpipe/akn.py's _text_of docstring for why notes are NOT run
    through that same inline/block logic -- a footnote has no block
    structure of its own to preserve, so a plain whitespace collapse is
    enough and does not need the word-boundary care _text_of exists for).
    """
    note = " ".join((text or "").split())

    action = None
    for name, pattern in _ACTIONS.get(lang, _ACTIONS["de"]):
        if pattern.search(note):
            action = name
            break

    as_match = _AS_REFERENCE.search(note)
    bbl_match = _BBL_REFERENCE.search(note)
    effective = _EFFECTIVE.search(note)
    source = _SOURCE_ACT.search(note)

    return {
        "action": action,
        "as_reference": (f"{as_match.group(1)} {as_match.group(2)}"
                          if as_match else None),
        "bbl_reference": (f"{bbl_match.group(1)} {' '.join(bbl_match.group(2).split())}"
                           if bbl_match else None),
        "effective_date": _parse_date(effective.group(1)) if effective else None,
        "source_act_date": _parse_date(source.group(1)) if source else None,
        "raw_note": note,
    }


def _owning_article(element) -> str | None:
    """Walk up from a note to the nearest enclosing <article>'s eId.

    Notes carry no eId of their own (measured: with_eId=0 on both the
    fixture and the full OR), so this walk is the only way to attribute one
    to a provision. A note that never reaches an <article> -- one attached
    to the act as a whole, e.g. a top-level SR cross-reference -- returns
    None and extract() drops it: Provenance.e_id is NOT NULL, and
    ch_article_provenance.e_id is NOT NULL (migration 198), so inventing a
    synthetic anchor to keep such a row would put a made-up value in a
    column callers treat as a real citation.
    """
    parent = element.getparent()
    while parent is not None:
        if parent.tag == _AKN_ARTICLE:
            return parent.get("eId")
        parent = parent.getparent()
    return None


def extract(xml: bytes, lang: str = "de") -> list[Provenance]:
    """Amendment provenance for every article-attached note in `xml`.

    Two kinds of note are dropped, both deliberately: a note that never
    reaches an enclosing <article> (see _owning_article), and one that
    reaches an article but is not an amendment -- a plain cross-reference
    ("SR 943.03") or a bare publication footnote parses with neither an
    action nor an AS reference, and a row with neither is not provenance,
    it is noise that would otherwise sit in the table looking like fact.
    """
    root = etree.fromstring(xml)
    rows: list[Provenance] = []
    for note in root.iter(_AKN_AUTHORIAL_NOTE):
        e_id = _owning_article(note)
        if not e_id:
            continue
        parsed = parse_note("".join(note.itertext()), lang=lang)
        if not parsed["action"] and not parsed["as_reference"]:
            continue
        rows.append(Provenance(e_id=e_id, **parsed))
    return rows
