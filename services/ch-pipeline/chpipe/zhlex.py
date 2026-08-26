"""ZH-Lex, the Zürich law collection on zh.ch: index enumeration, edition
pages, edition dates and the Domino HTML text of the older editions.

Zürich is the largest of the seven cantons without a Lexwork host. Its
collection is served by an AEM site (www.zh.ch) in front of a Lotus Domino
database (www.notes.zh.ch). Everything below was read out of the site's
own SPA bundle (main.06e084f.min.js, class FlexData.constructUrl) and
verified by hand on 2026-08-26/27:

  * The index endpoint answers the search form's field names as query
    parameters. Without parameters it lists in-force acts, 15 per page,
    and caps the result at 150 (`moreSearchResultsThanAllowed`). With
    `includeRepealedEnactments=true` every row is an EDITION (a Nachtrag,
    with its `withdrawalDate`), not an act: 101 alone is 26 rows. The
    only filter that reaches every row and slices finely enough is
    `enactmentDate=YYYY-MM-DD_YYYY-MM-DD` (the form's date range, ISO
    with an underscore); `fileNumber=1..14` (the systematic chapters,
    944 in-force acts in total, exactly LexFind's active count) is the
    second axis when a single day is still over the cap. A short
    `referenceNumber` answers 204 (no body), so numbers are not a usable
    slicing axis.
  * An edition page (erlass-{nr}-{enactment}-{entry}-{version}.html)
    carries no law text: a description list (Erlassdatum,
    Inkraftsetzungsdatum, Aufhebungsdatum, Publikationsdatum ...), the
    full Historie of the act as radio links, and the text as a download
    link on notes.zh.ch: a PDF (`OpenAttachment?...&file=...pdf`) for the
    editions since about 2005, a Domino HTML rendering (`WebRT/{docid}`)
    for the loose-leaf editions before that, occasionally both (101/039).
  * Editions of one Ordnungsnummer form ONE Nachtrag series across
    re-enactments: 101 runs 000..039 for the 1869 constitution and
    051..129 for the 2005 one; 131.6 has 000/069/099 for the 1990 act and
    111 for the 2020 act. The act is therefore keyed on the number, and a
    point-in-time lookup of "101 in 1990" resolves to the 1869 text --
    which is what a lawyer expects the number to mean.

Dates. Publikationsdatum is the day an edition took effect (LexFind lists
exactly those as version_active_since: 101 -> 01.07.2024, 01.04.2023,
01.11.2022 ...). The loose-leaf editions before 2006 have none; their
predecessor's Aufhebungsdatum is the last day of a quarter (101/000
30.09.1995, /011 31.12.1995, /012 31.03.1996), so the successor starts the
day after. Newer Aufhebungsdatum values are the day the successor took
effect (101/121: 01.07.2024 = 129's Publikationsdatum), which is why the
end of an edition is always derived from its successor's start, never
read from the label, exactly as cantonal_acts_stage does for Lexwork.
"""
from __future__ import annotations

import asyncio
import datetime
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode

from lxml import html as lxml_html

from . import akn, text_extract
from .http import Fetcher

SITE = "https://www.zh.ch"
INDEX_URL = (SITE + "/de/politik-staat/gesetze-beschluesse/gesetzessammlung/_jcr_content/main/"
             "lawcollectionsearch_312548694.zhweb-zhlex-ls.zhweb-cache.json")
PAGE_SIZE = 15
RESULT_CAP = 150
FILE_NUMBERS = range(1, 15)
# The oldest act on the site is 112 of 19.05.1841; the range is open-ended
# forward so acts enacted after a deploy are still found.
FIRST_ENACTMENT = datetime.date(1800, 1, 1)

WEBRT_PREFIX = "https://www.notes.zh.ch/appl/zhlex_r.nsf/WebRT/"
PDF_PREFIX = "https://www.notes.zh.ch/appl/zhlex_r.nsf/OpenAttachment"


class ZhlexParseError(ValueError):
    pass


_DATE = re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{4})\s*$")
# The Nachtrag number is three digits, occasionally with a letter (631.41
# has 008 and 008b: a correction delivered between two numbered ones).
_LINK = re.compile(r"erlass-([0-9_]+)-(\d{4}_\d{2}_\d{2})?-(\d{4}_\d{2}_\d{2})?-(\d{3}[a-z]?)\.html$")
_VERSION_KEY = re.compile(r"^(\d+)([a-z]?)$")
_LABEL_UNTIL = re.compile(r"in Kraft bis\s+(\d{2}\.\d{2}\.\d{4})")
_WS = re.compile(r"\s+")


def _date(text: str | None) -> datetime.date | None:
    m = _DATE.match(text or "")
    if not m:
        return None
    return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))


# --- index -----------------------------------------------------------------

@dataclass(frozen=True)
class IndexStub:
    sr_number: str
    title: str
    enactment_date: datetime.date | None
    withdrawal_date: datetime.date | None
    page_url: str
    version_no: str


@dataclass
class IndexPage:
    stubs: list[IndexStub]
    number_of_results: int
    number_of_pages: int
    capped: bool
    # Links the edition-link regex refused: counted by the walk and reported,
    # never a reason to abandon the other ~5,100 rows.
    unparsed: list[str] = field(default_factory=list)


def index_url(enactment_from: datetime.date, enactment_to: datetime.date, page: int = 1,
              file_number: int | None = None) -> str:
    query = [("includeRepealedEnactments", "true"),
             ("enactmentDate", f"{enactment_from.isoformat()}_{enactment_to.isoformat()}")]
    if file_number is not None:
        query.append(("fileNumber", str(file_number)))
    query.append(("page", str(page)))
    return INDEX_URL + "?" + urlencode(query)


def parse_version_link(href: str) -> tuple[str, str, str, str]:
    """'erlass-131_1-1926_06_06-1926_06_22-095.html' ->
    ('131.1', '1926-06-06', '1926-06-22', '095'). The entry-into-force
    part is empty for the old loose-leaf editions ('erlass-101-1869_04_18--039')."""
    m = _LINK.search(href)
    if not m:
        raise ZhlexParseError(f"not an edition link: {href!r}")
    return (m.group(1).replace("_", "."), (m.group(2) or "").replace("_", "-"),
            (m.group(3) or "").replace("_", "-"), m.group(4))


def version_key(version_no: str) -> tuple[int, str]:
    """Nachtrag order: '008' < '008b' < '009'."""
    m = _VERSION_KEY.match(version_no)
    if not m:
        raise ZhlexParseError(f"not a Nachtrag number: {version_no!r}")
    return int(m.group(1)), m.group(2)


def parse_index_page(data: dict) -> IndexPage:
    stubs = []
    unparsed = []
    for row in data.get("data") or []:
        link = row.get("link") or ""
        try:
            sr, _, _, version = parse_version_link(link)
        except ZhlexParseError:
            unparsed.append(link)
            continue
        stubs.append(IndexStub(
            sr_number=row.get("referenceNumber") or sr,
            title=_WS.sub(" ", row.get("enactmentTitle") or "").strip(),
            enactment_date=_date(row.get("enactmentDate")),
            withdrawal_date=_date(row.get("withdrawalDate")),
            page_url=link if link.startswith("http") else SITE + link,
            version_no=version))
    return IndexPage(stubs, int(data.get("numberOfResults") or 0),
                     int(data.get("numberOfResultPages") or 0),
                     bool(data.get("moreSearchResultsThanAllowed")), unparsed)


# --- edition page ----------------------------------------------------------

@dataclass(frozen=True)
class Edition:
    version_no: str
    label: str
    in_force_until: datetime.date | None
    page_url: str


@dataclass
class ActPage:
    sr_number: str
    title: str
    short_title: str | None
    enactment_date: datetime.date | None
    entry_into_force: datetime.date | None
    withdrawal_date: datetime.date | None
    publication_date: datetime.date | None
    volume: str | None
    notes: str | None
    version_no: str
    act_url: str | None
    versions: list[Edition] = field(default_factory=list)
    pdf_url: str | None = None
    html_url: str | None = None


def _dash(text: str) -> str | None:
    text = _WS.sub(" ", text).strip()
    return None if text in ("", "-", "–") else text


def parse_act_page(payload: bytes | str, content_type: str | None = None) -> ActPage:
    if isinstance(payload, bytes):
        payload = text_extract.decode_html(payload, content_type)
    root = lxml_html.fromstring(payload)
    fields: dict[str, str] = {}
    for dt in root.iter("dt"):
        dd = dt.getnext()
        if dd is None or dd.tag != "dd":
            continue
        key = _WS.sub(" ", dt.text_content()).strip()
        span = dd.find("span")
        value = span.text_content() if span is not None else dd.text_content()
        fields[key] = _WS.sub(" ", value).strip()
    number = _dash(fields.get("Ordnungsnummer", ""))
    if not number:
        raise ZhlexParseError("no Ordnungsnummer on the page")
    heading = root.find(".//h1")
    title = _dash(heading.text_content()) if heading is not None else None
    title = title or _dash(fields.get("Erlasstitel", ""))
    if not title:
        raise ZhlexParseError(f"{number}: no title on the page")

    versions: list[Edition] = []
    selected: str | None = None
    for item in root.iter("input"):
        if item.get("name") != "singleSelectHistory":
            continue
        anchor = item.getparent()
        while anchor is not None and anchor.tag != "a":
            anchor = anchor.getparent()
        label_el = root.find(f".//label[@for='{item.get('id')}']") if item.get("id") else None
        label = _WS.sub(" ", (label_el.text_content() if label_el is not None
                              else item.get("placeholder") or "")).strip()
        href = anchor.get("href") if anchor is not None else None
        if not href:
            continue
        m = _LABEL_UNTIL.search(label)
        versions.append(Edition(item.get("value") or parse_version_link(href)[3], label,
                                _date(m.group(1)) if m else None,
                                href if href.startswith("http") else SITE + href))
        if item.get("checked") is not None:
            selected = item.get("value")
    act_url = None
    for key, value in fields.items():
        if key.startswith("Link auf aktuelle"):
            act_url = value.split(" Link")[0].strip() or None
    pdf_url = html_url = None
    for a in root.iter("a"):
        href = a.get("href") or ""
        if href.startswith(PDF_PREFIX) and pdf_url is None:
            pdf_url = href
        elif href.startswith(WEBRT_PREFIX) and html_url is None:
            html_url = href
    if selected is None:
        for key in fields:
            if key.startswith("Link auf ") and not key.startswith("Link auf aktuelle"):
                selected = key.split()[2]
    if selected is None:
        raise ZhlexParseError(f"{number}: cannot tell which edition this page is")
    return ActPage(
        sr_number=number, title=title, short_title=_dash(fields.get("Kurztitel", "")),
        enactment_date=_date(fields.get("Erlassdatum")),
        entry_into_force=_date(fields.get("Inkraftsetzungsdatum")),
        withdrawal_date=_date(fields.get("Aufhebungsdatum")),
        publication_date=_date(fields.get("Publikationsdatum")),
        volume=_dash(fields.get("Bandnummer", "")), notes=_dash(fields.get("Hinweise", "")),
        version_no=selected, act_url=act_url, versions=versions,
        pdf_url=pdf_url, html_url=html_url)


def text_url(page: ActPage) -> tuple[str, str] | None:
    """('html', url) when the edition has a Domino rendering -- parseable
    here and now by parse_webrt -- else ('pdf', url), else None. 101/039
    has both and the HTML is the same text without the PDF round trip."""
    if page.html_url:
        return "html", page.html_url
    if page.pdf_url:
        return "pdf", page.pdf_url
    return None


# --- edition dates ---------------------------------------------------------

@dataclass(frozen=True)
class EditionRecord:
    version_no: str
    publication_date: datetime.date | None
    withdrawal_date: datetime.date | None
    enactment_date: datetime.date | None
    entry_into_force: datetime.date | None


def edition_dates(records: list[EditionRecord]
                  ) -> list[tuple[str, datetime.date, datetime.date | None]]:
    """(version_no, date_applicability, date_end_applicability) per edition,
    Nachtrag order. Start: Publikationsdatum; without one, the day after
    the predecessor's Aufhebungsdatum; for the first edition, the
    Inkraftsetzungsdatum or the Erlassdatum. End: the day before the
    successor's start (an edition replaced the same day ends the day
    before it started -- 101/125 -- and is never in force, the corpus
    rule for same-day versions); the last edition is open unless it has
    an Aufhebungsdatum, in which case a first-of-month value is the day
    the repeal took effect (131.1/095: 01.01.2018) and any other day is
    the last day in force (410.1/059: 31.12.2007). An edition whose
    start cannot be derived raises: a guessed date on a point-in-time
    corpus is worse than a reported gap."""
    ordered = sorted(records, key=lambda r: version_key(r.version_no))
    starts: list[datetime.date] = []
    for index, rec in enumerate(ordered):
        start = rec.publication_date
        if start is None and index > 0:
            previous = ordered[index - 1]
            if previous.withdrawal_date is not None:
                start = previous.withdrawal_date + datetime.timedelta(days=1)
        if start is None and index == 0:
            start = rec.entry_into_force or rec.enactment_date
        if start is None:
            raise ZhlexParseError(f"edition {rec.version_no}: no start date derivable")
        starts.append(start)
    out = []
    for index, rec in enumerate(ordered):
        start = starts[index]
        if index + 1 < len(ordered):
            successor = starts[index + 1]
            end = (successor if successor > start else start) - datetime.timedelta(days=1)
        elif rec.withdrawal_date is not None:
            end = rec.withdrawal_date
            if end.day == 1:
                end -= datetime.timedelta(days=1)
        else:
            end = None
        out.append((rec.version_no, start, end))
    return out


# --- Domino HTML text (WebRT) ---------------------------------------------

_ARTICLE_START = re.compile(r"^(§|Art\.)\s*(\d+)\s*([a-z]{1,4}(?![a-zäöü]))?\.?(?=\s|$)")
_FOOTNOTE_MARK = re.compile(r"^\s*FN\s*\d+\s*$")
_FOOTNOTE_LINE = re.compile(r"^\s*FN\s*\d+\b")
_SEPARATOR = re.compile(r"^\s*_{3,}\s*$")
_BREAK_TAGS = {"p", "br", "ul", "li", "div", "table", "tr", "h1", "h2", "h3", "hr", "form"}


def _lines(root) -> list[list[tuple[str, bool, bool]]]:
    """Text of the document as lines of (segment, blue, bold): a Domino
    page is a flat run of <font> elements separated by <p> and <br>, so
    the tag stream, not the tree, is what carries the line structure.
    Blue (#0000FF) is the collection's colour for headings and footnotes;
    bold is the colour of titles."""
    lines: list[list[tuple[str, bool, bool]]] = []
    current: list[tuple[str, bool, bool]] = []

    def flush():
        nonlocal current
        if any(seg.strip() for seg, _, _ in current):
            lines.append(current)
        current = []

    def walk(el, blue: bool, bold: bool):
        tag = el.tag if isinstance(el.tag, str) else ""
        if tag in ("script", "style", "head"):
            return
        if tag in _BREAK_TAGS:
            flush()
        if tag == "font" and (el.get("color") or "").upper() == "#0000FF":
            blue = True
        if tag in ("b", "strong"):
            bold = True
        if el.text:
            current.append((el.text, blue, bold))
        for child in el:
            walk(child, blue, bold)
            if child.tail:
                current.append((child.tail, blue, bold))
        if tag in _BREAK_TAGS:
            flush()

    walk(root, False, False)
    flush()
    return lines


def _line_text(segments) -> str:
    return _WS.sub(" ", "".join(seg for seg, _, _ in segments).replace("\xa0", " ")).strip()


def _body_text(segments) -> str:
    """The line without its inline footnote markers (' FN2' in blue)."""
    return _WS.sub(" ", "".join(seg for seg, blue, _ in segments
                                if not (blue and _FOOTNOTE_MARK.match(seg))).replace("\xa0", " ")).strip()


def parse_webrt(payload: bytes, content_type: str | None = None
                ) -> tuple[list[akn.Article], str]:
    """Domino rendering -> (articles, full text). An article starts at a
    line beginning '§ 7.' / '§ 12 a.' / 'Art. 3.'; blue lines before it
    are its marginal note (the collection's section headings); the
    footnote block a page ends with (a line of underscores, then blue
    'OS 33, 339 ...' and 'FN1 ...' lines) is kept out of the article text
    and attached as notes to the article in progress, the way akn.Article
    keeps Fedlex's authorialNotes. Inline 'FN2' markers are dropped from
    article text so a renumbered footnote is not a changed provision.
    Raises when no article is found: a login page, an error page or a
    document that is not numbered law text must fail visibly."""
    text = text_extract.decode_html(payload, content_type)
    root = lxml_html.fromstring(text)
    body = root.find("body")
    lines = _lines(body if body is not None else root)

    articles: list[akn.Article] = []
    full: list[str] = []
    current: dict | None = None
    pending_heading: list[str] = []
    in_notes = False
    seen: set[str] = set()

    def close():
        nonlocal current
        if current is None:
            return
        articles.append(akn.Article(
            e_id=current["e_id"], article_number=current["number"],
            marginal_note=current["heading"], text="\n".join(current["text"]).strip(),
            ordinal=len(articles), parent_e_id=None, notes=tuple(current["notes"])))
        current = None

    for segments in lines:
        raw = _line_text(segments)
        if not raw:
            continue
        if _SEPARATOR.match(raw):
            in_notes = True
            continue
        all_blue = all(blue for seg, blue, _ in segments if seg.strip())
        all_bold = all(bold for seg, _, bold in segments if seg.strip())
        if in_notes and (all_blue or _FOOTNOTE_LINE.match(raw)):
            full.append(raw)
            if current is not None:
                current["notes"].append(raw)
            continue
        in_notes = False
        body_line = _body_text(segments)
        m = _ARTICLE_START.match(body_line)
        if m:
            close()
            number = m.group(2) + (m.group(3) or "")
            e_id = ("par_" if m.group(1) == "§" else "art_") + number
            if e_id in seen:
                e_id = f"{e_id}-{len(articles)}"
            seen.add(e_id)
            current = {"e_id": e_id, "number": number, "text": [body_line], "notes": [],
                       "heading": " ".join(pending_heading) or None}
            pending_heading = []
            full.append(body_line)
            continue
        if all_blue or all_bold:
            if all_blue and _FOOTNOTE_LINE.match(raw):
                full.append(raw)
                if current is not None:
                    current["notes"].append(raw)
                continue
            close()
            pending_heading.append(body_line)
            full.append(body_line)
            continue
        full.append(body_line)
        if current is not None:
            current["text"].append(body_line)
    close()
    if not articles:
        raise ZhlexParseError("no numbered provisions (§ / Art.) in the document")
    return articles, "\n".join(full)


# --- client ----------------------------------------------------------------

class ZhlexClient:
    """Fetcher wrapper that keeps the whole process under `rate` requests
    per second to zh.ch and notes.zh.ch together (2/s by agreement), on
    top of the Fetcher's concurrency cap."""

    def __init__(self, fetcher: Fetcher, rate: float = 2.0):
        self._fetcher = fetcher
        self._interval = 1.0 / rate if rate > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def _pace(self) -> None:
        if not self._interval:
            return
        async with self._lock:
            now = time.monotonic()
            wait = self._next - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._next = now + self._interval

    async def index(self, enactment_from: datetime.date, enactment_to: datetime.date,
                    page: int = 1, file_number: int | None = None) -> IndexPage:
        await self._pace()
        return parse_index_page(
            await self._fetcher.json(index_url(enactment_from, enactment_to, page, file_number)))

    async def act_page(self, url: str) -> ActPage:
        await self._pace()
        body, content_type = await self._fetcher.body(url)
        return parse_act_page(body, content_type)

    async def body(self, url: str) -> tuple[bytes, str | None]:
        await self._pace()
        return await self._fetcher.body(url)


@dataclass
class WalkReport:
    requests: int = 0
    slices: int = 0
    # A one-day, one-chapter slice still over the 150 cap: rows past the
    # cap are unreachable through the index. Zero on the whole collection
    # (2026-08-27); a non-zero count names a day to look at by hand.
    capped_slices: list[str] = field(default_factory=list)
    links_unparsed: list[str] = field(default_factory=list)


async def walk_index(client: ZhlexClient, since: datetime.date, until: datetime.date,
                     report: WalkReport, file_number: int | None = None) -> list[IndexStub]:
    """Every edition row of the collection enacted in [since, until], by
    bisecting the enactment-date range until no slice is over the cap.
    ~5,100 rows / 15 per page plus the probes: about 400 requests."""
    first = await client.index(since, until, 1, file_number)
    report.requests += 1
    if first.capped:
        if since < until:
            middle = since + (until - since) // 2
            left = await walk_index(client, since, middle, report, file_number)
            right = await walk_index(client, middle + datetime.timedelta(days=1), until, report, file_number)
            return left + right
        if file_number is None:
            out: list[IndexStub] = []
            for chapter in FILE_NUMBERS:
                out += await walk_index(client, since, until, report, chapter)
            return out
        report.capped_slices.append(f"{since.isoformat()} fileNumber={file_number}")
    report.slices += 1
    stubs = list(first.stubs)
    report.links_unparsed += first.unparsed
    for page in range(2, first.number_of_pages + 1):
        more = await client.index(since, until, page, file_number)
        report.requests += 1
        stubs += more.stubs
        report.links_unparsed += more.unparsed
    return stubs
