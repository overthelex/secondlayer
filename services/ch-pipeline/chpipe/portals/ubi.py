"""UBI -- Unabhängige Beschwerdeinstanz für Radio und Fernsehen.

A TYPO3 table at /de/entscheide/entscheide-suchen-sie-mit-suchkriterien,
10 rows a page (each ~9 s server-side, ~11 min for the whole archive), paged by a "Nächster" link that carries the extension's
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
# One PDF may carry several joined decisions: b_998_1017_1021_1026.pdf is
# four rows, each with its own "b.998 (de, pdf)" marker in the description.
_PDF = re.compile(r'href="([^"]*/(?:inhalte/entscheide|fileadmin/user_upload)/(b[._]\d{3,4}(?:[._]\d{3,4})*)\.pdf)"', re.I)
# "b.998 (de, pdf)", "b.750a (de, pdf)", and the joined "b.701 702 (de, pdf)": the first number is the row's.
_OWN = re.compile(r"\b(b[._]\d{3,4}[a-z]?)(?:[\s/]+\d{3,4})*\s*\((\w+),\s*pdf\)", re.I)
_LABELLED = re.compile(r'<b class="tablesaw-cell-label">(.*?)</b>(.*?)(?=<b class="tablesaw-cell-label">|$)', re.S)
_CELL = re.compile(r'<td class="column-([a-z]+)"[^>]*>(.*?)</td>', re.S)
_NEXT = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>\s*N(?:ä|&auml;|a)chster\s*</a>')
_TAGS = re.compile(r"<[^>]+>")
_CELL_LABEL = re.compile(r'<b class="tablesaw-cell-label">.*?</b>', re.S)   # the responsive table repeats the header in every cell


def _text(s: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(_TAGS.sub(" ", _CELL_LABEL.sub("", s)))).strip()


def _labelled(cell_html: str) -> dict[str, str]:
    """A cell that stacks several labelled values ("Veranstalter" and
    "Sendung/ Publikation" share one td) by label."""
    return {re.sub(r"\s+", " ", _TAGS.sub("", k)).strip(): _text(v) for k, v in _LABELLED.findall(cell_html)}


def parse_page(page_html: str) -> tuple[list[PortalDoc], str | None]:
    docs = []
    for row in _ROW.findall(page_html):
        m = _PDF.search(row)
        if not m:
            continue
        raw = dict(_CELL.findall(row))
        cells = {k: _text(v) for k, v in raw.items()}
        own = _OWN.search(cells.get("beschreibung", ""))
        href = m.group(1)
        number = (own.group(1) if own else re.match(r"b[._]\d{3,4}", m.group(2), re.I).group(0)).lower().replace("_", ".")
        beschluss = cells.get("beschluss", "")
        lang = lang_from_name(beschluss) or (own.group(2).lower() if own else None)
        outcome = re.split(r"\s+\d{1,2}\.\d{1,2}\.\d{4}", beschluss, 1)[0].strip() or None
        description = _OWN.sub("", cells.get("beschreibung", "")).strip()
        who = _labelled(raw.get("veranstalter", ""))
        docs.append(PortalDoc(
            doc_id=safe_doc_id(number),
            url=urljoin(BASE, htmllib.unescape(href)),
            text_source=TEXT_SOURCE,
            title=f"UBI {number}: {description}".strip(": "),
            decision_date=parse_date(beschluss),
            docket_number=number,
            lang=lang,
            extra={"outcome": outcome, "medium": cells.get("medium"),
                   "broadcaster": who.get("Veranstalter") or cells.get("veranstalter"),
                   "programme": who.get("Sendung/ Publikation") or None,
                   "complaint": cells.get("beschwerdetyp"),
                   "provisions": cells.get("bestimmungen"), "keywords": cells.get("schluesselwoerter")},
        ))
    n = _NEXT.search(page_html)
    nxt = urljoin(BASE, htmllib.unescape(n.group(1))) if n else None
    return docs, nxt


EMPTY_PAGES_TO_STOP = 2     # the tail of the list (before 1998) has rows without a PDF


def merge(docs: list[PortalDoc]) -> list[PortalDoc]:
    """One row per decision number. Two complaints settled together are
    usually lettered (b.750 and b.750a, one PDF) and stay two rows; where
    the site repeats a number, same PDF, the second description joins the
    title. A second row with another file (b.701 next to b_701_702.pdf)
    is the site's inconsistency; the first row wins."""
    by_id: dict[str, PortalDoc] = {}
    for d in docs:
        first = by_id.get(d.doc_id)
        if first is None:
            by_id[d.doc_id] = d
        elif first.url == d.url and d.title and d.title not in first.title:
            first.title = f"{first.title}; {d.title.split(': ', 1)[-1]}"
        else:
            log.info("%s: %s listed twice (%s, %s), keeping the first", SPIDER, d.doc_id, first.url, d.url)
    return list(by_id.values())


async def discover(fetcher: Fetcher, known: set[str]) -> list[PortalDoc]:
    out: list[PortalDoc] = []
    url: str | None = START
    seen_urls: set[str] = set()
    empty = 0
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
        empty = 0 if docs else empty + 1
        if empty >= EMPTY_PAGES_TO_STOP:
            break
        out.extend(docs)
    return merge(out)
