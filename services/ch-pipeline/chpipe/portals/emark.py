"""EMARK / JICRA / GICRA -- the published decisions of the Schweizerische
Asylrekurskommission (1993-2006), a closed archive on
ark-cra.rekurskommissionen.ch. No index: a decision is
/assets/resources/ark/emark/{year}/{nr:02d}.htm, enumerated per year
(at most ~45 a year; the first missing number after a run of hits ends
the year, a 404 inside the run is a gap). 237 decisions on 2026-09-03.
The pages are ISO-8859-1 HTML; fetch_stage keeps the Content-Type charset
with the body, which is what makes the umlauts survive extraction.

The archive is closed, so a full re-walk is pointless -- but a walk can be
interrupted, so "known" must not mean "complete". Each year is probed from
the number after the highest one already known (from 1 when nothing is
known): a complete year costs MISSES_TO_STOP probes, an interrupted one
picks up where it stopped. CHPIPE_PORTAL_FULL=1 probes every year from 1.

The pages say charset=ISO-8859-1 in a <meta> and the server sends no
charset header, so httpx would decode them as UTF-8 and turn every umlaut
into U+FFFD; the bytes are decoded here by the declared charset.
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


_CHARSET = re.compile(r"charset=([\w-]+)", re.I)


def decode(body: bytes, content_type: str | None) -> str:
    """The page text by the charset the server or the page declares;
    UTF-8 when it decodes cleanly, Latin-1 otherwise (never U+FFFD)."""
    m = _CHARSET.search(content_type or "") or _CHARSET.search(body[:2048].decode("ascii", "ignore"))
    if m:
        try:
            return body.decode(m.group(1))
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("latin-1")


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


def _known_max(known: set[str]) -> dict[int, int]:
    out: dict[int, int] = {}
    for d in known:
        m = re.fullmatch(r"EMARK-(\d{4})-(\d+)", d)
        if m:
            y, n = int(m.group(1)), int(m.group(2))
            out[y] = max(out.get(y, 0), n)
    return out


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    full = os.environ.get("CHPIPE_PORTAL_FULL", "") not in ("", "0")
    known_max = {} if full else _known_max(known)
    out: list[PortalDoc] = []
    for year in YEARS:
        misses = 0
        for nr in range(known_max.get(year, 0) + 1, MAX_NR + 1):
            try:
                body, ctype = await fetcher.body(url_for(year, nr))
            except FetchError:
                misses += 1
                if misses >= MISSES_TO_STOP:
                    break
                continue
            misses = 0
            out.append(doc_for(year, nr, decode(body, ctype)))
    return out
