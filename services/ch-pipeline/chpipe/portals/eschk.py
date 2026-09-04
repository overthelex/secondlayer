"""ESchK -- Eidgenössische Schiedskommission für die Verwertung von
Urheberrechten (tariff decisions). One admin.ch download-item page per
year, /de/beschluesse-{year}, from 1991; the title carries the tariff and
the decision date ("GT K (Beschluss vom 23. Januar 2024)"), the PDF is
under /dam/de/sd-web/. ~415 decisions on 2026-09-03. A missing year
answers 404 and is skipped.
"""
from __future__ import annotations

import datetime
import logging

from ..http import FetchError, Fetcher
from .common import PortalDoc, download_items, lang_from_dam, parse_date, safe_doc_id, stem_of

log = logging.getLogger(__name__)

SPIDER = "CH_ESCHK"
COURT_NAME = "Eidgenössische Schiedskommission für die Verwertung von Urheberrechten ESchK"
DECISION_TYPE = "Beschluss"
TEXT_SOURCE = "pdf"
BASE = "https://www.eschk.admin.ch"
FIRST_YEAR = 1991


def parse_year(page_html: str, year: int) -> list[PortalDoc]:
    out = []
    for it in download_items(page_html, BASE):
        if not it.href.lower().endswith(".pdf"):
            continue
        stem = stem_of(it.href)
        out.append(PortalDoc(
            doc_id=safe_doc_id(str(year), stem),
            url=it.href,
            text_source=TEXT_SOURCE,
            title=it.title or stem,
            decision_date=parse_date(it.title) or it.meta_date or datetime.date(year, 12, 31),
            docket_number=stem,
            lang=lang_from_dam(it.href) or "de",
            extra={"year": year, "description": it.description or None},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    out: list[PortalDoc] = []
    for year in range(datetime.date.today().year, FIRST_YEAR - 1, -1):
        try:
            page = await fetcher.text(f"{BASE}/de/beschluesse-{year}")
        except FetchError as exc:
            log.info("%s: %d: %s", SPIDER, year, exc)
            continue
        out.extend(parse_year(page, year))
    return out
