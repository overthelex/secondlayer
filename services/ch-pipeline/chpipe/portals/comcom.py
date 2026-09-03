"""ComCom -- Eidgenössische Kommunikationskommission, decisions.

admin.ch download-item pages per two-year range, /de/entscheide-{y}-{y+1}
from 1998; the title is the case ("Interconnect Peering. Verfügung. Init7
vs. Swisscom"), the description carries the legal-force status, the
meta-info the publication date, and the PDF filename often starts with
the decision date ("öffVF 2024-12-19. Entscheid ComCom ..."). ~64
decisions on 2026-09-03. A range that answers 404 is skipped.
"""
from __future__ import annotations

import datetime
import logging
import re

from ..http import FetchError, Fetcher
from .common import (PortalDoc, download_items, filename_of, lang_from_dam, parse_date,
                     safe_doc_id)

log = logging.getLogger(__name__)

SPIDER = "CH_COMCOM"
COURT_NAME = "Eidgenössische Kommunikationskommission ComCom"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.comcom.admin.ch"
FIRST_YEAR = 1998
_HASH = re.compile(r"/sd-web/([^/]+)/")


def ranges(today: datetime.date | None = None) -> list[tuple[int, int]]:
    year = (today or datetime.date.today()).year
    out = []
    y = FIRST_YEAR
    while y <= year:
        out.append((y, y + 1))
        y += 2
    return list(reversed(out))


def parse_page(page_html: str, span: tuple[int, int]) -> list[PortalDoc]:
    out, seen = [], set()
    for it in download_items(page_html, BASE):
        if not it.href.lower().endswith(".pdf"):
            continue
        h = _HASH.search(it.href)
        key = h.group(1) if h else it.href
        if key in seen:
            continue
        seen.add(key)
        decided = parse_date(filename_of(it.href)) or parse_date(it.title) or it.meta_date
        out.append(PortalDoc(
            doc_id=safe_doc_id("COMCOM", decided.isoformat() if decided else str(span[0]), key),
            url=it.href,
            text_source=TEXT_SOURCE,
            title=it.title or filename_of(it.href),
            decision_date=decided,
            docket_number=None,
            lang=lang_from_dam(it.href),
            extra={"status": it.description or None, "range": f"{span[0]}-{span[1]}",
                   "published": " ".join(it.meta) or None},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    out: list[PortalDoc] = []
    for span in ranges():
        try:
            page = await fetcher.text(f"{BASE}/de/entscheide-{span[0]}-{span[1]}")
        except FetchError as exc:
            log.info("%s: %s: %s", SPIDER, span, exc)
            continue
        out.extend(parse_page(page, span))
    return out
