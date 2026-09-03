"""UBI -- Unabhängige Beschwerdeinstanz für Radio und Fernsehen.

A TYPO3 table at /de/entscheide/entscheide-suchen-sie-mit-suchkriterien,
21 rows a page, paged by a "Nächster" link that carries the extension's
cHash (so the next-page URL must be taken from the page, not built). Each
row has the decision number as a PDF link ("b.1111" -> /inhalte/entscheide/b.1111.pdf),
the medium, a cell "Beschluss / Datum / Sprache" (outcome, dd.mm.yyyy,
Deutsch|Französisch|Italienisch), the broadcaster and programme, and the
complaint type. ~667 decisions on 2026-09-03, i.e. ~32 pages.
"""
from __future__ import annotations

import html as htmllib
import logging
import re
from urllib.parse import urljoin

from ..http import FetchError, Fetcher
from .common import PortalDoc, lang_from_name, parse_date, safe_doc_id

log = logging.getLogger(__name__)

SPIDER = "CH_UBI"
COURT_NAME = "Unabhängige Beschwerdeinstanz für Radio und Fernsehen UBI"
DECISION_TYPE = "Entscheid"
TEXT_SOURCE = "pdf"
BASE = "https://www.ubi.admin.ch"
START = BASE + "/de/entscheide/entscheide-suchen-sie-mit-suchkriterien"
MAX_PAGES = 200

_ROW = re.compile(r"<tr\b.*?</tr>", re.S)
_PDF = re.compile(r'href="([^"]*/(?:inhalte/entscheide|fileadmin/user_upload)/(b[._]\d{3,4})\.pdf)"', re.I)
_CELL = re.compile(r'<td class="column-([a-z]+)"[^>]*>(.*?)</td>', re.S)
_NEXT = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>\s*N(?:ä|&auml;|a)chster\s*</a>')
_TAGS = re.compile(r"<[^>]+>")
_CELL_LABEL = re.compile(r'<b class="tablesaw-cell-label">.*?</b>', re.S)   # the responsive table repeats the header in every cell


def _text(s: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(_TAGS.sub(" ", _CELL_LABEL.sub("", s)))).strip()


def parse_page(page_html: str) -> tuple[list[PortalDoc], str | None]:
    docs = []
    for row in _ROW.findall(page_html):
        m = _PDF.search(row)
        if not m:
            continue
        href, number = m.group(1), m.group(2).replace("_", ".")
        cells = {k: _text(v) for k, v in _CELL.findall(row)}
        beschluss = cells.get("beschluss", "")
        lang = lang_from_name(beschluss)
        outcome = re.split(r"\s+\d{1,2}\.\d{1,2}\.\d{4}", beschluss, 1)[0].strip() or None
        docs.append(PortalDoc(
            doc_id=safe_doc_id(number),
            url=urljoin(BASE, htmllib.unescape(href)),
            text_source=TEXT_SOURCE,
            title=f"UBI {number}: {cells.get('sendung') or cells.get('beschwerde') or ''}".strip(": "),
            decision_date=parse_date(beschluss),
            docket_number=number,
            lang=lang,
            extra={"outcome": outcome, "medium": cells.get("medium"),
                   "programme": cells.get("sendung"), "complaint": cells.get("beschwerde")},
        ))
    n = _NEXT.search(page_html)
    nxt = urljoin(BASE, htmllib.unescape(n.group(1))) if n else None
    return docs, nxt


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    out: list[PortalDoc] = []
    url: str | None = START
    seen_urls: set[str] = set()
    for _ in range(MAX_PAGES):
        if not url or url in seen_urls:
            break
        seen_urls.add(url)
        try:
            page = await fetcher.text(url)
        except FetchError as exc:
            log.error("%s: %s: %s", SPIDER, url, exc)
            break
        docs, url = parse_page(page)
        if not docs:
            break
        out.extend(docs)
    return out
