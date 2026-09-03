"""RAB / ASR -- Eidgenössische Revisionsaufsichtsbehörde, Verfügungen.

/de/verfuegungen-der-rab?page=N lists download tiles; the German link's
filename carries the date ("Verfügung_der_RAB_vom_28__September_2020.pdf")
and the surrounding tile text the decision number ("2020-01"). Paging
ends at the first page without a tile. 5 decisions on 2026-09-03.
"""
from __future__ import annotations

import html as htmllib
import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, parse_date, safe_doc_id, stem_of

log = logging.getLogger(__name__)

SPIDER = "CH_RAB"
COURT_NAME = "Eidgenössische Revisionsaufsichtsbehörde RAB"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.rab-asr.ch"
MAX_PAGES = 30
_TILE = re.compile(r'<div class="rab-download-tile[^"]*">(.*?)</div>\s*</div>\s*</div>', re.S)
_LINK = re.compile(r'<a href="([^"]+\.pdf)"[^>]*aria-label="Download Deutsch[^"]*"', re.I)
_ANY_LINK = re.compile(r'<a href="([^"]+\.pdf)"', re.I)
_DOCKET = re.compile(r"(\d{4}-\d+)")
_TAGS = re.compile(r"<[^>]+>")


def parse_page(page_html: str) -> list[PortalDoc]:
    out = []
    for tile in _TILE.findall(page_html):
        m = _LINK.search(tile) or _ANY_LINK.search(tile)
        if not m:
            continue
        href = BASE + htmllib.unescape(m.group(1)) if m.group(1).startswith("/") else htmllib.unescape(m.group(1))
        text = re.sub(r"\s+", " ", htmllib.unescape(_TAGS.sub(" ", tile))).strip()
        d = _DOCKET.search(text)
        docket = d.group(1) if d else None
        stem = stem_of(href)
        decided = parse_date(stem.replace("_", " ").replace("  ", " ")) or parse_date(text)
        out.append(PortalDoc(
            doc_id=safe_doc_id("RAB", docket or stem),
            url=href,
            text_source=TEXT_SOURCE,
            title=f"RAB-Verfügung {docket}" if docket else stem.replace("_", " "),
            decision_date=decided,
            docket_number=docket,
            lang="de",
            extra={"tile": text[:200]},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    """Paging ends at the first page that adds nothing: past the last real
    page the site answers with the last page again (30 identical pages of
    5 tiles on 2026-09-03), so "empty" is the wrong stop condition."""
    out: list[PortalDoc] = []
    seen: set[str] = set()
    for page_no in range(MAX_PAGES):
        try:
            page = await fetcher.text(f"{BASE}/de/verfuegungen-der-rab?page={page_no}")
        except FetchError as exc:
            log.info("%s: page %d: %s", SPIDER, page_no, exc)
            break
        new = [d for d in parse_page(page) if d.doc_id not in seen]
        if not new:
            break
        seen.update(d.doc_id for d in new)
        out.extend(new)
    return out
