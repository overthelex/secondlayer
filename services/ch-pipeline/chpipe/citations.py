"""Pure regex extraction of citation references from Swiss court decision text.

No DB access here -- extraction and resolution are separate stages (see
citations_resolve_stage.py for turning these raw references into graph
edges). This module recognises three kinds of *case* reference:

  bge      A citation to a Federal Supreme Court leading-case volume,
           written as BGE (German), ATF (French) or DTF (Italian) followed
           by volume, part (a Roman numeral I..V, occasionally with a
           lowercase suffix like "Ia"/"Ib") and page, e.g. "ATF 142 IV 250
           consid. 1.3" or "BGE 106 II 117 E. 1 S. 118". All three language
           forms are canonicalised to the single German abbreviation, since
           they denote the same physical volume/page in the official
           collection: `f"BGE {vol} {part} {page}"`. So "ATF 142 IV 250"
           and "DTF 142 IV 250" both canonicalise to "BGE 142 IV 250".

  docket   A Federal Court case docket number, e.g. "4A_22/2017" (modern
           underscore series) or "5P.123/2004" (older dot series). These
           are kept exactly as written -- the underscore and dot series are
           distinct historical numbering schemes and one must never be
           rewritten into the other.

  ecli     An ECLI (European Case Law Identifier) for a Swiss decision,
           e.g. "ECLI:CH:BGER:2017:4A.22.2017". Kept exactly as written.
           Everything after "ECLI:CH:<COURT>:" is treated permissively
           (letters, digits, '.', '_', '-', ':') because some sources
           (e.g. entscheidsuche.ch) mint ECLIs that skip the plain-year
           segment entirely and pack an underscore/hyphen-heavy identifier
           straight after the court code, such as
           "ECLI:CH:BGE:CH_BGE_004_BGE-115-II-300_1989".

Negative cases (must NOT be extracted):
  - A bare article reference like "Art. 142 III" is not a BGE citation --
    the BGE/ATF/DTF keyword must be present; "Art." is a statute reference
    (see extract_statutes below), not a case reference.
  - A phone number like "Tel. 044 123 45 67" is not a docket number -- the
    docket pattern requires a single uppercase letter immediately after the
    leading digit and a '/' followed by a 4-digit year, which a phone
    number never has.

Within one decision's text, references are deduplicated by (kind, raw
canonical key), keeping the context captured at the *first* occurrence, and
returned in order of first occurrence.

extract_statutes() recognises *statute* references -- an article of a named
act, in any of the three official languages:

  "Art. 336 Abs. 1 OR"          de   -> (OR, 336, 1)
  "art. 77 al. 1 let. b LTF"    fr   -> (LTF, 77, 1)
  "art. 207 cpv. 2 e 228 LT"    it   -> (LT, 207, 2) + (LT, 228, None)

A reference is a *head* word (Art./art./Artikel/Articles/artt./Articolo...),
a list of one to eight article items -- each a number with an optional letter
suffix ("336a", "336c"), an optional paragraph, optional letter/number
qualifiers ("lit. c", "let. b", "Ziff. 1", "ch. 1") and an optional
"ff."/"ss."/"segg." marker -- and finally the act abbreviation that the whole
list shares. Lists produce one StatuteRef per (article, paragraph) pair:
"Abs. 1 und 2" yields two paragraphs of the same article, "336 und 336a"
yields two articles. Ranges are NOT expanded: "Art. 8-10 ZGB" yields the two
endpoints 8 and 10 only, because expanding it would invent articles that may
not exist.

The abbreviation may carry a suffix, and both kinds must survive: a cantonal
"-VD"/"-GE" ("LPA-VD" is Vaud's administrative-procedure act, not the federal
LPA) and a single-digit ordinance number ("OPP 2", "BVV 2", never "OR 2019").
See _ABBR for the exact shapes and why each is bounded the way it is.

Two precision rules drop or re-read what looks like a citation but is not:

  wide range        A range spanning more than _MAX_RANGE_SPAN article
                    numbers is a coverage description, not an applied
                    citation -- "Kommentar zu den Art. 308-327a ZPO" names a
                    commentary's scope. Both endpoints are dropped.

  large paragraph   A number larger than _MAX_PARAGRAPH in a paragraph
                    continuation list ends the paragraph list: "art. 5 al. 1
                    et 2, 9, 26 et 36 Cst." cites five articles, not a
                    paragraph 36. See _scan_paragraphs for where the cut
                    falls.

Both carry a documented failure mode at their constant, and both trade a
handful of real citations for a much larger number of invented ones.

A *qualifier* list is not a paragraph list and not an article list: "Art. 3
Abs. 1 Ziff. 2 und 3 VwVG" is one citation (article 3, paragraph 1), not two
paragraphs and not two articles. The qualifier's own list is consumed with
the qualifier -- letters after a letter qualifier (lit./let./lett./
Buchstabe), numbers after a number qualifier (Ziff./ch./n./Satz) -- and the
paragraph continuation is scanned from the end of the paragraph number, not
from the end of the qualifier that follows it.

Language is inferred in this order, first hit wins:
  1. the paragraph / qualifier keyword  (Abs, Bst, Ziff, lit -> de;
     al, let, ch, par -> fr; cpv, lett, n -> it)
  2. the spelled-out head word          (Artikel -> de, Article(s) -> fr,
     Articolo/Articoli/artt -> it)
  3. the abbreviation, via a small table of the common acts
  4. 'de' as the default.

Negative cases (must NOT be extracted):
  - "Art. 5 des Bundesgesetzes" -- the act is spelled out in words; the
    abbreviation slot must hold an uppercase-initial token of 2-12 letters
    that is not a function word.
  - "Art. 12 Uhr" -- a clock time. A curated stop-list (Uhr, the paragraph
    and qualifier keywords themselves, articles/prepositions/conjunctions in
    all three languages, and RS/SR which are followed by a systematic-number,
    not an abbreviation) guards that slot.
  - "Art. 5\nArt. 6\nArt. 7 ZGB" -- only the third article has an act. The
    head word is on the stop-list too, so a reference whose act is missing
    yields nothing instead of citing "Art." as if it were a statute.
  - "Art. 5 Abs. 1 Satz 2 BV" -- "Satz" is a qualifier, not the act. The
    spelled-out qualifiers (Satz, Halbsatz, Ziffer, Buchstabe, Anhang, lettre,
    chiffre, cifra, numero) are recognised alongside the abbreviated ones, and
    are on the stop-list as a second line of defence.
  - "Art. 12\nJede Person hat Anspruch" -- a capitalised ordinary word is
    never an act, whatever it happens to be. Every abbreviation the alias
    table can hold carries at least two uppercase letters or is Cst./Cost.,
    so one capital followed only by lowercase is the next sentence starting
    where the act should have been.

Statute references are deduplicated by (abbr, article, paragraph), keeping
the first occurrence's context and language, and returned in order of first
occurrence.

Implementation note on scanning: the extractor never runs one large regex
with nested unbounded quantifiers over the text. It finds head words with a
cheap scan and then walks forward with small *anchored* matches (article
item, paragraph continuation, item separator, abbreviation). Every match is
anchored and every list is bounded, so the work is linear in the text length
-- a 2 MB decision extracts in well under a second.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class CaseRef:
    kind: str           # 'bge' | 'docket' | 'ecli'
    raw: str             # canonical key
    context: str


@dataclass(frozen=True)
class StatuteRef:
    abbr: str            # as written, trailing dot kept: 'Cst.'
    article: str         # '336a'
    paragraph: str | None
    lang: str             # 'de' | 'fr' | 'it'
    context: str


# The part is a volume division, and the reporter only ever had five of
# them (I..V, with the Ia/Ib subdivisions) -- spelling them out rather
# than accepting any run of I/V/X keeps "IIII", "IIX" and "X" (which are
# not Roman numerals the reporter uses, and turn up in OCR noise and in
# tables) from being read as case citations.
_BGE = re.compile(r"\b(?:BGE|ATF|DTF)\s+(\d{1,3})\s+((?:IV|III|II|I|V)[ab]?)\s+(\d{1,4})\b")
_DOCKET = re.compile(r"\b(\d[A-Z][._]\d{1,4}/\d{4})\b")
_ECLI = re.compile(r"\bECLI:CH:[A-Z0-9]+:[A-Za-z0-9._:-]+")


def _context(text: str, start: int, end: int, width: int = 120) -> str:
    """The match plus `width` chars of surrounding context, whitespace collapsed."""
    lo = max(0, start - width)
    hi = min(len(text), end + width)
    return re.sub(r"\s+", " ", text[lo:hi]).strip()


def extract_cases(text: str) -> list[CaseRef]:
    """Extract BGE/ATF/DTF, docket, and ECLI case references from `text`.

    Deduplicates by (kind, raw), keeping the first occurrence's context, and
    returns results in order of first occurrence.
    """
    matches: list[tuple[int, int, str, str]] = []  # (start, end, kind, raw)

    for m in _BGE.finditer(text):
        vol, part, page = m.group(1), m.group(2), m.group(3)
        raw = f"BGE {vol} {part} {page}"
        matches.append((m.start(), m.end(), "bge", raw))

    for m in _DOCKET.finditer(text):
        matches.append((m.start(), m.end(), "docket", m.group(1)))

    for m in _ECLI.finditer(text):
        raw = m.group(0)
        # An ECLI at the end of a sentence swallows the full stop, because '.'
        # is a legal character inside the identifier ("4A.22.2017"). Drop one
        # trailing dot -- never more, a real identifier never ends in '..'.
        if raw.endswith("."):
            raw = raw[:-1]
        matches.append((m.start(), m.end(), "ecli", raw))

    matches.sort(key=lambda t: t[0])

    seen: dict[tuple[str, str], CaseRef] = {}
    order: list[tuple[str, str]] = []

    for start, end, kind, raw in matches:
        key = (kind, raw)
        if key in seen:
            continue
        seen[key] = CaseRef(kind=kind, raw=raw, context=_context(text, start, end))
        order.append(key)

    return [seen[key] for key in order]


# ---------------------------------------------------------------------------
# Statute references
# ---------------------------------------------------------------------------

# Whitespace between the tokens of one reference. Deliberately NOT `\s*`: a
# reference never spans a blank line, and allowing at most one line break keeps
# "Art. 5\n\nDie Vorinstanz ..." from binding "Die" as the abbreviation.
#
# Written as "spaces, then optionally one newline and more spaces" rather than
# "spaces, optional newline, spaces": the latter can split a long run of spaces
# at every position with the same end result, which is quadratic on the
# space-padded runs that PDF text extraction produces. Here a give-back is
# rejected in one step, because the second half must start with a newline.
_GAP = r"[^\S\n]*(?:\n[^\S\n]*)?"

# Head words. "Art."/"art." plus the spelled-out and plural forms; the trailing
# lookahead stops "Arterie" or "Artikelserie" from being read as a head.
_HEAD = re.compile(
    r"\b([Aa]rt(?:ikel[ns]?|icles?|icoli|icolo|t)?)\.?(?![A-Za-zÄÖÜäöüéèàç])"
)

# Paragraph keywords (Absatz / alinéa / capoverso and the ECHR's "par.").
_PARA_KW = r"Absatz|Abs\.|alinéa|[Aa]l\.|capoverso|[Cc]pv\.|[Pp]ar\.|§"
# Letter and number qualifiers. They are NOT paragraphs -- "Art. 95 lit. a BGG"
# has no paragraph -- but they do carry a strong language signal.
#
# The spelled-out forms matter as much as the abbreviated ones: without
# "Satz"/"Ziffer"/"Buchstabe"/"Anhang" here, "Art. 5 Abs. 1 Satz 2 BV" stops
# after the paragraph and "Satz" -- an uppercase-initial word of the right
# length -- is read as the act.
# Split by the kind of value the qualifier takes, because the *list* that
# follows the value differs with it: a letter qualifier's list is letters
# ("lit. a und b"), a number qualifier's is numbers ("Ziff. 2 und 3"). One
# shared letter-only list leaves " und 3" unconsumed after "Ziff. 2", and
# whichever scan reaches it next then reads it as a further paragraph or a
# further article -- either way "Art. 3 Abs. 1 Ziff. 2 und 3 VwVG" becomes
# two citations instead of one.
_LET_QUAL_KW = (
    r"[Bb]uchstaben?|litera|lettres?"
    r"|[Ll]it\.|[Bb]st\.|[Ll]ett\.|[Ll]et\."
)
_NUM_QUAL_KW = (
    r"[Hh]albsatz|[Zz]iffern?|[Aa]nhang|[Ss]atz"
    r"|chiffres?|cifra|numeri|numero"
    r"|[Zz]iff\.|[Cc]h\.|[Nn]o?\."
)
_QUAL_KW = rf"{_LET_QUAL_KW}|{_NUM_QUAL_KW}"

# The conjunctions a qualifier list is written with. Every *word* alternative
# carries a trailing \b: without it "e" matches the "e" of "et" and the "t"
# that follows is read as the list's next letter, so "art. 5 al. 1 ch. 2 et 3
# LTF" consumed " et" as a letter, left " 3 LTF" where the abbreviation was
# expected, and dropped the whole reference. The punctuation alternatives get
# no \b -- "- 2" is a legitimate continuation and a boundary after "-" would
# reject it.
_CONJ = r"(?:,|;|und\b|oder\b|et\b|ed\b|ou\b|e\b|o\b)"

_LET_VAL = r"[a-z](?:bis|ter)?(?!\w)"
_NUM_VAL = r"(?:\d{1,3}|[a-z](?:bis|ter)?)(?!\w)"

# A number in a qualifier list that is itself followed by a paragraph or
# qualifier keyword is not a further qualifier value at all -- it is the next
# article of the list, carrying its own keyword ("Ziff. 1 und 9 Ziff. 2"),
# the same reasoning _PARA_AHEAD applies to paragraph continuations.
_NOT_NEXT_ITEM = rf"(?!{_GAP}(?:{_PARA_KW}|{_QUAL_KW}))"

# The rest of a qualifier list: "lit. a und b", "lit. a und lit. b",
# "lit. a, b und c", "Ziff. 2 und 3". Without this the trailing values are
# left unconsumed and the abbreviation after them never binds, losing the
# whole reference rather than just the extra values. Bounded, like every
# other list.
_LET_CONT = (
    rf"(?:{_GAP}{_CONJ}"
    rf"(?:{_GAP}(?:{_QUAL_KW}))?{_GAP}{_LET_VAL}){{0,7}}"
)
_NUM_CONT = (
    rf"(?:{_GAP}{_CONJ}"
    rf"(?:{_GAP}(?:{_QUAL_KW}))?{_GAP}{_NUM_VAL}{_NOT_NEXT_ITEM}){{0,7}}"
)


def _qual(group: str) -> str:
    """One optional qualifier with its value list.

    The keyword is captured under `group` for a letter-valued qualifier and
    under `group + "n"` for a number-valued one: Python's `re` has no branch
    reset, so the two branches cannot share a single group name. `_quals()`
    reads both back in order.
    """
    return (
        rf"(?:{_GAP}(?:"
        rf"(?P<{group}>{_LET_QUAL_KW}){_GAP}{_LET_VAL}{_LET_CONT}"
        rf"|(?P<{group}n>{_NUM_QUAL_KW}){_GAP}{_NUM_VAL}{_NUM_CONT}"
        rf"))?"
    )


def _quals(match) -> list[str]:
    """The qualifier keywords one _ITEM/_TAIL match captured, in written
    order. Only one branch of each slot can have matched, so this is at most
    two keywords."""
    return [g for g in (match.group("q1"), match.group("q1n"),
                        match.group("q2"), match.group("q2n")) if g]


# "und folgende" / "et suivants" / "e seguenti": consumed, never expanded.
# The multi-letter markers are written without a full stop often enough
# ("art. 8 ss CO") that the dot has to be optional for them -- but not for the
# single-letter "f."/"s.", where a stray letter would then look like a marker.
_FF = r"(?:(?:et|e)[ \t]+)?(?:(?:ff|ss|segg|seg)\.?|[fs]\.)(?!\w)"

# One article item: the number, then the optional paragraph, up to two optional
# qualifiers, and the optional ff. marker. Every optional group is guarded by a
# literal keyword, so a miss is rejected immediately instead of backtracking.
_ITEM = re.compile(
    _GAP + r"(?P<article>\d{1,4}[a-z]{0,6})(?!\w)"
    + rf"(?:{_GAP}(?P<pkw>{_PARA_KW}){_GAP}(?P<para>\d{{1,3}})(?!\w))?"
    + _qual("q1")
    + _qual("q2")
    + rf"(?:{_GAP}{_FF})?"
)

# Qualifiers and the ff. marker again, for the rare "al. 1 et 2 let. b" shape
# where a paragraph list pushed them out of reach of _ITEM. Matches empty.
_TAIL = re.compile(
    _qual("q1")
    + _qual("q2")
    + rf"(?:{_GAP}{_FF})?"
)

# A further paragraph of the same article: "Abs. 1 und 2", "al. 1 et 3",
# "Abs. 1 oder 2", "al. 1 ou 2", "cpv. 1 o 2". The disjunctions matter as much
# as the conjunctions -- a court writing "Art. 8 Abs. 1 oder 2 ZGB" is citing
# both paragraphs. No \b on the word alternatives (unlike _CONJ, whose values
# are letters): what follows here must be a digit, so "e" cannot eat the "e"
# of "et" and "o" cannot eat the "o" of "oder" -- the longer alternative is
# listed first and a wrong one fails on the digit that must follow.
_PARA_CONT = re.compile(
    _GAP + r"(?:,|;|und|oder|et|ed|ou|e|o|à|bis|-|–)" + _GAP + r"(\d{1,3})(?!\w)")

# A paragraph keyword right after a continuation number: the number was the
# next *article*, not a further paragraph ("cpv. 2 e 142 cpv. 4").
_PARA_AHEAD = re.compile(_GAP + rf"(?:{_PARA_KW})")

# The next article of the same list: "336 und 336a", "207 cpv. 2 e 228",
# "8-10", and the disjunctive forms every language writes just as often --
# "Art. 8 oder 9 ZGB", "art. 8 ou 9 CC", "art. 8 o 9 CC". Same ordering rule
# as _PARA_CONT: the longer word first, a digit required after.
_ITEM_SEP = re.compile(
    _GAP + r"(?:,|;|/|-|–|—|sowie|nonché|oder|und|ed|et|ou|bis|à|e|o)" + _GAP + r"(?=\d)"
)

# The 26 cantons' two-letter codes. A hyphenated suffix drawn from this list
# belongs to the abbreviation: "LPA-VD" is Vaud's administrative-procedure
# act and "LPA-GE" is Geneva's, neither of which is the federal LPA (SR 455,
# animal protection) that "LPA" alone resolves to. Cutting the suffix off
# does not lose a citation, it invents a wrong one -- the federal act the
# court never mentioned. Kept whole, the abbreviation matches no federal
# alias (ch_act_alias carries federal acts only) and the citation stays at
# `unresolved_abbr`, which is the truthful outcome for a cantonal act.
_CANTONS = (
    "AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR"
    "|VD|VS|ZG|ZH"
)

# The act abbreviation the whole list shares: uppercase-initial, 2-12 letters,
# optionally carrying a cantonal suffix ("LPA-VD") or a single-digit ordinance
# suffix ("OPP 2", "BVV 2").
#
# The digit branch is tried first and is deliberately narrow: at least three
# letters, exactly one space, one digit 1-3, and a non-digit after it. Swiss
# ordinances that share a base abbreviation are numbered exactly this way
# (OPP 1/OPP 2/OPP 3, BVV 1/BVV 2/BVV 3), and "OPP" alone resolved to an
# unrelated aviation ordinance. The non-digit lookahead is what keeps a year
# out: "Art. 5 OR 2019" must stay "OR", not become "OR 2". The three-letter
# floor keeps the two-letter abbreviations that are routinely followed by a
# number ("RS 351.1", "SR 210", "OR 2") whole.
_ABBR = re.compile(
    _GAP
    + r"("
    + r"[A-ZÄÖÜ][A-Za-zÄÖÜäöü]{2,11}[ ][1-3](?!\d)"
    + rf"|[A-ZÄÖÜ][A-Za-zÄÖÜäöü]{{1,11}}(?:-(?:{_CANTONS})(?![A-Za-zÄÖÜäöü]))?"
    + r")\.?(?![A-Za-zÄÖÜäöüéèàç0-9])"
)

# Tokens that fill the abbreviation slot but are not acts. Compared on the
# lowercased, dot-stripped token. RS/SR introduce a systematic number
# ("RS 351.1"), never an abbreviation.
_ABBR_STOP = frozenset(
    """uhr bst abs ziff lit al let ch cpv lett par n ff f ss seg segg
       des der die das vom du de la le les della del dell und et e rs sr
       art artt artikel artikeln artikels article articles articolo articoli
       absatz satz halbsatz anhang buchstabe buchstaben ziffer ziffern""".split()
)

# Abbreviations that genuinely carry a full stop; every other trailing dot is
# a sentence dot and gets stripped.
_ABBR_KEEPS_DOT = frozenset({"cst", "cost"})

# One capital and then nothing but lowercase: an ordinary word, not an act.
# See _normalise_abbr() for why that is decidable without a stop-list.
_ORDINARY_WORD = re.compile(r"^[A-ZÄÖÜ][a-zäöüéèàç]+$")

_KEYWORD_LANG = {
    "absatz": "de", "abs": "de", "bst": "de", "ziff": "de", "lit": "de",
    "litera": "de", "buchstabe": "de", "buchstaben": "de", "ziffer": "de",
    "ziffern": "de", "satz": "de", "halbsatz": "de", "anhang": "de",
    "alinéa": "fr", "al": "fr", "let": "fr", "ch": "fr", "par": "fr",
    "lettre": "fr", "lettres": "fr", "chiffre": "fr", "chiffres": "fr",
    "capoverso": "it", "cpv": "it", "lett": "it", "n": "it", "no": "it",
    "cifra": "it", "numero": "it", "numeri": "it",
}

_HEAD_LANG = {
    "artikel": "de", "artikeln": "de", "artikels": "de",
    "article": "fr", "articles": "fr",
    "articolo": "it", "articoli": "it", "artt": "it",
}

_ABBR_LANG = {
    "OR": "de", "ZGB": "de", "StGB": "de", "StPO": "de", "ZPO": "de",
    "BV": "de", "BGG": "de", "VwVG": "de", "SchKG": "de", "ATSG": "de",
    "EMRK": "de",
    "CO": "fr", "CC": "fr", "CP": "fr", "CPP": "fr", "CPC": "fr",
    "Cst.": "fr", "LTF": "fr", "LP": "fr", "LPD": "fr", "CEDH": "fr",
    "Cost.": "it", "LEF": "it", "CEDU": "it",
    # The two occupational-pension ordinances, which only exist in the
    # digit-suffixed form ("OPP 2" / "BVV 2" are the same act in two
    # languages) and are among the most-cited ordinances in social-insurance
    # case law.
    "OPP 2": "fr", "BVV 2": "de",
}

# The cantonal suffix carries a language signal of its own: a decision citing
# "LPA-VD" or "LPA-GE" is written in French whatever keywords it happens to
# use. Only the monolingual cantons are listed -- the bilingual ones (BE, FR,
# GR, VS) would be a guess, so they fall through to the default like any
# other abbreviation.
_CANTON_LANG = {
    "GE": "fr", "JU": "fr", "NE": "fr", "VD": "fr",
    "TI": "it",
}

_MAX_LIST = 8    # references emitted per article list / per paragraph list
_MAX_SCAN = 64   # items consumed past the cap before giving up on the list

# The widest span a range may cover and still be read as a citation of its two
# endpoints. Past it, the range is a *coverage description* -- "Kommentar zu
# den Art. 308-327a ZPO" names a commentary's scope, not two articles the
# court applied to the case -- and both endpoints are dropped rather than
# recorded as applied citations. Failure mode: a court that really does apply
# two articles more than five apart in one range loses both.
_MAX_RANGE_SPAN = 5

# The separators that make an article list a *range* rather than an
# enumeration. "Art. 308 und 327a ZPO" is two citations however far apart the
# two articles are; only a range says "everything between these".
_RANGE_SEPS = frozenset({"-", "–", "—", "bis", "à"})

# The largest number that can still be a paragraph in a paragraph list. Swiss
# articles hardly ever run past a dozen paragraphs, so a larger number in a
# continuation list is the next *article* -- "art. 5 al. 1 et 2, 9, 26 et 36
# Cst." cites five articles of the constitution, not a paragraph 36 of
# article 5. Failure mode: an article with a genuine paragraph 13 or beyond
# (they exist, e.g. in tax and social-insurance acts) has that paragraph and
# everything after it re-read as further articles of the same act.
_MAX_PARAGRAPH = 12


def _normalise_abbr(word: str) -> str | None:
    """Canonical abbreviation, or None if the token is not an act at all.

    The full stop is decided here rather than copied from the text: "Cst." and
    "Cost." carry one, every other trailing dot is the end of a sentence.
    """
    lowered = word.lower()
    if lowered in _ABBR_STOP:
        return None
    # A capitalised ordinary word is never an act. Every abbreviation the
    # alias table can hold -- curated or derived from a Fedlex title --
    # carries at least two uppercase letters (OR, ZGB, SchKG, LTF, EMRK) or
    # is one of the two constitutions below, so one capital followed only by
    # lowercase is the first word of the next sentence, which a line break
    # ("Art. 12\nJede Person ...") puts exactly where the act belongs. The
    # stop-list cannot cover this: it is a closed list, and the word that
    # follows an article number is not.
    if lowered not in _ABBR_KEEPS_DOT and _ORDINARY_WORD.match(word):
        return None
    return word + "." if lowered in _ABBR_KEEPS_DOT else word


def _keyword_lang(keywords: list[str]) -> str | None:
    for kw in keywords:
        lang = _KEYWORD_LANG.get(kw.rstrip(".").lower())
        if lang:
            return lang
    return None


def _canton_lang(abbr: str) -> str | None:
    """The language a cantonal suffix implies, for the monolingual cantons."""
    base, _, suffix = abbr.partition("-")
    return _CANTON_LANG.get(suffix) if base else None


def _number(article: str) -> int:
    """The numeric part of an article number: "327a" -> 327. _ITEM guarantees
    the token starts with digits, so this never fails."""
    return int(re.match(r"\d+", article).group())


def _drop_wide_ranges(
    items: list[tuple[str, list[str]]], ranged: list[bool],
) -> list[tuple[str, list[str]]]:
    """Drop both endpoints of every range wider than _MAX_RANGE_SPAN.

    Only the endpoints of the offending range go: "Art. 4, 308-327a ZPO"
    keeps article 4 and drops 308 and 327a.
    """
    drop: set[int] = set()
    for i in range(1, len(items)):
        if not ranged[i]:
            continue
        if _number(items[i][0]) - _number(items[i - 1][0]) > _MAX_RANGE_SPAN:
            drop.add(i - 1)
            drop.add(i)
    if not drop:
        return items
    return [item for i, item in enumerate(items) if i not in drop]


def _scan_paragraphs(text: str, pos: int, paragraphs: list[str]) -> tuple[int, bool]:
    """Consume "und 2", "et 3", ... after a paragraph; append up to the cap.

    Returns the new position and whether anything was consumed. A continuation
    number is a further *paragraph* only if it is at most two digits and is not
    itself followed by a paragraph keyword -- otherwise it is the next article
    of the list, as in "art. 207 cpv. 2 e 228 LT" (228 is an article) and
    "art. 134 cpv. 2 e 142 cpv. 4 LIFD" (142 is an article).

    Those two tests decide one element at a time. A third one needs the whole
    run in hand, so the run is collected first and committed afterwards: if
    ANY number in it is larger than _MAX_PARAGRAPH the run is not a paragraph
    list at all but an article list that a paragraph keyword introduced --
    "art. 5 al. 1 et 2, 9, 26 et 36 Cst.". The cut is made at the *comma* that
    opened the enumeration rather than at the large number itself (26 here),
    because the comma is what separates items where "et"/"und" binds a
    paragraph pair: everything from the comma on is left unconsumed for the
    caller's own _ITEM_SEP scan to read as articles, so "1 et 2" stays two
    paragraphs of article 5 and "9, 26 et 36" become three articles. With no
    comma before the large number, the cut falls on the number itself.
    """
    run: list[tuple[int, str, str]] = []   # (end offset, number, separator text)
    scan = pos
    while len(run) < _MAX_SCAN:
        cm = _PARA_CONT.match(text, scan)
        if cm is None:
            break
        number = cm.group(1)
        if len(number) > 2 or _PARA_AHEAD.match(text, cm.end()):
            break
        run.append((cm.end(), number, cm.group(0)))
        scan = cm.end()

    cut = len(run)
    wide = next((i for i, (_, n, _s) in enumerate(run)
                 if int(n) > _MAX_PARAGRAPH), None)
    if wide is not None:
        cut = wide
        for i in range(wide + 1):
            if "," in run[i][2] or ";" in run[i][2]:
                cut = i
                break

    for _end, number, _sep in run[:cut]:
        if len(paragraphs) < _MAX_LIST:
            paragraphs.append(number)
    return (run[cut - 1][0] if cut else pos), cut > 0

def extract_statutes(text: str) -> list[StatuteRef]:
    """Extract statute-article references (e.g. "art. 336a CO") from `text`.

    Deduplicates by (abbr, article, paragraph), keeping the first occurrence's
    context and language, and returns results in order of first occurrence.
    """
    seen: dict[tuple[str, str, str | None], StatuteRef] = {}
    order: list[tuple[str, str, str | None]] = []

    for hm in _HEAD.finditer(text):
        pos = hm.end()
        items: list[tuple[str, list[str]]] = []   # (article, paragraphs)
        ranged: list[bool] = []   # item i is the far end of a range from i-1
        keywords: list[str] = []
        scanned = 0
        is_range = False

        while scanned < _MAX_SCAN:
            im = _ITEM.match(text, pos)
            if im is None:
                break
            pos = im.end()
            scanned += 1

            paragraphs: list[str] = []
            if im.group("para"):
                keywords.append(im.group("pkw"))
                paragraphs.append(im.group("para"))
                # Scanned from the end of the paragraph NUMBER, not the end
                # of the whole item: _ITEM has already consumed any
                # Ziff./ch./n./Satz qualifier sitting after it, and resuming
                # from there reads that qualifier's own list ("Ziff. 2 und
                # 3") as further paragraphs of the article. A continuation
                # that really is a further paragraph starts immediately
                # after the number, where no qualifier can have matched --
                # so when this consumes anything, `after` is where _ITEM
                # would have ended anyway.
                after, extra = _scan_paragraphs(text, im.end("para"), paragraphs)
                if extra:
                    pos = after
                    tm = _TAIL.match(text, pos)
                    pos = tm.end()
                    keywords += _quals(tm)
            keywords += _quals(im)

            if len(items) < _MAX_LIST:
                items.append((im.group("article"), paragraphs))
                ranged.append(is_range)

            sm = _ITEM_SEP.match(text, pos)
            if sm is None:
                break
            pos = sm.end()
            is_range = sm.group(0).strip() in _RANGE_SEPS

        items = _drop_wide_ranges(items, ranged)
        if not items:
            continue
        am = _ABBR.match(text, pos)
        if am is None:
            continue
        abbr = _normalise_abbr(am.group(1))
        if abbr is None:
            continue

        lang = (
            _keyword_lang(keywords)
            or _HEAD_LANG.get(hm.group(1).lower())
            or _canton_lang(abbr)
            or _ABBR_LANG.get(abbr)
            or "de"
        )
        # Built lazily: a decision cites the same article over and over, and
        # slicing plus whitespace-collapsing a 260-character window for a
        # reference that is about to be dropped as a duplicate is the single
        # most expensive thing this function can do.
        context: str | None = None

        for article, paragraphs in items:
            for paragraph in paragraphs or [None]:
                key = (abbr, article, paragraph)
                if key in seen:
                    continue
                if context is None:
                    context = _context(text, hm.start(), am.end())
                seen[key] = StatuteRef(
                    abbr=abbr,
                    article=article,
                    paragraph=paragraph,
                    lang=lang,
                    context=context,
                )
                order.append(key)

    return [seen[key] for key in order]
