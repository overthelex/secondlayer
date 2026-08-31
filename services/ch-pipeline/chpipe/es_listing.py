"""entscheidsuche.ch document enumeration.

The Apache directory listing at /docs/{SPIDER}/ is the ONLY endpoint that lists
documents. Verified 2026-08-23:
  /docs/Status/{SPIDER}.json        -> last scraper run status
  /docs/Index/{SPIDER}/Index_*.json -> run summary (counts of unchanged/new)
  /docs/Snapshots/{date}.json       -> per-court counters plus total_alle
None of those three enumerates anything; Snapshots is still useful for
reconciliation and for triggering deltas.
"""
from __future__ import annotations

import re
from urllib.parse import unquote

BASE = "https://entscheidsuche.ch/docs"

# Formats we know how to consume. A listing also carries checksums and other
# side files; anything not listed here is not a document body.
KNOWN_EXTENSIONS = frozenset({"json", "html", "pdf"})

_HREF = re.compile(r'href="([^"?][^"]*)"', re.IGNORECASE)


def listing_url(spider: str) -> str:
    return f"{BASE}/{spider}/"


def document_url(spider: str, doc_id: str, extension: str) -> str:
    return f"{BASE}/{spider}/{doc_id}.{extension}"


# A partial `href="..."` straddling a chunk boundary has to survive into the
# next chunk. Apache listing entries are ~60 characters; 4096 is two orders of
# magnitude of headroom and bounds the buffer so a chunk containing no hrefs
# at all cannot grow it without limit.
_CARRY_CHARACTERS = 4096

# Only 2**3 = 8 combinations of KNOWN_EXTENSIONS exist, so every doc_id in a
# 400,000-entry listing can share one of eight frozensets instead of owning a
# set object. A Python set costs ~216 bytes; at CH_BGer's scale that is the
# difference between ~86 MB of sets and eight objects.
_EXTENSION_BITS = {"json": 1, "html": 2, "pdf": 4}
_EXTENSION_SETS = {
    bits: frozenset(name for name, bit in _EXTENSION_BITS.items() if bits & bit)
    for bits in range(8)
}


def _entry(href: str) -> tuple[str, int] | None:
    """(doc_id, extension bit) for one href, or None if it is not a document."""
    name = unquote(href)
    if "/" in name:                           # parent directory link
        return None
    doc_id, _, extension = name.rpartition(".")
    bit = _EXTENSION_BITS.get(extension.lower())
    if not doc_id or bit is None:
        return None
    return doc_id, bit


def iter_listing_entries(chunks):
    """(doc_id, extension bit) for every document link, over a stream.

    The whole reason this is a stream: the CH_BGer listing is 116,000,062
    bytes. Reading it with Fetcher.text() buffers all of it as one Python
    string, and _HREF.findall then materialises a second list of ~400,000
    strings on top -- roughly 300-400 MB resident for one spider, on a box
    with 8 cores and live traffic. Matching incrementally holds one chunk
    plus a small carry-over instead.
    """
    buffer = ""
    for chunk in chunks:
        buffer += chunk
        end = 0
        for match in _HREF.finditer(buffer):
            entry = _entry(match.group(1))
            if entry is not None:
                yield entry
            end = match.end()
        # Keep everything after the last COMPLETE match, so a partial href at
        # the boundary is re-matched next time and nothing is yielded twice.
        buffer = buffer[max(end, len(buffer) - _CARRY_CHARACTERS):]


def carry_over(buffer: str) -> str:
    """What must survive into the next chunk: everything after the last
    complete href match, capped at _CARRY_CHARACTERS."""
    end = 0
    for match in _HREF.finditer(buffer):
        end = match.end()
    return buffer[max(end, len(buffer) - _CARRY_CHARACTERS):]


def extension_set(bits: int) -> frozenset[str]:
    return _EXTENSION_SETS[bits]


def parse_listing_stream(chunks) -> dict[str, frozenset[str]]:
    """doc_id -> available extensions, built without ever holding the whole
    listing in memory."""
    bits: dict[str, int] = {}
    for doc_id, bit in iter_listing_entries(chunks):
        bits[doc_id] = bits.get(doc_id, 0) | bit
    return {doc_id: _EXTENSION_SETS[value] for doc_id, value in bits.items()}


def parse_listing(html: str) -> dict[str, frozenset[str]]:
    """Map doc_id -> available extensions, from one Apache listing page.

    Kept for callers that already have the whole page as a string (tests, and
    anything working from a saved fixture). The pipeline itself streams.
    """
    return parse_listing_stream([html])
