"""EMARK / JICRA / GICRA -- the published decisions of the Schweizerische
Asylrekurskommission (1993-2006), a closed archive on
ark-cra.rekurskommissionen.ch. No index: a decision is
/assets/resources/ark/emark/{year}/{nr:02d}.htm, enumerated per year
(at most ~45 a year; the first missing number after a run of hits ends
the year, a 404 inside the run is a gap). 237 decisions on 2026-09-03.
The pages are ISO-8859-1 HTML; fetch_stage keeps the Content-Type charset
with the body, which is what makes the umlauts survive extraction.

The archive is closed, so a walk that already knows every decision of a
year is not repeated: discover() probes only years with no known doc, or
everything when CHPIPE_PORTAL_FULL=1.
"""
from __future__ import annotations

import datetime
import logging
import os
import re

from ..http import FetchError, Fetcher
from .common import PortalDoc, parse_date, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_EMARK"
COURT_NAME = "Schweizerische Asylrekurskommission ARK (EMARK)"
DECISION_TYPE = "Urteil"
TEXT_SOURCE = "html"
BASE = "https://ark-cra.rekurskommissionen.ch/assets/resources/ark/emark"
YEARS = range(1993, 2007)
MAX_NR = 60
MISSES_TO_STOP = 6
_TAGS = re.compile(r"<[^>]+>")


def url_for(year: int, nr: int) -> str:
    return f"{BASE}/{year}/{nr:02d}.htm"


def doc_for(year: int, nr: int, page_html: str | None) -> PortalDoc:
    text = re.sub(r"\s+", " ", _TAGS.sub(" ", page_html or ""))[:3000]
    m = re.search(r"(?:Urteil|Entscheid|arrêt|décision|sentenza|decisione)\s+(?:vom|du|del|dell')\s+([^,;]{6,40})", text, flags=re.I)
    decided = parse_date(m.group(1)) if m else None
    lang = "de"
    if re.search(r"\b(arrêt|décision|du)\b", text[:400], flags=re.I) and not re.search(r"\bUrteil\b", text[:400]):
        lang = "fr"
    if re.search(r"\b(sentenza|decisione)\b", text[:400], flags=re.I):
        lang = "it"
    return PortalDoc(
        doc_id=safe_doc_id(f"EMARK-{year}-{nr:02d}"),
        url=url_for(year, nr),
        text_source=TEXT_SOURCE,
        title=f"EMARK {year}/{nr}",
        decision_date=decided or datetime.date(year, 12, 31),
        docket_number=f"EMARK {year}/{nr}",
        lang=lang,
        extra={"year": year, "nr": nr},
    )


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    full = os.environ.get("CHPIPE_PORTAL_FULL", "") not in ("", "0")
    known_years = {int(d.split("-")[1]) for d in known if d.startswith("EMARK-")}
    out: list[PortalDoc] = []
    for year in YEARS:
        if year in known_years and not full:
            continue
        misses = 0
        for nr in range(1, MAX_NR + 1):
            try:
                page = await fetcher.text(url_for(year, nr))
            except FetchError:
                misses += 1
                if misses >= MISSES_TO_STOP:
                    break
                continue
            misses = 0
            out.append(doc_for(year, nr, page))
    return out
