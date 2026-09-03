"""FINMA's collection of insurance-law court decisions
(versicherungsrechtliche Entscheide): 2,610 PDFs on 2026-09-03, the same
search API as finma.py with the collection's own dataset id. An item's
Title is "21. Oktober 2024 Tessin Italienisch" -- date, then the deciding
court or canton, then the language -- and Link is the PDF under
/~/media/finma/dokumente/dokumentencenter/myfinma/versicherungsrecht/.
These are decisions of OTHER bodies (cantonal courts, the Federal Supreme
Court) that FINMA republishes; the row keeps FINMA as the spider and the
Title's body as the chamber so the origin stays visible.
"""
from __future__ import annotations

import logging
import re
from urllib.parse import urljoin

from ..http import FetchError, Fetcher
from .common import PortalDoc, lang_from_name, parse_date, safe_doc_id, stem_of

log = logging.getLogger(__name__)

SPIDER = "CH_FINMA_VR"
COURT_NAME = "FINMA — versicherungsrechtliche Entscheide (Sammlung)"
DECISION_TYPE = "Entscheid"
TEXT_SOURCE = "pdf"
BASE = "https://www.finma.ch"
API = BASE + "/de/api/search/getresult"
DATASET = "{F475205A-A058-469A-88B2-FBAFA2C00FD1}"
REFERER = BASE + "/de/dokumentation/versicherungsrechtliche-entscheide/"

_DATE_PREFIX = re.compile(r"^\s*\d{1,2}\.?\s+\S+\s+\d{4}\s*")


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    try:
        payload = await fetcher.post_json(API, data={"ds": DATASET, "Order": "4"},
                                          headers={"Referer": REFERER})
    except FetchError as exc:
        log.error("%s: listing failed: %s", SPIDER, exc)
        return []
    out, seen = [], set()
    for it in payload.get("Items") or []:
        link = it.get("Link") or ""
        # The API lists 24 of the 2,610 files two or three times (same Link, same
        # Title, 2026-09-03); one row each.
        if not link.lower().endswith(".pdf") or link in seen:
            continue
        seen.add(link)
        title = (it.get("Title") or "").strip()
        body = _DATE_PREFIX.sub("", title)                      # "Tessin Italienisch"
        lang = lang_from_name(title)
        origin = re.sub(r"\s*(Deutsch|Französisch|Italienisch)\s*$", "", body).strip() or None
        stem = stem_of(link)
        # The filename alone collides: 25 of 2,610 files on 2026-09-03 share a
        # stem with a file in another year's folder. The folder is part of the id.
        folder = link.rstrip("/").rsplit("/", 2)[-2] if link.count("/") >= 2 else ""
        out.append(PortalDoc(
            doc_id=safe_doc_id("VR", folder, stem),
            url=urljoin(BASE, link),
            text_source=TEXT_SOURCE,
            title=title or stem,
            decision_date=parse_date(it.get("Date")) or parse_date(title),
            docket_number=stem,
            lang=lang,
            chamber=origin,
            extra={"origin": origin, "description": it.get("Description")},
        ))
    return out
