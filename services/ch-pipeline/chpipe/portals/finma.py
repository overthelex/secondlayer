"""FINMA enforcement case reports (Kasuistik).

finma.ch has a search API: `POST /de/api/search/getresult` with the dataset
id of the Kasuistik and `Order=4` answers the whole list in one JSON (455
items on 2026-09-03, no paging). Each item is `{Title: '2025-35', Date:
'19.12.2025', Link: '/de/dokumentation/enforcementberichterstattung/kasuistik/2025-35/',
FacetColumn: 'Bewilligte', ...}`; the text is the detail page itself -- an
HTML table (Partei / Bereich / Thema / Zusammenfassung / Massnahmen /
Rechtskraft), so the row is fetched as HTML and text_source is 'html'.
The site wants the listing page as Referer on the API call.
"""
from __future__ import annotations

import logging
from urllib.parse import urljoin

from ..http import FetchError, Fetcher
from .common import PortalDoc, parse_date, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_FINMA"
COURT_NAME = "Eidgenössische Finanzmarktaufsicht FINMA (Enforcement)"
DECISION_TYPE = "Kasuistik"
TEXT_SOURCE = "html"
BASE = "https://www.finma.ch"
API = BASE + "/de/api/search/getresult"
DATASET = "{2FBD0DFE-112F-4176-BE8D-07C2D0BE0903}"
REFERER = BASE + "/de/dokumentation/enforcementberichterstattung/kasuistik/"


async def _listing(fetcher: Fetcher) -> list[dict]:
    payload = await fetcher.post_json(API, data={"ds": DATASET, "Order": "4"},
                                      headers={"Referer": REFERER})
    return payload.get("Items") or []


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    try:
        items = await _listing(fetcher)
    except FetchError as exc:
        log.error("%s: listing failed: %s", SPIDER, exc)
        return []
    out = []
    for it in items:
        title = (it.get("Title") or "").strip()
        link = it.get("Link") or ""
        if not title or not link:
            continue
        out.append(PortalDoc(
            doc_id=safe_doc_id("FINMA", title),
            url=urljoin(BASE, link),
            text_source=TEXT_SOURCE,
            title=f"FINMA Kasuistik {title}",
            decision_date=parse_date(it.get("Date")),
            docket_number=title,
            lang="de",
            chamber=it.get("FacetColumn") or None,
            extra={"facet": it.get("FacetColumn"), "category": it.get("Category")},
        ))
    return out
