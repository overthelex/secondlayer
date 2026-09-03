"""ElCom -- Eidgenössische Elektrizitätskommission, Verfügungen.

One server-rendered page (/de/verfuegungen, ~2 MB) lists every decision
since 2008 twice -- by date and by topic -- as admin.ch download-items:
title "211-00500 Anrechenbarkeit der Mehrkosten ..., 2.6.2026" (docket
first, decision date last), a description with the legal-force status,
and the PDF under /dam/{lang}/sd-web/{hash}/. 1,022 items = 433 distinct
PDFs on 2026-09-03; the DAM hash is the identity.
"""
from __future__ import annotations

import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, download_items, lang_from_dam, last_date, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_ELCOM"
COURT_NAME = "Eidgenössische Elektrizitätskommission ElCom"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.elcom.admin.ch"
PAGE = BASE + "/de/verfuegungen"
_DOCKET = re.compile(r"^\s*(\d{2,3}-\d{4,5})\b")
_HASH = re.compile(r"/sd-web/([^/]+)/")


def parse_page(page_html: str) -> list[PortalDoc]:
    out, seen = [], set()
    for it in download_items(page_html, BASE):
        h = _HASH.search(it.href)
        key = h.group(1) if h else it.href
        if key in seen or not it.href.lower().endswith(".pdf"):
            continue
        seen.add(key)
        d = _DOCKET.match(it.title)
        docket = d.group(1) if d else None
        out.append(PortalDoc(
            doc_id=safe_doc_id(docket or "elcom", key),
            url=it.href,
            text_source=TEXT_SOURCE,
            title=it.title,
            decision_date=last_date(it.title),      # the meta date is the publication date, not the decision's
            docket_number=docket,
            lang=lang_from_dam(it.href),
            extra={"status": it.description or None, "published": " ".join(it.meta) or None},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    try:
        return parse_page(await fetcher.text(PAGE))
    except FetchError as exc:
        log.error("%s: listing failed: %s", SPIDER, exc)
        return []
