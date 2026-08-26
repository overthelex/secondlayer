"""Which ch_act_change_document a modification-table row came from, when the
host does not say.

Lexwork links a table row to its amending act through
history_information_map -> change_documents[].id, and cantonal_parse_stage
follows that map. On prod (2026-08-26) the map was empty on every parsed
edition of seven hosts, so 993,939 of 1,501,980 cantonal provenance rows
carried change_document_id NULL: BS 66,521 of 66,521, LU 65,381 of 65,993,
ZG 52,852 of 52,865, BL 85,007 of 85,562, OW 28,704 of 28,849, TG 46,000 of
47,843, AR 21,346 of 21,346. What those rows DO carry is the table's source
cell ("G 2009 321", "GS 2017.026", "KB 05.12.2020") and two dates (decision,
effective); what the document carries is a number ("2017-022", "2017.026",
"RS-BS40-0000000356") and a publication date. This module is the grammar
that reads one against the other, per host, plus a date fallback for the
hosts whose two numberings never meet.

Measured on a 2% random sample of the unlinked rows (7,244 rows, the act's
own documents as candidates, ground truth = the number match):

  * BL "GS 2017.026" <-> "2017.026": 927 of 950 references of that shape
    match one document; 696 rows cite "GS 33.1335" (volume.page, the paper
    collection before 2014), for which the host has no document at all.
  * LU "G 2017-022" <-> "2017-022" / "2016-14" (zero padding differs by
    year): 561 of 589. "G 2009 321" is year + PAGE of the Gesetzessammlung,
    the documents are numbered 2009-nn: 695 rows (54%) reach a document
    only through the date.
  * ZG "GS 2018/006" <-> "2018/006": 560 of 566. "GS 27, 759" is volume,
    page; the host's "27/759"-shaped numbers are something else (0 of 394
    matched inside the act, 93 collided canton-wide with unrelated acts),
    so the legacy shape goes to the date fallback, never to a number match.
  * OW "OGS 2012, 62" <-> "OGS 2012, 062 - ABl 2012, 420": 537 of 549.
  * BS "KB 05.12.2020" <-> date_publication: 416 of 505 rows with a date,
    32 ambiguous (two publications the same day), 753 rows carry no
    reference (the Kantonsblatt before 2014, no document either).
  * TG, AR: no source column in the table at all. AR publishes no change
    documents (status: 426 acts, change_documents/lightweight_index = {},
    checked live 2026-08-26); TG has 101, all from 2024 on.

The date fallback -- the act's ONE document published between the decision
date and 60 days after the later of decision and entry into force, and
every candidate dated -- was calibrated on the number-linked rows: BL 551
of 552 unique window hits correct (99.8%), LU 404 of 404, ZG 404 of 407
(99.3%), OW 379 of 398 (95.2%) before the "every candidate dated" rule,
whose 19 misses were all rows whose true document is an LB-era record
without a date. Wider windows (120, 200, 365 days) only lose coverage; the
"earliest publication after the decision" rule is worse everywhere
(87.9% to 96.7%). A number that names a document the host did not attach
to the act is left unmatched, not windowed: the window would pick a
neighbour and call it the source.

What this module links, on that sample (linked / unlinked rows, the
largest remaining reason): OW 543 / 556 (97.7%; 12 numbers the host did
not attach to the act), ZG 900 / 1,064 (84.6%; 82 legacy rows with two
documents in the window), LU 1,034 / 1,292 (80.0%; 180 page-style rows
with two in the window), BL 937 / 1,664 (56.3%; 680 pre-2014 volume.page
rows, no document exists), BS 430 / 1,300 (33.1%; 688 rows without a
reference and no document in the window, pre-2014), TG 4 / 929 (0.4%;
the host's 101 documents start in 2024), AR 0 / 439 (no documents). All
seven: 3,848 of 7,244 (53.1%), so roughly 528K of the 994K unlinked rows
on prod.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass

_ZERO_WIDTH = re.compile("[​‌‍﻿]")
_WS = re.compile(r"\s+")
_DATE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})")
_TOKEN = re.compile(r"(\d+)([a-z])?")
_ROMAN = r"[IVXLC]+"

#: Publication follows decision by 0 days (BL, p50) to 69 (ZG, p50);
#: p95 is 117 (OW) to 323 (ZG) days, but a wider window admits a second
#: candidate more often than it admits the right one (measured above).
WINDOW_AFTER = datetime.timedelta(days=60)


@dataclass(frozen=True)
class Candidate:
    change_document_id: int
    number: str | None
    date_publication: datetime.date | None


@dataclass(frozen=True)
class Reference:
    """kind: 'number' (a key the document's number can equal), 'date'
    (a publication date), 'legacy' (a real reference into a paper
    collection the host has no document for: volume/page), 'unknown'
    (prose, or nothing)."""
    kind: str
    key: tuple | datetime.date | None
    text: str


@dataclass(frozen=True)
class Match:
    change_document_id: int | None
    reason: str


def _clean(text: str | None) -> str:
    return _WS.sub(" ", _ZERO_WIDTH.sub("", text or "").replace("\xa0", " ")).strip()


def _tokens(text: str) -> tuple[str, ...]:
    """Digit groups with leading zeros dropped, a trailing letter kept:
    '2017.026' -> ('2017', '26'); '2020-051k' -> ('2020', '51k')."""
    return tuple(str(int(d)) + (s or "") for d, s in _TOKEN.findall(text))


def _date(text: str) -> datetime.date | None:
    m = _DATE.search(text)
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def references_of(raw_note: str | None) -> list[str]:
    """The source cell(s) of a stored raw_note: 'decision | effective |
    element | change | source'. The note drops empty cells, so a four-field
    note is one without a source (TG, AR, old BS rows) -- on the seven
    hosts measured, no other cell is ever empty. LU writes two references
    in one cell, pipe-separated, and both are returned."""
    fields = [f.strip() for f in (raw_note or "").split(" | ")]
    return [f for f in fields[4:] if f] if len(fields) >= 5 else []


def parse_reference(canton: str, text: str | None) -> Reference:
    t = _clean(text)
    if not t:
        return Reference("unknown", None, t)
    if canton == "BL":
        m = re.match(r"(?:wg\.\s*)?GS\s+(\d{4}\.\d+)", t)
        if m:
            return Reference("number", _tokens(m.group(1)), t)
        if re.match(r"(?:wg\.\s*)?GS\s+\d{1,2}\.\d+", t):
            return Reference("legacy", None, t)
        return Reference("unknown", None, t)
    if canton == "LU":
        m = re.match(r"G\s+(\d{4}-\d+[a-z]?)\b", t)
        if m:
            return Reference("number", _tokens(m.group(1)), t)
        m = re.match(r"K\s+(\d{4})\s+(\d+)\b", t)
        if m:
            return Reference("number", ("K",) + _tokens(m.group(1) + " " + m.group(2)), t)
        if re.match(r"[GV]\s+(?:\d{4}|" + _ROMAN + r")\s+\d+", t):
            return Reference("legacy", None, t)
        return Reference("unknown", None, t)
    if canton == "ZG":
        m = re.match(r"GS\s+(\d{4}/\d+)", t)
        if m:
            return Reference("number", _tokens(m.group(1)), t)
        if re.match(r"GS\s+\d{1,2},\s*\d+", t):
            return Reference("legacy", None, t)
        return Reference("unknown", None, t)
    if canton == "OW":
        m = re.match(r"(?:OGS\s+)?(\d{4},\s*\d+[a-z]?)\b", t)
        if m:
            return Reference("number", _tokens(m.group(1)), t)
        return Reference("unknown", None, t)
    if canton == "BS":
        m = re.search(r"KB\s+(\d{1,2}\.\d{1,2}\.\d{4})", t)
        date = _date(m.group(1)) if m else (_date(t) if re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{4}", t) else None)
        if date:
            return Reference("date", date, t)
        if re.match(r"KtBl\s+\d{4}", t):
            return Reference("legacy", None, t)
        return Reference("unknown", None, t)
    # A host without its own grammar: a bare date is a date, anything with
    # digits is compared token-wise, which is what the history map's hosts
    # (BE "BAG 04-9" <-> "04-9", SG "nGS 2019-045") happen to need.
    if re.fullmatch(r"(?:KB\s+)?\d{1,2}\.\d{1,2}\.\d{4}", t):
        return Reference("date", _date(t), t)
    tokens = _tokens(t)
    if tokens:
        return Reference("number", tokens, t)
    return Reference("unknown", None, t)


def number_key(canton: str, number: str | None) -> tuple | None:
    """A document's number in the same key space as parse_reference()'s
    'number' kind. OW's "OGS 2012, 062 - ABl 2012, 420" is two references
    to one document; the first is the one the table cites."""
    t = _clean(number)
    if not t:
        return None
    t = t.split(" - ")[0]
    if canton == "LU" and t.startswith("K "):
        return ("K",) + _tokens(t)
    return _tokens(t) or None


def match_change_document(canton: str, references, decision: datetime.date | None,
                          effective: datetime.date | None,
                          candidates: list[Candidate]) -> Match:
    """The act's document a row came from, or why none. `references` is the
    list of source-cell strings (or a raw_note, which is split first);
    `candidates` are the act's own ch_act_change_document rows.

    Order: a number reference decides (matched, ambiguous, or unmatched --
    the last is final, see the module docstring); then a date reference;
    only a row with no usable reference goes to the publication window."""
    if not candidates:
        return Match(None, "no_candidates")
    if isinstance(references, str):
        references = references_of(references)
    refs = [parse_reference(canton, r) for r in references or []]
    for kind in ("number", "date"):
        outcome = None
        for ref in refs:
            if ref.kind != kind:
                continue
            if kind == "number":
                hits = [c for c in candidates if number_key(canton, c.number) == ref.key]
            else:
                hits = [c for c in candidates if c.date_publication == ref.key]
            if len(hits) == 1:
                return Match(hits[0].change_document_id, kind)
            # LU cites "K 2017 393 | G 2017-016": the Kantonsblatt page and
            # the Gesetzessammlung number for one document. Every reference
            # of the kind is tried before the kind is called unmatched.
            outcome = f"{kind}_ambiguous" if hits else (outcome or f"{kind}_unmatched")
        if outcome:
            return Match(None, outcome)
    if decision is None:
        return Match(None, "no_decision_date")
    if any(c.date_publication is None for c in candidates):
        return Match(None, "window_undated")
    high = max(decision, effective or decision) + WINDOW_AFTER
    hits = [c for c in candidates if decision <= c.date_publication <= high]
    if len(hits) == 1:
        return Match(hits[0].change_document_id, "window")
    return Match(None, "window_ambiguous" if hits else "window_none")
