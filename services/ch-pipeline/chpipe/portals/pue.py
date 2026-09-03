"""Preisüberwacher -- formal decisions, amicable settlements, recommendations.

Three static pages under /pue/de/home/dokumentation/publikationen/, plain
<a> links to PDFs whose anchor text starts with the date ("20.05.2025 -
Verfügung gegen Booking.com"). Court rulings the office republishes
(Bundesverwaltungsgerichtsurteil, Bundesgerichtsurteil) are skipped --
they belong to the courts' own spiders. ~27 documents on 2026-09-03.
"""
from __future__ import annotations

import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, links, parse_date, safe_doc_id, stem_of

log = logging.getLogger(__name__)

SPIDER = "CH_PUE"
COURT_NAME = "Preisüberwacher"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.preisueberwacher.admin.ch"
PAGES = (
    ("/pue/de/home/dokumentation/publikationen/formelle-entscheide.html", "Verfügung"),
    ("/pue/de/home/dokumentation/publikationen/einvernehmliche-regelungen.html", "Einvernehmliche Regelung"),
    ("/pue/de/home/dokumentation/publikationen/empfehlungen.html", "Empfehlung"),
)
_COURT_RULING = re.compile(r"(Bundesverwaltungsgericht|Bundesgericht|Verwaltungsgericht)s?urteil|Urteil des", re.I)
_SIZE = re.compile(r"\s*\((PDF|DOCX?)[^)]*\)\s*$", re.I)


def parse_page(page_html: str, kind: str) -> list[PortalDoc]:
    out, seen = [], set()
    for href, text in links(page_html, BASE, r"\.pdf"):
        text = _SIZE.sub("", text).strip()
        if _COURT_RULING.search(text) or _COURT_RULING.search(href):
            continue
        stem = stem_of(href.split(".download.pdf/", 1)[-1])
        doc_id = safe_doc_id("PUE", stem)
        if doc_id in seen:
            continue
        seen.add(doc_id)
        out.append(PortalDoc(
            doc_id=doc_id,
            url=href,
            text_source=TEXT_SOURCE,
            title=re.sub(r"^\d{1,2}\.\d{2}\.\d{4}\s*-\s*", "", text) or stem,
            decision_date=parse_date(text) or parse_date(stem),
            docket_number=None,
            lang="de",
            chamber=kind,
            extra={"kind": kind},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    out: list[PortalDoc] = []
    for path, kind in PAGES:
        try:
            out.extend(parse_page(await fetcher.text(BASE + path), kind))
        except FetchError as exc:
            log.error("%s: %s: %s", SPIDER, path, exc)
    return out
