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

extract_statutes() (StatuteRef: abbreviation + article/paragraph + language)
is Task 4's responsibility -- it is declared here per the extractor contract
but intentionally left unimplemented (raises NotImplementedError) until
Task 4 lands.
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


_BGE = re.compile(r"\b(?:BGE|ATF|DTF)\s+(\d{1,3})\s+([IVX]{1,4}[ab]?)\s+(\d{1,4})\b")
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
        matches.append((m.start(), m.end(), "ecli", m.group(0)))

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


def extract_statutes(text: str) -> list[StatuteRef]:
    """Extract statute-article references (e.g. "art. 336a CO"). Task 4."""
    raise NotImplementedError("extract_statutes is implemented in Task 4")
