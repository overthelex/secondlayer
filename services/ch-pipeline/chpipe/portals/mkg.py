"""MKG -- Militärkassationsgericht, published decisions (MKGE).

oa.admin.ch/de/urteile-militarkassationsgericht is an admin.ch
download-item page. Two kinds of file sit on it: single decisions
("MKGE 16 Nr. 1.pdf") and bound volumes ("MKGE - ATM - STMC 16 N° 1-16.pdf",
"Entscheide MKG Band 14 (2014-2021).pdf") that repeat the same decisions.
This pass takes the single decisions only -- 58 of 76 files on 2026-09-03;
slicing the volumes (which is where the pre-2014 decisions and the
1,244-decision figure opencaselaw reports come from) is a later, separate
pass. Decisions are trilingual in their headnotes and in the language of
the case in the body; the language is left NULL for the extract to judge.
"""
from __future__ import annotations

import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, download_items, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_MKG"
COURT_NAME = "Militärkassationsgericht MKG"
DECISION_TYPE = "Urteil"
TEXT_SOURCE = "pdf"
BASE = "https://www.oa.admin.ch"
PAGE = BASE + "/de/urteile-militarkassationsgericht"
_SINGLE = re.compile(r"^\s*MKGE\s+(\d+)\s+Nr\.?\s*(\d+)\s*$", re.I)


def parse_page(page_html: str) -> list[PortalDoc]:
    out, seen = [], set()
    for it in download_items(page_html, BASE):
        m = _SINGLE.match(it.title)
        if not m or not it.href.lower().endswith(".pdf"):
            continue
        band, nr = int(m.group(1)), int(m.group(2))
        doc_id = safe_doc_id(f"MKGE-{band}-{nr}")
        if doc_id in seen:
            continue
        seen.add(doc_id)
        out.append(PortalDoc(
            doc_id=doc_id,
            url=it.href,
            text_source=TEXT_SOURCE,
            title=f"MKGE {band} Nr. {nr}",
            decision_date=None,
            docket_number=f"MKGE {band} Nr. {nr}",
            lang=None,
            extra={"band": band, "nr": nr, "published": " ".join(it.meta) or None},
        ))
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    try:
        return parse_page(await fetcher.text(PAGE))
    except FetchError as exc:
        log.error("%s: listing failed: %s", SPIDER, exc)
        return []
