"""PDF editions -> articles + text: fetch and extract in one stage, over
the ch_act_version queue rows whose source is 'lexwork_pdf' (a Lexwork
host's own PDF of an edition it holds without a structured document,
LEXAI-2010: 18,777 rows, 670 in-force acts) or 'lexfind' (lexfind.ch's
PDF, LEXAI-2016/2017: ~55K rows for the seven cantons without a host).

One stage, not the fetch/parse pair the HTML path uses, because the split
buys nothing here: the HTML fetch stage's reason to exist is the sibling-
language cache (one payload, three languages), and a PDF is one language.
What the pair guarantees -- re-parse offline after a parser change -- is
kept another way: the raw pdftotext -layout output goes into akn_xml, and
pdf_text.split_text(akn_xml) reproduces the articles without the file.
The PDF itself is kept under raw_dir/pdf/{version_id}.pdf for the day the
extractor (not just the splitter) changes.

Per claimed row:
  1. GET xml_url through a per-host pacer (settings.cantonal_per_host in
     flight, settings.pdf_rps request starts per second: the hosts are
     small government servers and lexfind.ch is one server for all of
     them); the body must start with %PDF- -- a login page or an HTML
     error stored as an edition is the defect this pipeline was built to
     repair, so the check is on the bytes, not the Content-Type header.
  2. pdf_text.extract -> articles + full_text. Fewer than MIN_TEXT_CHARS
     characters retires the row at once ('text too short'): SO 111.21 is
     "Standeswappen: geteilt von Rot und Silber" and will not grow. Zero
     articles with real text is NOT a failure: 3 of the 20 PDF-only
     editions measured on 2026-08-27 are article-less acts (a coat of
     arms decision, an accession to a concordat), the same shape
     cantonal_parse_stage counts as `empty` for HTML editions.
  3. store_articles + complete_version(-> 'parsed', akn_xml=raw text,
     full_text) in the same transaction shape as cantonal_parse_stage.

CHPIPE_RESPLIT=1 runs the other half only: no download, no claim -- it
takes the rows already at 'parsed' with article_count = 0 (the first prod
pass left 389 of 692 there: decisions in numbered clauses, lists, tariffs,
and three heading shapes the splitter did not know), re-runs
pdf_text.split_text over their akn_xml and rewrites articles + full_text
for the ones that now split. Rows that still yield no article are left
as they are (their text is right; they have no articles).

CHPIPE_ANNEX=1 is the third mode (LEXAI gap K7): the BS editions whose
whole body is "siehe Anhang" plus a PDF annex (empty_reason 'annex_only',
82 editions on 2026-08-26, 85 on 2026-08-31 -- BS only). Their payload is
stored verbatim in akn_xml by cantonal-parse, and names the annex PDF once
per version: selected_version.pdf_link_annexes =
https://{host}/api/{lang}/versions/{id}/annexes (one bundle of all the
version's annexes; every non-null annex_documents[].url repeats it,
verified on all 85). The mode re-reads every parsed 'lexwork' row with
article_count = 0, recomputes the annex signal from the payload
(lexwork.annex_pdf_url -- the same structural check empty_reason makes),
downloads the bundle, extracts with the same pdf_text machinery, and
APPENDS the text to full_text after the ANNEX_MARKER line, keeping the
header text cantonal-parse stored; when the annex splits into articles
they are stored too. A mode of this stage, not a new stage, because it
shares everything that matters here -- HostPacer, the %PDF check,
MAX_PDF_BYTES, extract, store_articles/complete_version -- and, like
CHPIPE_RESPLIT, walks parsed rows outside the claim queue, so run-stage.sh
needs no new entry. Idempotent by construction: a row leaves the selection
either by gaining articles or by carrying the marker; a failed row is left
untouched (never re-failed: it IS parsed) and is selected again next run.
The PDF is kept under raw_dir/pdf/{version_id}-annex.pdf; akn_xml keeps
the payload, so the annex text is NOT re-splittable offline -- the file is.

Before the first claim the stage retires 'shadow' rows -- LexFind lists
a same-day replaced edition with date_end_applicability one day BEFORE
date_applicability (~12.5K of the 55K) -- with last_error 'shadow_edition'
in one UPDATE, so they are never claimed and never downloaded. One
statement per run is cheaper than a predicate on every claim, and the
reason is recorded where failed_by_stage_versions() reports it.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from psycopg.rows import dict_row, tuple_row

from .. import db, lexwork, pdf_text, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..text_extract import PdfToolMissing
from . import cantonal_fetch_stage, parse_akn_stage

log = logging.getLogger(__name__)

SOURCES = ("lexwork_pdf", "lexfind")
# Zürich's PDF editions (zh_acts_stage: source 'zhlex', xml_url on notes.zh.ch)
# share this path, but only on request: `CHPIPE_SOURCE=zhlex` claims the
# OpenAttachment rows alone, so the HTML editions zh-fetch owns (WebRT/) and
# the 541 editions without a text link are never claimed here. The default
# run (CHPIPE_SOURCE unset) stays on the two PDF-only sources.
ZHLEX_SOURCE = "zhlex"
ZHLEX_PDF_PREFIX = "https://www.notes.zh.ch/appl/zhlex_r.nsf/WebView/"
# BE 661.11 (the tax law, 129 pages) is 844 KB; the BE constitution with
# annexes ~1 MB. Anything past this is not an edition.
MAX_PDF_BYTES = 60_000_000
MIN_TEXT_CHARS = 200
# Appended once between the header text and the annex text; its absence is
# the idempotency predicate for the annex mode's article-less outcomes.
ANNEX_MARKER = "[Anhang (PDF)]"


@dataclass
class PdfTextReport:
    parsed: int = 0
    articles: int = 0
    empty: int = 0           # parsed, 0 articles (article-less acts)
    failed: int = 0
    not_pdf: int = 0
    too_short: int = 0
    shadows_retired: int = 0
    bytes_written: int = 0
    # resplit mode: rows re-read from akn_xml, and how many now have articles
    resplit: int = 0
    recovered: int = 0
    # annex mode (CHPIPE_ANNEX=1): article-less parsed lexwork rows read,
    # split by outcome; annex_skipped = no annex in the payload (the row is
    # empty for another reason), annex_failed = fetch/extract trouble, row
    # left untouched and selected again next run
    annex_scanned: int = 0
    annex_skipped: int = 0
    annex_parsed: int = 0
    annex_no_articles: int = 0
    annex_failed: int = 0


def pdf_path(settings: Settings, version_id: int):
    return settings.raw_dir / "pdf" / f"{version_id}.pdf"


def annex_pdf_path(settings: Settings, version_id: int):
    """The annex bundle's audit copy. '-annex' keeps it apart from the same
    row's own edition PDF name, should the row ever take the lexwork_pdf
    path too."""
    return settings.raw_dir / "pdf" / f"{version_id}-annex.pdf"


def is_pdf(body: bytes) -> bool:
    return body[:5] == b"%PDF-"


_RETIRE_SHADOWS = (
    "UPDATE ch_act_version SET stage = 'failed', failed_stage = 'discovered', "
    "last_error = 'shadow_edition', stage_updated_at = now(), updated_at = now() "
    "WHERE source = ANY(%s) AND stage = 'discovered' "
    "AND date_end_applicability < date_applicability")


def retire_shadows(conn, sources: tuple[str, ...] = SOURCES) -> int:
    return conn.execute(_RETIRE_SHADOWS, (list(sources),)).rowcount


class HostPacer:
    """At most `per_host` requests in flight per host AND at most `rps`
    request starts per second per host. The semaphore alone is not a rate:
    a 200 KB PDF answers in ~100 ms, so two in flight would be ~20/s."""

    def __init__(self, per_host: int, rps: float):
        if per_host < 1:
            raise ValueError(f"per_host must be at least 1, got {per_host}")
        self._per_host = per_host
        self._interval = 1.0 / rps if rps > 0 else 0.0
        self._sems: dict[str, asyncio.Semaphore] = {}
        self._next: dict[str, float] = {}

    @contextlib.asynccontextmanager
    async def slot(self, host: str):
        sem = self._sems.setdefault(host, asyncio.Semaphore(self._per_host))
        async with sem:
            loop = asyncio.get_running_loop()
            now = loop.time()
            start = max(now, self._next.get(host, now))
            self._next[host] = start + self._interval
            if start > now:
                await asyncio.sleep(start - now)
            yield


def sources_from_env(raw: str | None) -> tuple[str, ...]:
    """CHPIPE_SOURCE narrows the run to one of the two PDF sources; unset
    means both. Anything else is a hard error, not a silent empty run."""
    if not raw:
        return SOURCES
    picked = tuple(s.strip() for s in raw.split(",") if s.strip())
    allowed = SOURCES + (ZHLEX_SOURCE,)
    unknown = [s for s in picked if s not in allowed]
    if unknown:
        raise ValueError(f"CHPIPE_SOURCE must be one of {', '.join(allowed)}; got {raw!r}")
    if ZHLEX_SOURCE in picked and len(picked) > 1:
        raise ValueError("CHPIPE_SOURCE=zhlex runs alone: its rows are selected by URL prefix")
    return picked


def claim_prefix(sources: tuple[str, ...], canton_code: str | None) -> str | None:
    """The xml_url prefix the claim is narrowed to: a canton's host for the
    Lexwork sources, the notes.zh.ch attachment path for zhlex."""
    if sources == (ZHLEX_SOURCE,):
        return ZHLEX_PDF_PREFIX
    return cantonal_fetch_stage.url_prefix(canton_code)


async def _process(row: dict, conn, fetcher: Fetcher, pacer: HostPacer, cpu: asyncio.Semaphore,
                   settings: Settings, report: PdfTextReport) -> None:
    version_id = row["version_id"]
    url = row["xml_url"]

    def fail(reason: str, max_attempts: int | None = None) -> None:
        db.fail_version(conn, version_id, reason,
                        settings.max_attempts if max_attempts is None else max_attempts)
        report.failed += 1

    try:
        if not url:
            fail("no xml_url", max_attempts=1)
            return
        host = urlsplit(url).hostname or ""
        try:
            async with pacer.slot(host):
                body, content_type = await fetcher.body(url)
        except FetchError as exc:
            log.warning("version %s: fetch failed: %s", version_id, exc)
            fail(str(exc))
            return
        if len(body) > MAX_PDF_BYTES:
            fail(f"PDF is {len(body)} bytes", max_attempts=1)
            return
        if not is_pdf(body):
            report.not_pdf += 1
            fail(f"not a PDF ({content_type or 'no content-type'}, {len(body)} bytes)")
            return
        path = pdf_path(settings, version_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        report.bytes_written += len(body)
        try:
            async with cpu:
                extraction = await asyncio.to_thread(pdf_text.extract, path)
        except pdf_text.PdfTextError as exc:
            fail(f"pdftotext: {exc}")
            return
        if len(extraction.full_text) < MIN_TEXT_CHARS:
            report.too_short += 1
            fail(f"text too short ({len(extraction.full_text)} chars, "
                 f"{extraction.raw_text.count(chr(12)) or 1} pages)", max_attempts=1)
            return
        with conn.transaction():
            parse_akn_stage.store_articles(conn, version_id, extraction.articles)
        db.complete_version(conn, version_id, "parsed",
                            akn_xml=extraction.raw_text,
                            fetched_at=datetime.now(timezone.utc),
                            full_text=extraction.full_text)
        report.parsed += 1
        report.articles += len(extraction.articles)
        if not extraction.articles:
            report.empty += 1
    except PdfToolMissing:
        raise
    except Exception as exc:                                    # noqa: BLE001
        log.error("version %s: %s", version_id, exc)
        try:
            fail(str(exc))
        except Exception as fail_exc:
            log.error("version %s: also failed recording the failure: %s", version_id, fail_exc)


_ANNEX_ROWS = (
    "SELECT version_id, akn_xml, full_text FROM ch_act_version "
    "WHERE source = 'lexwork' AND stage = 'parsed' AND article_count = 0 "
    "AND akn_xml IS NOT NULL AND (full_text IS NULL OR strpos(full_text, %s) = 0)")


async def _annex_one(row: dict, conn, fetcher: Fetcher, pacer: HostPacer,
                     settings: Settings, report: PdfTextReport) -> None:
    version_id = row["version_id"]

    def failed(reason: str) -> None:
        # The row is a legitimately parsed edition: never fail_version() it,
        # count and log instead; without the marker it is selected again.
        log.warning("version %s: annex: %s", version_id, reason)
        report.annex_failed += 1

    try:
        payload = json.loads(row["akn_xml"])
        url = lexwork.annex_pdf_url(payload)
    except (ValueError, lexwork.LexworkParseError) as exc:
        failed(f"payload unreadable: {exc}")
        return
    if url is None:                     # no annex: empty for another reason
        report.annex_skipped += 1
        return
    if not url:
        failed("annexes listed without a link")
        return
    host = urlsplit(url).hostname or ""
    try:
        async with pacer.slot(host):
            body, content_type = await fetcher.body(url)
    except FetchError as exc:
        failed(str(exc))
        return
    if len(body) > MAX_PDF_BYTES:
        failed(f"annex PDF is {len(body)} bytes")
        return
    if not is_pdf(body):
        failed(f"annex is not a PDF ({content_type or 'no content-type'}, {len(body)} bytes)")
        return
    path = annex_pdf_path(settings, version_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    report.bytes_written += len(body)
    try:
        extraction = await asyncio.to_thread(pdf_text.extract, path)
    except pdf_text.PdfTextError as exc:
        failed(f"pdftotext: {exc}")
        return
    if len(extraction.full_text) < MIN_TEXT_CHARS:
        failed(f"annex text too short ({len(extraction.full_text)} chars)")
        return
    full_text = ((row["full_text"] or "").rstrip()
                 + "\n\n" + ANNEX_MARKER + "\n" + extraction.full_text)
    if extraction.articles:
        with conn.transaction():
            parse_akn_stage.store_articles(conn, version_id, extraction.articles)
        report.annex_parsed += 1
        report.articles += len(extraction.articles)
    else:
        report.annex_no_articles += 1
    db.complete_version(conn, version_id, "parsed", full_text=full_text)


async def _annex_async(settings: Settings, canton_code: str | None,
                       limit: int | None, transport) -> PdfTextReport:
    report = PdfTextReport()
    prefix = cantonal_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    try:
        sql, params = _ANNEX_ROWS, [ANNEX_MARKER]
        if prefix:
            sql += " AND xml_url LIKE %s"
            params.append(prefix.replace("%", "\\%").replace("_", "\\_") + "%")
        sql += " ORDER BY version_id"
        if limit is not None:
            sql += " LIMIT %s"
            params.append(limit)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        pacer = HostPacer(settings.cantonal_per_host, settings.pdf_rps)
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            for row in rows:            # 85 rows on one host: sequential is fine
                report.annex_scanned += 1
                await _annex_one(row, conn, fetcher, pacer, settings, report)
        log.info("annex scanned=%d parsed=%d no_articles=%d skipped=%d failed=%d "
                 "articles=%d bytes=%d", report.annex_scanned, report.annex_parsed,
                 report.annex_no_articles, report.annex_skipped, report.annex_failed,
                 report.articles, report.bytes_written)
    finally:
        conn.close()
    return report


def annex_text(settings: Settings, canton_code: str | None = None,
               limit: int | None = None, transport=None) -> PdfTextReport:
    """CHPIPE_ANNEX=1: append the annex bundle's text (and articles, when it
    splits) to the article-less parsed lexwork editions whose payload lists
    annex documents. See the module docstring."""
    return asyncio.run(_annex_async(settings, canton_code, limit, transport))


_RESPLIT_ROWS = (
    "SELECT version_id, akn_xml FROM ch_act_version "
    "WHERE source = ANY(%s) AND stage = 'parsed' AND article_count = 0 AND akn_xml IS NOT NULL")


def resplit(settings: Settings, canton_code: str | None = None,
            sources: tuple[str, ...] = SOURCES, limit: int | None = None) -> PdfTextReport:
    """Re-split the article-less parsed editions from their stored
    pdftotext output. Reads one row at a time (a 147 KB tariff is the
    largest seen; no need to hold the set) and writes only the rows that
    gained articles, in the same transaction shape as the fetch path."""
    report = PdfTextReport()
    prefix = cantonal_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    try:
        sql, params = _RESPLIT_ROWS, [list(sources)]
        if prefix:
            sql += " AND xml_url LIKE %s"
            params.append(prefix.replace("%", "\\%").replace("_", "\\_") + "%")
        sql += " ORDER BY version_id"
        if limit is not None:
            sql += " LIMIT %s"
            params.append(limit)
        # db.connect() hands out dict rows; a bare tuple unpack over those
        # yields the column NAMES and split_text("akn_xml") splits nothing
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        for version_id, raw in rows:
            report.resplit += 1
            try:
                articles, full_text = pdf_text.split_text(raw)
            except Exception as exc:                            # noqa: BLE001
                log.error("version %s: resplit failed: %s", version_id, exc)
                report.failed += 1
                continue
            if not articles:
                continue
            with conn.transaction():
                parse_akn_stage.store_articles(conn, version_id, articles)
            db.complete_version(conn, version_id, "parsed", full_text=full_text)
            report.recovered += 1
            report.articles += len(articles)
        log.info("resplit=%d recovered=%d articles=%d failed=%d",
                 report.resplit, report.recovered, report.articles, report.failed)
    finally:
        conn.close()
    return report


async def _run_async(settings: Settings, canton_code: str | None, sources: tuple[str, ...],
                     limit: int | None, transport) -> PdfTextReport:
    report = PdfTextReport()
    prefix = claim_prefix(sources, canton_code)
    conn = db.connect(settings)
    remaining = limit
    try:
        report.shadows_retired = retire_shadows(conn, sources)
        if report.shadows_retired:
            log.info("retired %d shadow editions (date_end before date_applicability)",
                     report.shadows_retired)
        pacer = HostPacer(settings.cantonal_per_host, settings.pdf_rps)
        cpu = asyncio.Semaphore(max(1, settings.cpu_workers))
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            while True:
                size = 100 if remaining is None else min(100, remaining)
                if size <= 0:
                    break
                throttle.wait_for_capacity(settings.load_ceiling, "pdf-text")
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source=sources, url_prefix=prefix)
                if not rows:
                    break
                await asyncio.gather(*(_process(r, conn, fetcher, pacer, cpu, settings, report)
                                       for r in rows))
                if remaining is not None:
                    remaining -= len(rows)
                log.info("pdf-text parsed=%d articles=%d empty=%d failed=%d not_pdf=%d "
                         "too_short=%d bytes=%d", report.parsed, report.articles, report.empty,
                         report.failed, report.not_pdf, report.too_short, report.bytes_written)
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None,
        sources: tuple[str, ...] = SOURCES, limit: int | None = None,
        transport=None) -> PdfTextReport:
    return asyncio.run(_run_async(settings, canton_code, sources, limit, transport))


def main() -> PdfTextReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: network-bound with a pdftotext
    subprocess per edition, bounded by CHPIPE_CPU_WORKERS."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    limit = int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None
    if os.environ.get("CHPIPE_ANNEX", "") not in ("", "0"):
        result = annex_text(Settings.from_env(),
                            canton_code=os.environ.get("CHPIPE_CANTON") or None, limit=limit)
        log.info("ANNEX scanned=%d parsed=%d no_articles=%d skipped=%d failed=%d articles=%d",
                 result.annex_scanned, result.annex_parsed, result.annex_no_articles,
                 result.annex_skipped, result.annex_failed, result.articles)
        return result
    if os.environ.get("CHPIPE_RESPLIT", "") not in ("", "0"):
        result = resplit(Settings.from_env(),
                         canton_code=os.environ.get("CHPIPE_CANTON") or None,
                         sources=sources_from_env(os.environ.get("CHPIPE_SOURCE")), limit=limit)
        log.info("RESPLIT resplit=%d recovered=%d articles=%d failed=%d",
                 result.resplit, result.recovered, result.articles, result.failed)
        return result
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 sources=sources_from_env(os.environ.get("CHPIPE_SOURCE")), limit=limit)
    log.info("parsed=%d articles=%d empty=%d failed=%d not_pdf=%d too_short=%d "
             "shadows_retired=%d bytes=%d", result.parsed, result.articles, result.empty,
             result.failed, result.not_pdf, result.too_short, result.shadows_retired,
             result.bytes_written)
    return result


if __name__ == "__main__":
    main()
