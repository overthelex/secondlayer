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


def parse_listing(html: str) -> dict[str, set[str]]:
    """Map doc_id -> available extensions, from one Apache listing page."""
    inventory: dict[str, set[str]] = {}
    for href in _HREF.findall(html):
        name = unquote(href)
        if "/" in name:                       # parent directory link
            continue
        doc_id, _, extension = name.rpartition(".")
        if not doc_id or extension.lower() not in KNOWN_EXTENSIONS:
            continue
        inventory.setdefault(doc_id, set()).add(extension.lower())
    return inventory
