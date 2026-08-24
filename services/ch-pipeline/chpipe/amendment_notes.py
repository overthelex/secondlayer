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

Not every <authorialNote> is an amendment note, and not every note describes
only ONE amendment. See _split_events() and _is_amendment() below for the two
rules that decide, respectively, how many rows one note produces and which
of them are kept.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

from chpipe import akn

_AKN = "{%s}" % akn.AKN_NS
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

# Case-insensitive: measured on the full OR, "Eingefügt"/"Aufgehoben" are not
# always sentence-initial -- "Zweiter Satz eingefügt durch ..." lower-cases
# the verb once it follows a noun phrase mid-sentence. Measured directly (not
# assumed): 7 notes carry a lower-case "eingefügt" that a capital-only
# pattern would have missed (5 read "Zweiter Satz eingefügt", 2 read "Zweiter
# Satze eingefügt" -- a genuine typo in the source, same verb); 3 carry a
# lower-case "aufgehoben" -- one "Zweiter Satz aufgehoben durch ..." with a
# full citation, and two bare editorial pointers with no citation at all
# ("Diese Art. sind heute aufgehoben.", "Dieser Art. ist heute aufgehoben.").
# All three are treated as real repeals: no citation does not mean no event,
# only that this particular row will carry no AS/BBl reference.
#
# NOT mutually exclusive within one note: a note that records two successive
# amendments (an insertion later repealed, say) matches both "Eingefügt" and
# "Aufgehoben" -- 61 of the notes on the full OR do exactly this. That is
# not a defect in this table; it is exactly why _split_events() exists
# below. First-match-wins only needs to be safe WITHIN one already-split
# event sentence, where by construction only that sentence's own verb can
# start it.
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
# the regex below strips a trailing "." unconditionally and this table keys
# on the abbreviation with the dot already removed. _parse_date does not
# fold accents, so an accented abbreviation ("déc", "août", "fév") needs its
# own key -- an unaccented "dec"/"aout"/"fev" key does not match real French
# text and only papers over the gap in a table dump, not in a parse. French
# and Italian months are here too: parse_note is a single function for all
# three languages, keyed by lang only for which _ACTIONS entry to try.
# "gen"/"mag" are the standard Italian abbreviations for gennaio/maggio
# (Fedlex Italian editions use them, parallel to French "janv"/"avr");
# without them an Italian date landing in January or May would silently
# fail the same way the missing accents failed French.
_MONTHS = {
    "jan": 1, "januar": 1, "janv": 1, "janvier": 1, "gennaio": 1, "genn": 1,
    "gen": 1,
    "feb": 2, "febr": 2, "februar": 2, "février": 2, "fév": 2, "febbraio": 2,
    "mär": 3, "märz": 3, "mars": 3, "marzo": 3, "mar": 3,
    "apr": 4, "april": 4, "avril": 4, "aprile": 4, "avr": 4,
    "mai": 5, "maggio": 5, "magg": 5, "mag": 5,
    "jun": 6, "juni": 6, "juin": 6, "giugno": 6, "giu": 6,
    "jul": 7, "juli": 7, "juil": 7, "juillet": 7, "luglio": 7, "lug": 7,
    "aug": 8, "august": 8, "août": 8, "agosto": 8, "ago": 8,
    "sep": 9, "sept": 9, "september": 9, "septembre": 9, "settembre": 9,
    "set": 9,
    "okt": 10, "oktober": 10, "oct": 10, "octobre": 10, "ottobre": 10,
    "ott": 10,
    "nov": 11, "november": 11, "novembre": 11,
    "dez": 12, "dezember": 12, "déc": 12, "décembre": 12, "dicembre": 12,
    "dic": 12,
}

# "5. Okt. 1990", "1er juil. 1991", "1° gen. 2005": day, optional ordinal
# suffix (French "er", Italian "°"), optional trailing dot on the day, month
# word (with or without its own trailing dot), year. Month word matched
# greedily up to the next space so "Febr." and "Juli" are both captured
# whole; the dot is stripped in _parse_date before the _MONTHS lookup.
_DATE = re.compile(
    r"(\d{1,2})(?:er|°)?\.?\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})")

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

# Bare pointers to a change history rather than a description of a change to
# THIS article -- see _is_amendment()'s docstring for the full reasoning and
# the four real shapes measured on the full OR. The gap between "unter" and
# "konsultiert" holds the AS reference itself, up to "unter AS 1949 I 802
# konsultiert" (14 characters) on the full OR -- a first draft capped this
# at 10 and silently matched nothing, which is how this pointer phrasing
# ended up in the "keep" bucket instead of being dropped by it.
_CHANGE_LOG_POINTER = re.compile(
    r"\bkönnen\s+unter\b.{0,40}\bkonsultiert\s+werden\b", re.IGNORECASE)

# A bracketed publication history -- "[AS 1972 1502; 1977 1269; 1982 1234;
# 1987 1189]" -- is typographically distinct from a prose sentence: every
# one measured on the full OR (11 of them) is the ENTIRE note, opening
# bracket first, nothing before it. A residue-based check (strip every
# citation, see what prose is left) cannot tell these apart from a real
# amendment sentence like "Ausdruck gemäss ... (AS 1994 2386)", because
# both leave behind non-citation letters -- "Ziff.", "Art.", "Anhang",
# "Abs." are legal cross-reference abbreviations, not proof of a sentence
# about THIS article. The leading bracket is the actual signal Fedlex uses
# to mark "this is a list", so it is checked directly instead.
_BRACKETED_LIST = re.compile(r"^\s*\[")


def _unsupported_lang(lang: str) -> ValueError:
    return ValueError(
        f"unsupported lang {lang!r}; expected one of {sorted(_ACTIONS)} -- "
        "classifying against the wrong language's verbs would silently "
        "read as zero matches rather than an error.")


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
    """Parse one amendment EVENT's already-flattened text.

    "One event" matters: a note that documents two successive amendments
    (inserted in 1990, later repealed in 2000) must be pre-split by the
    caller with _split_events() first. Called directly on such a note, this
    function's first-match-wins _ACTIONS scan would report the FIRST verb's
    action next to citations that could belong to the LAST verb's event
    (both AS_REFERENCE and _EFFECTIVE just take the nearest match in the
    whole string) -- exactly the wrong-event-blend extract() no longer lets
    happen. See the module docstring and _split_events().

    Collapses whitespace first: extract() hands this raw itertext() output
    (see chpipe/akn.py's _text_of docstring for why notes are NOT run
    through that same inline/block logic -- a footnote has no block
    structure of its own to preserve, so a plain whitespace collapse is
    enough and does not need the word-boundary care _text_of exists for).
    """
    if lang not in _ACTIONS:
        raise _unsupported_lang(lang)

    note = " ".join((text or "").split())

    action = None
    for name, pattern in _ACTIONS[lang]:
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


def _split_events(note: str, lang: str) -> list[str]:
    """Split one <authorialNote>'s text into one segment per amendment
    EVENT, so a note recording two successive amendments produces two rows
    instead of one row whose fields are welded from both acts.

    Measured on the full OR: 61 of 748 rows (8.2%, at the pre-split
    baseline) came from a note like

        "Eingefügt durch Ziff. I des BG vom 5. Okt. 1990 (AS 1991 846;
        BBl 1986 II 354). Aufgehoben durch Anhang Ziff. 5 des
        Gerichtsstandsgesetzes vom 24. März 2000, mit Wirkung seit 1. Jan.
        2001 (AS 2000 2355; ...)."

    parse_note() on the WHOLE thing reports action='inserted' (first verb
    match wins) next to as_reference='AS 1991 846' (the 1990 act, correct
    for that verb) but effective_date=2001-01-01 (the LAST "mit Wirkung
    seit" in the string, which belongs to the 2000 repeal, not the 1990
    insertion). Three fields, no two describing the same event, and the
    repeal itself never gets a row.

    The split point is the START of each action verb after the first: a
    verb is always where a new sentence about a new event begins (measured;
    every multi-event note found has exactly this shape, one full
    "Verb ... (AS ...; BBl ...)." sentence per event), so text from the
    document start up to the SECOND verb's start is event 1, text from the
    second verb's start to the third verb's start (if any) is event 2, and
    so on. A note with 0 or 1 verb matches is not split -- it is returned
    as its own single-element list, so parse_note() behaves exactly as it
    did before this function existed for the common case.

    Order is preserved (document order in, document order out) so a
    consumer reading a stream of rows for one e_id can treat the LAST row
    as that article's current state -- see extract()'s docstring.
    """
    if lang not in _ACTIONS:
        raise _unsupported_lang(lang)

    starts = sorted(
        match.start()
        for _, pattern in _ACTIONS[lang]
        for match in pattern.finditer(note)
    )
    if len(starts) <= 1:
        return [note]

    # Event 1 runs from the document start (not from starts[0]: any lead-in
    # text before the first verb, if there ever is any, belongs with the
    # first event rather than being silently dropped) up to the second
    # verb's start.
    boundaries = [0, *starts[1:], len(note)]
    return [note[a:b].strip() for a, b in zip(boundaries, boundaries[1:])]


def _is_amendment(parsed: dict) -> bool:
    """Whether one already-split event's parse describes a change to THIS
    article, as opposed to a footnote that merely mentions an AS number
    while pointing somewhere else.

    The brief's rule ("action" is set OR "as_reference" is set) is too
    loose. Measured directly on the full OR, post-split: 897 event segments
    sit inside an article; of the 809 that have an action or an AS/BBl
    reference, 45 have an AS reference but no recognised verb. Read one by
    one, those 45 split into four real shapes -- 19 that ARE this
    article's own provenance, 26 that are not:

      * 19 KEPT: "Ausdruck gemäss ..." (a single term changed), "Fassung
        [erster/des zweiten] Satzes gemäss ..." (a named part of the
        article re-worded), and "Berichtigt von der Redaktionskommission
        der BVers (Art. 33 GVG -- AS 1974 1051)." -- a correction made by
        the drafting commission under its own statutory authority, not by
        a later amending act. None of these three is one of the three
        verbs this module classifies (action stays None), but each is a
        real, cited sentence describing a change to THIS article's text.
        "Berichtigt" is the one worth arguing about either way: Fedlex
        itself models a correction as jolux:rectifies, a relation of its
        own, distinct from an amendment but not nothing -- dropping it
        would erase a real, cited edit to this exact provision. What
        distinguishes all 19 from the 26 dropped below is that every one
        of them is a full sentence ABOUT this article, not a list or a
        pointer that happens to contain an AS number.
      * 11 DROPPED: a bracketed publication history of a DIFFERENT,
        already-repealed act -- "[AS 1972 1502; 1977 1269; 1982 1234;
        1987 1189]". The AS numbers are that other act's amendment trail,
        not this article's. Every one measured is the entire note,
        opening bracket first -- see _BRACKETED_LIST.
      * 12 DROPPED: "Die Änderungen können unter AS 1971 1465 konsultiert
        werden." -- a pointer telling the reader where to go look, not a
        description of a change. See _CHANGE_LOG_POINTER.
      * 3 DROPPED (caught by the bare-citation residue check below,
        applied last): a bare citation with nothing else -- "AS 53 185".
        No verb, no surrounding prose; a floating number is not "this
        article was amended", it is exactly the same shape as the SR
        cross-reference the brief's own rule already excludes when there
        is no AS prefix.

    So the rule is: keep a row with a recognised action outright. Otherwise
    require an AS/BBl reference AND that the note is not a bracketed list
    and not a change-log pointer AND that something besides the citation(s)
    themselves is in the note at all.
    """
    if parsed["action"]:
        return True
    if not parsed["as_reference"]:
        return False
    if _BRACKETED_LIST.match(parsed["raw_note"]):
        return False
    if _CHANGE_LOG_POINTER.search(parsed["raw_note"]):
        return False
    # A bare citation with no action verb and no prose beyond the
    # reference(s) themselves -- "AS 53 185". Strip every AS/BBl match and
    # the trailing punctuation such a bare citation carries; if nothing is
    # left, the note is only ever a citation, not a sentence describing an
    # event. (A bracketed LIST of citations is already excluded above --
    # this residue check alone cannot tell such a list apart from a real
    # amendment sentence, because both leave behind non-citation letters:
    # "Ziff.", "Art.", "Anhang" are legal cross-reference abbreviations
    # that survive the strip either way.)
    stripped = parsed["raw_note"]
    for pattern in (_AS_REFERENCE, _BBL_REFERENCE):
        stripped = pattern.sub("", stripped)
    stripped = re.sub(r"[\[\](){};,.]", "", stripped).strip()
    return bool(stripped)


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
    """Amendment provenance for every article-attached note in `xml`, one
    row per amendment EVENT (see _split_events()) -- a note describing two
    successive amendments to the same article produces two rows, not one
    row whose fields are blended from both acts.

    Rows come out in document order, and within one e_id that is also event
    order: a caller asking "what is this article's current state" wants the
    LAST row for that e_id, not the first.

    Three kinds of note contribute no row, all deliberate: one that never
    reaches an enclosing <article> (see _owning_article), a plain
    cross-reference ("SR 943.03") with neither a recognised action nor an
    AS/BBl reference, and one that has an AS reference but is not actually
    describing a change to THIS article -- a bracketed publication history
    of a different act, a "Die Änderungen können unter AS ... konsultiert
    werden" pointer, or a bare citation with no surrounding sentence (see
    _is_amendment() for the full reasoning; the brief's original rule
    missed all three of these).
    """
    if lang not in _ACTIONS:
        raise _unsupported_lang(lang)

    root = akn._root(xml)
    rows: list[Provenance] = []
    for note in root.iter(_AKN_AUTHORIAL_NOTE):
        e_id = _owning_article(note)
        if not e_id:
            continue
        full_text = " ".join("".join(note.itertext()).split())
        for event_text in _split_events(full_text, lang):
            parsed = parse_note(event_text, lang=lang)
            if not _is_amendment(parsed):
                continue
            rows.append(Provenance(
                e_id=e_id,
                action=parsed["action"],
                as_reference=parsed["as_reference"],
                bbl_reference=parsed["bbl_reference"],
                effective_date=parsed["effective_date"],
                source_act_date=parsed["source_act_date"],
                raw_note=full_text,
            ))
    return rows
