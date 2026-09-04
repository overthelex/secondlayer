"""ESBK -- Eidgenössische Spielbankenkommission, Verfügungen and Strafbescheide.

A Nuxt site like PostCom: /de/strafrecht and /de/verwaltungsrecht carry
their PDFs in `__NUXT_DATA__`, filename "62-2023-016-01-f.pdf" = docket
"62-2023-016-01" plus a language letter (d/f/i), url on
backend.esbk.admin.ch/fileservice/. 43 files on 2026-09-03 (27 + 16).
The decision date is not in the file object; it stays NULL and the
extract's text is what carries it.
"""
from __future__ import annotations

import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, lang_from_name, nuxt_files, nuxt_payload, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_ESBK"
COURT_NAME = "Eidgenössische Spielbankenkommission ESBK"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.esbk.admin.ch"
PAGES = (("/de/strafrecht", "Strafbescheid"), ("/de/verwaltungsrecht", "Verfügung"))
# "62-2023-016-01" (current) and the legacy "81-07-046-01" (strafbescheid-81-07-046-01.pdf).
_DOCKET = re.compile(r"(\d{2}-\d{2,4}-\d{2,4}(?:-\d{1,2})?)", re.I)


def parse_page(page_html: str, kind: str) -> list[PortalDoc]:
    out, seen = [], set()
    for f in nuxt_files(nuxt_payload(page_html)):
        name = f.get("filename") or ""
        url = f.get("url")
        if not url or not name.lower().endswith(".pdf"):
            continue
        stem = re.sub(r"\.pdf$", "", name, flags=re.I)
        m = _DOCKET.search(stem)
        docket = m.group(1) if m else None
        doc_id = safe_doc_id(stem)
        if doc_id in seen:
            continue
        seen.add(doc_id)
        out.append(PortalDoc(
            doc_id=doc_id,
            url=url,
            text_source=TEXT_SOURCE,
            title=f"ESBK {kind} {docket or stem}",
            decision_date=None,
            docket_number=docket,
            lang=lang_from_name(name) or "de",
            chamber=kind,
            decision_type=kind,
            extra={"kind": kind, "filename": name},
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
