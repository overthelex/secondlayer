"""
Case-number references in EDRSR decision texts (LEXAI-2314).

One home for the «№ 761/9584/15-ц» pattern, shared by extract-citations.py and
rebuild-case-edges.py and covered by test_case_number_extraction.py.

What the previous pattern, `(?:справ[аи]\\s*)?№\\s*(\\d{1,4}/\\d{1,10}/\\d{2,4})`,
got wrong, measured on prod texts (3,200 sampled decisions, 7,040 «№ d/d/d» hits):

* It had no suffix group, so «761/9584/15-ц» was stored as «761/9584/15». EDRSR
  keeps the suffix in cause_num (ц 3.84M, к 2.22M, п 2.09M, а 0.60M of 38.9M
  cases), so every suffixed case failed the exact resolver join and
  is_self_citation missed it.
* It had no right boundary, so a four-part proceeding number
  («Провадження № 3/766/262/16», «№ 2/489/11/23») — 12% of all hits — was
  truncated to its first three parts and stored as a bogus case number, and so
  were letter / registration numbers with a numeric tail
  («Супровідний лист № 125/7/02-97-03», «висновок № 752/11428/21-35»).
* The caller only scanned the first 10,000 characters; 18% of hits sit beyond.

Context words were measured and deliberately NOT used: of the three-part hits
right after «провадження», almost all are the case number itself
(«кримінального провадження № 766/2436/16-к», «об'єднані в одне провадження
№ 446/545/26»). The proceeding numbers that are not case numbers are told apart
by their shape (four parts, or a «1-кп/» prefix the pattern never starts on),
not by the word in front of them.
"""

import re

# Dash look-alikes that court texts use between the number and its suffix.
DASHES = "-‐‑‒–—―−"
_D = "[" + re.escape(DASHES) + "]"
_L = "A-Za-zА-Яа-яІіЇїЄєҐґ"

# Suffixes that occur in edrsr_case_index.cause_num (all 38.9M rows, 2026-11-20),
# lowercased: ц 3,842,032 / к 2,216,985 / п 2,091,741 / а 602,774 / г 17,959 /
# е 12,623 / ап 512 / нр 285 / б 109 / н 64 / на 62 / зн 29 / кр 27. Anything else
# in suffix position is not kept (the base number still is): a whitelist is what
# stops «№ 123/456/20-та» or a stray word from becoming a suffix.
SUFFIXES = frozenset({"ц", "к", "п", "а", "г", "е", "ап", "нр", "б", "н", "на", "зн", "кр"})

# Latin letters typed for their Cyrillic twins, plus the four keys that sit
# under ц/к/п/а on a Ukrainian layout (w/r/g/f: seen in cause_num itself, e.g.
# «-r» 35 times). Applied to the suffix only, never to the number.
_SUFFIX_MAP = str.maketrans({
    "a": "а", "e": "е", "k": "к", "c": "с", "o": "о", "p": "р", "x": "х", "h": "н",
    "w": "ц", "r": "к", "g": "п", "f": "а",
})

# The case number: court / sequence / year, with nothing numeric glued on the
# right (a fourth «/part», more digits, or a «-97»-style numeric tail). Then an
# optional suffix: one dash (spaces allowed on ONE side only, so «20 - а також»
# is not read as suffix «а»), 1-3 letters, and a boundary.
CASE_REF_RE = re.compile(
    r"№\s*"
    r"(\d{1,4}/\d{1,10}/\d{2,4})(?![\d/])"
    r"(?:(?:" + _D + r"\s?|\s" + _D + r")([" + _L + r"]{1,3})(?![" + _L + r"\d/]))?"
    r"(?!\s?" + _D + r"\s?\d)"
)


def normalize_suffix(raw: str | None) -> str:
    """Lowercased Cyrillic suffix if it is a real cause_num suffix, else ''."""
    if not raw:
        return ""
    s = raw.lower().translate(_SUFFIX_MAP)
    return s if s in SUFFIXES else ""


def find_case_refs(text: str) -> list[tuple[str, str]]:
    """(normalized case number, matched text as written) for every reference.

    The normalized form is «base» or «base-suffix» with an ASCII hyphen and a
    lowercased Cyrillic suffix: the same key the resolver computes for
    edrsr_case_index. The written form starts at the first digit (no «№»), so
    a reader can find it again in the full text with strpos().
    """
    out = []
    for m in CASE_REF_RE.finditer(text):
        base = m.group(1)
        suf = normalize_suffix(m.group(2))
        written = text[m.start(1):m.end()] if suf else base
        out.append((f"{base}-{suf}" if suf else base, written))
    return out
