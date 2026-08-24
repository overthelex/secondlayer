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

# KNOWN, DELIBERATE truncation, not a fabrication: a citation that spans
# more than one page comes back as only its first page. Two real shapes on
# the full OR, both measured directly (not estimated): a "glued" second
# page with no separator ("AS 1982 1676 1724" -> as_reference stops at "AS
# 1982 1676", 5 of 782 rows) and, far more commonly, a semicolon-separated
# continuation citation that does not repeat the "AS" token ("AS 2020 4005;
# 2022 109; BBl 2017 399" -> as_reference stops at "AS 2020 4005", dropping
# "2022 109" -- 274 of 782 rows, 35%, across 191 distinct articles). Every
# emitted as_reference is still a TRUE PREFIX of the note's real citation,
# never a fabricated one -- but at 35% of rows this is not a rare edge case
# to patch with a wider regex; representing it properly needs as_reference
# to become a list of citations, not a single string, which is a schema
# decision for tasks 1 and 3 to make, not something this parser decides
# unilaterally by changing its own return shape.

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
    # French and Italian participles AGREE with the provision they describe,
    # so a note on "art. 226a a 226d" writes "Introduits"/"Introdotti", and one
    # on a feminine noun ("disposition", "lettera") writes "Introduite"/
    # "Introdotta". German does not inflect here, which is why the German
    # column never showed this. A masculine-singular-only pattern is not a
    # missing row, it is a WRONG row: with one of a note's two verbs invisible,
    # _split_events() sees one event and parse_note() welds the first event's
    # citation to the second event's date -- art_226_a_226_d then asserts that
    # RO 1962 1082, the act that INTRODUCED those articles, repealed them.
    # Enumerated on the full fr/it OR rather than derived from grammar (a
    # capital-letter prefix count of every note word against the pattern):
    # fr Introduits 6, Introduite 9, introduite 7, Introduites 7 -- all missed;
    # it Abrogati 21, abrogati 1, Introdotti 6, Introdotta 11, Introdotte 7 --
    # all missed. Nothing outside the four -o/-a/-i/-e endings occurs.
    #
    # "Abrogé" carried no trailing \b, which is the only reason the French
    # repeal half looked healthy ("Abrogés" matched by accident). It is
    # written out in full below so the four accepted forms are stated rather
    # than obtained as a side effect of an absent anchor -- an open-ended
    # prefix would also swallow any future "Abrogé..." word.
    "fr": (
        ("inserted", re.compile(r"\bIntroduite?s?\b", re.IGNORECASE)),
        ("repealed", re.compile(r"\bAbrogée?s?\b", re.IGNORECASE)),
        ("amended", re.compile(r"\bNouvelle teneur selon\b", re.IGNORECASE)),
    ),
    "it": (
        ("inserted", re.compile(r"\bIntrodott[oaie]\b", re.IGNORECASE)),
        ("repealed", re.compile(r"\bAbrogat[oaie]\b", re.IGNORECASE)),
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

# "avec effet au" is the French counterpart of German "mit Wirkung seit" --
# both introduce a REPEAL's effective date, as opposed to "en vigueur
# depuis"/"in Kraft seit" for an insertion or amendment. Missing from the
# first cut of this pattern: verified directly on the full French OR, 121
# of the 171 rows carrying an AS reference and no effective_date used this
# exact phrasing, dragging French effective-date coverage to 78% (615/788)
# against German and Italian's 92%. Checked and not found before adding it:
# "avec effet à" (0 occurrences), "avec effet dès" (0), "avec effet du" (0)
# -- "avec effet au" is the only variant. (One further anomaly, measured
# and left alone: a single note reads "avec effet audepuis le ..." -- two
# phrasings glued with no space, a source data defect, not a phrasing this
# module should special-case for one occurrence.)
_EFFECTIVE = re.compile(
    r"(?:in\s+Kraft\s+seit|mit\s+Wirkung\s+seit|"
    r"en\s+vigueur\s+depuis(?:\s+le)?|avec\s+effet\s+au|"
    r"con\s+effetto\s+dal|"
    r"in\s+vigore\s+dal)\s*(.{0,40})",
    re.IGNORECASE)

# "vom 5. Okt. 1990" (de), "du 5 oct. 1990" (fr), "del 5 ott. 1990" / "dell'8
# ott. 1999" (it) -- the date of the amending act itself, always introduced
# by this preposition right after the act's own designation ("BG", "LF",
# "LF"). Two things the day-group and trigger must both allow, both
# measured on the full Italian OR, not assumed: the day can carry the
# Italian ordinal sign ("1°"), the same fix _DATE already needed -- without
# it "della LF del 1° ott. 2021" doesn't match at all, since "1" then "°"
# fails on the literal "." the old pattern required next. And "del" elides
# to "dell'" before a digit spoken with a leading vowel sound (8, 11, ...:
# "dell’8 ott. 1999", "dell’11 dic. 2009") -- 7 occurrences against 865
# unelided "del ", real and systematic (Italian grammar, not a typo) but
# rare enough that _DATE's own day-group, not a new trigger branch, is
# where the "°" fix belongs; the elided article itself needs no following
# whitespace, unlike "del"/"vom"/"du".
_SOURCE_ACT = re.compile(
    r"\b(?:vom\s+|du\s+|del\s+|dell['’])"
    r"(\d{1,2}(?:er|°)?\.?\s+[A-Za-zÀ-ÿ]+\.?\s+\d{4})",
    re.IGNORECASE)

# Bare pointers to a change history rather than a description of a change to
# THIS article -- see _is_amendment()'s docstring for the full reasoning and
# the four real shapes measured on the full OR. The gap between "unter" and
# "konsultiert" holds the AS reference itself, up to "unter AS 1949 I 802
# konsultiert" (14 characters) on the full OR -- a first draft capped this
# at 10 and silently matched nothing, which is how this pointer phrasing
# ended up in the "keep" bucket instead of being dropped by it.
#
# Keyed by lang, like _ACTIONS: extract() takes lang="fr"/"it" and
# run-stage.sh exposes CHPIPE_LANG, so a German-only pattern here would
# silently re-admit the ENTIRE pointer class on a French or Italian run --
# _is_amendment() returns True for "Les modifications peuvent être
# consultées au RO 1971 1465." against a de-only check, exactly the failure
# this rule exists to prevent. Only the "de" entry is measured against real
# text (12 occurrences on the full OR); "fr" and "it" are the structurally
# parallel construction ("<can be> <consulted> <at/in> <AS-equivalent>
# <ref>") and are covered by tests, but a French or Italian OR has not been
# fetched to confirm the exact phrasing Fedlex uses there.
_CHANGE_LOG_POINTER = {
    "de": re.compile(
        r"\bkönnen\s+unter\b.{0,40}\bkonsultiert\s+werden\b", re.IGNORECASE),
    "fr": re.compile(
        r"\bpeu(?:vent|t)\s+être\s+consultée?s?\b", re.IGNORECASE),
    "it": re.compile(
        r"\b(?:pu[oò]\s+essere\s+consultat[ao]|"
        r"possono\s+essere\s+consultat[ei])\b", re.IGNORECASE),
}

# A citation that is not THIS event's own but a BACK-REFERENCE to some
# other, earlier text -- "Für den Text in der ursprünglichen Fassung siehe
# AS 53 185." ("for the text in the original version, see AS 53 185").
# Measured on disp_u16/art_19 (the only note on the full OR matching this):
# the note's FIRST sentence describes a real event ("... ist in der Fassung
# des BG vom 1. April 1949 in Kraft gesetzt worden" -- this section took
# its current wording from the 1949 Act, a genuine source_act_date) but its
# SECOND sentence points at the citation of the act that 1949 act REPLACED,
# not the 1949 act itself. Naively taking the nearest AS/BBl match in the
# whole note welded 'AS 53 185' (the superseded original) to
# source_act_date=1949-04-01 (the replacement) -- the same event-blend
# finding 1 removed, just inside one sentence pair instead of across two
# split verbs. _strip_backreference_citations() removes the "siehe/voir/
# vedi <citation>" span before as_reference/bbl_reference are ever
# extracted, so a back-referenced citation can no longer be misattributed
# to the CURRENT event; source_act_date, parsed from the earlier, unrelated
# "vom 1. April 1949" clause, is untouched. Only "de" is measured (1
# occurrence); "fr"/"it" verbs are the parallel construction, unverified
# against real text, same caveat as _CHANGE_LOG_POINTER above.
_SEE_ALSO_VERB = {"de": "siehe", "fr": "voir", "it": "vedi"}

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


def _strip_backreference_citations(note: str, lang: str) -> str:
    """Remove a "siehe/voir/vedi <citation>" span -- a citation that points
    at some OTHER, earlier text rather than describing the current event --
    before as_reference/bbl_reference are extracted from what's left. See
    _SEE_ALSO_VERB's module-level comment for the real example this fixes
    (disp_u16/art_19) and why the citation, not the date, is the field that
    is wrong there.
    """
    verb = re.escape(_SEE_ALSO_VERB.get(lang, _SEE_ALSO_VERB["de"]))
    pattern = re.compile(
        rf"\b{verb}\s+(?:{_AS_REFERENCE.pattern}|{_BBL_REFERENCE.pattern})",
        re.IGNORECASE)
    return pattern.sub("", note)


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

    # Citations are searched on a version with any "siehe/voir/vedi
    # <citation>" back-reference removed (see _strip_backreference_citations),
    # so a pointer to some OTHER text's citation can never be picked up as
    # THIS event's own as_reference/bbl_reference. raw_note below keeps the
    # ORIGINAL, unstripped text -- this is a citation-matching detail, not a
    # right to shorten what gets audited.
    citation_text = _strip_backreference_citations(note, lang)
    as_match = _AS_REFERENCE.search(citation_text)
    bbl_match = _BBL_REFERENCE.search(citation_text)
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

    Order is preserved (document order in, document order out): within
    ONE note, that is chronological (every multi-event note measured writes
    its sentences earliest-event-first), but see extract()'s docstring for
    why that does NOT make the LAST row for an e_id across MULTIPLE notes
    that article's current state.
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


def _is_amendment(parsed: dict, lang: str) -> bool:
    """Whether one already-split event's parse describes a change to THIS
    article, as opposed to a footnote that merely mentions an AS number
    while pointing somewhere else.

    `lang` selects which language's _CHANGE_LOG_POINTER pattern applies --
    a German-only check here would silently re-admit the entire change-log
    pointer class on a French or Italian run (extract() takes lang="fr"/
    "it", and run-stage.sh exposes CHPIPE_LANG). See _CHANGE_LOG_POINTER's
    module-level comment.

    The brief's rule ("action" is set OR "as_reference" is set) is too
    loose in two ways: it should read as_reference OR bbl_reference (a
    BBl-only citation with no recognised verb is exactly as much this
    article's provenance as an AS-only one -- zero occurrences on the full
    OR, so this is a doc/code agreement fix, not something the data forced),
    and even with an as_reference/bbl_reference present, not every note
    carrying one is provenance. Measured directly on the full OR, post-split
    and after _strip_backreference_citations() removes disp_u16/art_19's
    welded row from consideration: 897 event segments sit inside an
    article. 782 are kept (764 with a recognised action, 18 without one but
    with an AS/BBl reference) and 115 are dropped, in four real shapes:

      * 14 + 4 = 18 KEPT with no recognised action: "Ausdruck gemäss ..."
        (a single term changed), "Fassung [erster/des zweiten] Satzes
        gemäss ..." (a named part of the article re-worded) -- 14 of these
        -- and "Berichtigt von der Redaktionskommission der BVers (Art. 33
        GVG -- AS 1974 1051)." -- 4 of these -- a correction made by the
        drafting commission under its own statutory authority, not by a
        later amending act. None of these three is one of the three verbs
        this module classifies (action stays None), but each is a real,
        cited sentence describing a change to THIS article's text.
        "Berichtigt" is the one worth arguing about either way: Fedlex
        itself models a correction as jolux:rectifies, a relation of its
        own, distinct from an amendment but not nothing -- dropping it
        would erase a real, cited edit to this exact provision. What
        distinguishes all 18 kept rows from the dropped ones below is that
        every kept one is a full sentence ABOUT this article, not a list or
        a pointer that happens to contain an AS number.
      * 11 DROPPED: a bracketed publication history of a DIFFERENT,
        already-repealed act -- "[AS 1972 1502; 1977 1269; 1982 1234;
        1987 1189]". The AS numbers are that other act's amendment trail,
        not this article's. Every one measured is the entire note,
        opening bracket first -- see _BRACKETED_LIST.
      * 12 DROPPED: "Die Änderungen können unter AS 1971 1465 konsultiert
        werden." -- a pointer telling the reader where to go look, not a
        description of a change. See _CHANGE_LOG_POINTER.
      * 3 DROPPED (caught by the bare-citation residue check below, applied
        last): a bare citation with nothing else -- "AS 53 185". No verb,
        no surrounding prose; a floating number is not "this article was
        amended", it is exactly the same shape as the SR cross-reference
        the brief's own rule already excludes when there is no AS prefix.

    (The remaining 89 of the 115 dropped have neither a recognised action
    nor an AS/BBl reference at all -- plain SR cross-references and
    explanatory prose -- and are excluded by the very first check below,
    before any of the four shapes above are even considered.)

    A fifth shape does not reach this function at all: a citation that is a
    BACK-REFERENCE to some other, earlier text ("siehe AS 53 185" -- "see AS
    53 185") is stripped out of as_reference/bbl_reference before parse_note
    ever returns, by _strip_backreference_citations(); see that function's
    docstring. Without it, a note whose FIRST sentence describes this
    event and whose SECOND sentence points at a different, earlier act's
    citation would weld the two together exactly like the one-note-two-
    events defect finding 1 fixed -- disp_u16/art_19 on the full OR is
    measured doing exactly this.

    So the rule is: keep a row with a recognised action outright. Otherwise
    require an AS or BBl reference AND that the note is not a bracketed
    list and not a change-log pointer (in `lang`) AND that something besides
    the citation(s) themselves is in the note at all.
    """
    if parsed["action"]:
        return True
    if not parsed["as_reference"] and not parsed["bbl_reference"]:
        return False
    if _BRACKETED_LIST.match(parsed["raw_note"]):
        return False
    if _CHANGE_LOG_POINTER[lang].search(parsed["raw_note"]):
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

    Rows come out in DOCUMENT order, not chronological order, and the two
    are not the same thing across notes. Within a single split note, event
    order and document order agree (see _split_events()'s docstring) -- but
    an article commonly carries one <authorialNote> per amended PARAGRAPH,
    in paragraph position, and Fedlex does not keep paragraphs in the order
    they were last amended. Measured directly: 19 of 509 e_ids on the full
    OR have a non-monotonic source_act_date sequence across their rows --
    art_740 emits 2005-12-16 then 1991-10-04; art_361 ends on a 1988
    amendment that comes after a 2013 one earlier in the same stream. A
    consumer wanting "this article's current state" MUST sort that e_id's
    rows by date itself (effective_date if it wants what's in force,
    source_act_date otherwise) -- the last row in the order this function
    returns is NOT a promise of anything. An earlier version of this
    docstring claimed it was; that claim was false and has been removed
    rather than made true, because making it true would mean silently
    resorting rows that carry no date at all (6 of 782 recognised rows have
    neither effective_date nor source_act_date, measured on the full OR)
    under some invented tiebreak this module has no basis for choosing.

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
            if not _is_amendment(parsed, lang):
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
