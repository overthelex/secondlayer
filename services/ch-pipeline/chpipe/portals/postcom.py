"""PostCom -- Eidgenössische Postkommission, Verfügungen.

A Nuxt site: /de/verfuegungen renders nothing server-side but carries the
page content in `__NUXT_DATA__`; the PDF objects in it have a `filename`
that is the whole record -- either
"02.02.2023 - Verfügung 1-2023 betreffend Hausbriefkasten - rechtskräftig.pdf"
or "VFG_6_2026_PostCom_betreffend Standort ..._20260513.pdf" -- and a
`url` on backend.postcom.admin.ch/fileservice/. 282 PDFs on 2026-09-03,
German page only (the fr/it pages are the same documents' translations
where they exist and are left for a later pass).
"""
from __future__ import annotations

import logging
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, lang_from_name, nuxt_files, nuxt_payload, parse_date, safe_doc_id, stem_of

log = logging.getLogger(__name__)

SPIDER = "CH_POSTCOM"
COURT_NAME = "Eidgenössische Postkommission PostCom"
DECISION_TYPE = "Verfügung"
TEXT_SOURCE = "pdf"
BASE = "https://www.postcom.admin.ch"
PAGE = BASE + "/de/verfuegungen"
_VFG_A = re.compile(r"Verf[üu]gung\s+(\d+)[-/](\d{4})", re.I)
_VFG_B = re.compile(r"VFG_(\d+)_(\d{4})", re.I)
_STATUS = re.compile(r"(nicht\s+rechtskr[äa]ftig|teilweise\s+rechtskr[äa]ftig|rechtskr[äa]ftig)", re.I)
_TRAIL_DATE = re.compile(r"_(\d{4})(\d{2})(\d{2})$")


def doc_from_file(f: dict) -> PortalDoc | None:
    name = f.get("filename") or ""
    url = f.get("url")
    if not url or not name.lower().endswith(".pdf"):
        return None
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    m = _VFG_A.search(stem) or _VFG_B.search(stem)
    docket = f"VFG-{m.group(1)}-{m.group(2)}" if m else None
    decided = parse_date(stem)
    if not decided:
        t = _TRAIL_DATE.search(stem)
        decided = parse_date(f"{t.group(1)}-{t.group(2)}-{t.group(3)}") if t else None
    s = _STATUS.search(stem)
    title = re.sub(r"^\d{1,2}\.\d{2}\.\d{4}\s*-\s*", "", stem)
    title = re.sub(r"\s*-\s*(nicht\s+|teilweise\s+)?rechtskr[äa]ftig\s*$", "", title, flags=re.I)
    title = re.sub(r"_", " ", title).strip()
    # The file's own uuid (the url's stem) keeps an annex apart from the decision
    # it shares a docket with; the docket in front keeps the id readable.
    return PortalDoc(
        doc_id=safe_doc_id(docket or "VFG", stem_of(url).split("-")[0][:8]),
        url=url,
        text_source=TEXT_SOURCE,
        title=title or stem,
        decision_date=decided,
        docket_number=docket,
        lang=lang_from_name(name) or "de",
        extra={"status": s.group(1).lower() if s else None, "filename": name},
    )


def parse_page(page_html: str) -> list[PortalDoc]:
    payload = nuxt_payload(page_html)
    out, seen = [], set()
    for f in nuxt_files(payload):
        d = doc_from_file(f)
        if d and d.doc_id not in seen:
            seen.add(d.doc_id)
            out.append(d)
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    try:
        return parse_page(await fetcher.text(PAGE))
    except FetchError as exc:
        log.error("%s: listing failed: %s", SPIDER, exc)
        return []
