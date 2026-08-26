"""Discovery of Zürich's acts and editions from ZH-Lex (zh.ch) -- the ZH
twin of cantonal_acts_stage, for a canton whose collection is not on a
Lexwork host (see chpipe/zhlex.py for the site's shape).

Driving set: every edition row the index yields for
includeRepealedEnactments=true, enumerated by bisecting the
enactment-date range under the 150-row cap (~400 requests). The rows are
grouped by Ordnungsnummer; the number is the act (one Nachtrag series per
number across re-enactments, 101 and 131.6 being the proof), so an act
comes out in force when any of its rows has no withdrawalDate. Measured
2026-08-27: 944 such numbers, LexFind's active count to the unit.

Per act, every edition page is fetched (~5,100 pages for the whole
collection, 2 req/s: about 45 minutes) for the three things the index
does not carry: the Publikationsdatum (the edition's start), the
Inkraftsetzungsdatum, and the text link on notes.zh.ch. Then
zhlex.edition_dates() derives (start, inclusive end) per edition and one
ch_act_version row per edition is upserted at stage 'discovered', source
'zhlex', lang 'de', with xml_url = the text link: a Domino HTML rendering
(WebRT/...) that zh_fetch_stage + zh_parse_stage read here, or a PDF
(OpenAttachment...) left to the shared PDF path. An edition whose page
did not answer is dropped from the pass and counted (pages_failed) --
its neighbours' dates come from their own pages, so the rest of the act
is still right -- and a rerun picks it up; an act whose dates cannot be
derived at all is skipped and counted (dates_underivable), never
guessed.

Cross-checks kept as counters: the Historie list on the current
edition's page against the index's editions for the act
(historie_mismatch), and the LexFind registry number for
metadata_json.lexfind_tol_id.

Restartable and idempotent, not resumable: every write is an upsert and
a rerun redoes the pass; stage is never touched on conflict.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
from collections import defaultdict
from dataclasses import dataclass, field

from psycopg.rows import tuple_row

from .. import db, throttle, zhlex
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

JURISDICTION = "ZH"
_SAMPLE_CAP = 12
# Acts are walked a few at a time so page fetches pipeline behind the
# client's 2 req/s pacing without holding thousands of pages in memory.
_ACT_BATCH = 4


@dataclass
class ActsReport:
    acts: int = 0
    versions: int = 0
    editions_indexed: int = 0
    index_requests: int = 0
    capped_slices: list[str] = field(default_factory=list)
    pages_failed: int = 0
    pages_failed_samples: list[str] = field(default_factory=list)
    dates_underivable: int = 0
    dates_underivable_samples: list[str] = field(default_factory=list)
    historie_mismatch: int = 0
    historie_mismatch_samples: list[str] = field(default_factory=list)
    html_editions: int = 0
    pdf_editions: int = 0
    no_text: int = 0
    lexfind_matched: int = 0
    errors: int = 0


def _sample(bucket: list[str], value: str) -> None:
    if value not in bucket and len(bucket) < _SAMPLE_CAP:
        bucket.append(value)


_UPSERT_ACT = """
INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, abbreviation, title_de,
                    date_document, date_entry_force, date_no_longer_in_force,
                    enforcement_status, metadata_json, stage, updated_at)
VALUES (%(work)s, 'ZH', %(sr)s, %(abbreviation)s, %(title_de)s,
        %(date_document)s, %(date_entry_force)s, %(date_no_longer)s,
        %(status)s, %(metadata)s, 'discovered', now())
ON CONFLICT (eli_work_uri) DO UPDATE SET
    jurisdiction            = EXCLUDED.jurisdiction,
    sr_number               = EXCLUDED.sr_number,
    abbreviation            = COALESCE(EXCLUDED.abbreviation, ch_act.abbreviation),
    title_de                = COALESCE(EXCLUDED.title_de, ch_act.title_de),
    date_document           = COALESCE(EXCLUDED.date_document, ch_act.date_document),
    date_entry_force        = COALESCE(EXCLUDED.date_entry_force, ch_act.date_entry_force),
    date_no_longer_in_force = EXCLUDED.date_no_longer_in_force,
    enforcement_status      = EXCLUDED.enforcement_status,
    metadata_json           = EXCLUDED.metadata_json,
    updated_at              = now()
RETURNING act_id
"""

# Same contract as cantonal_acts_stage: the end date is always the newest
# observation (a superseded current edition GAINS an end), stage is never
# touched on conflict.
_UPSERT_VERSION = """
INSERT INTO ch_act_version
    (act_id, eli_consolidation_uri, lang, date_applicability,
     date_end_applicability, xml_url, source, stage, updated_at)
VALUES (%(act_id)s, %(consolidation)s, 'de', %(date_app)s, %(date_end)s,
        %(xml_url)s, 'zhlex', 'discovered', now())
ON CONFLICT (eli_consolidation_uri, lang) DO UPDATE SET
    date_applicability     = EXCLUDED.date_applicability,
    date_end_applicability = EXCLUDED.date_end_applicability,
    xml_url                = EXCLUDED.xml_url,
    updated_at             = now()
"""

_REGISTRY = ("SELECT systematic_number, lexfind_tol_id, is_active FROM ch_cantonal_registry "
             "WHERE canton = 'ZH' AND systematic_number IS NOT NULL "
             "ORDER BY is_active DESC NULLS LAST, lexfind_tol_id DESC")


def work_uri(sr_number: str) -> str:
    """The act's stable URL on the legacy host, as printed on every edition
    page under 'Link auf aktuelle Version'; used as ch_act.eli_work_uri."""
    return f"http://www.zhlex.zh.ch/Erlass.html?Open&Ordnr={sr_number}"


def consolidation_uri(sr_number: str, version_no: str) -> str:
    return f"zhlex:{sr_number}/{version_no}"


def registry_ids(conn) -> dict[str, int]:
    """Systematic number -> LexFind tol id, the active entry winning where
    LexFind holds two acts under one number (25 of ZH's numbers)."""
    out: dict[str, int] = {}
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_REGISTRY)
        for number, tol_id, _ in cur.fetchall():
            out.setdefault(number, tol_id)
    return out


def _edition_metadata(page: zhlex.ActPage, kind: str | None, url: str | None,
                      stub: zhlex.IndexStub) -> dict:
    return {
        "page": stub.page_url,
        "text": url,
        "kind": kind,
        "title": page.title,
        "enactment": page.enactment_date.isoformat() if page.enactment_date else None,
        "entry_into_force": page.entry_into_force.isoformat() if page.entry_into_force else None,
        "publication": page.publication_date.isoformat() if page.publication_date else None,
        "withdrawal": page.withdrawal_date.isoformat() if page.withdrawal_date else None,
    }


async def _walk_act(client: zhlex.ZhlexClient, conn, sr_number: str,
                    stubs: list[zhlex.IndexStub], lexfind: dict[str, int],
                    report: ActsReport) -> None:
    by_version = {s.version_no: s for s in stubs}
    pages: dict[str, zhlex.ActPage] = {}
    for version_no in sorted(by_version, key=int):
        stub = by_version[version_no]
        try:
            pages[version_no] = await client.act_page(stub.page_url)
        except (FetchError, zhlex.ZhlexParseError) as exc:
            report.pages_failed += 1
            _sample(report.pages_failed_samples, f"{sr_number}/{version_no}: {exc}")
    if not pages:
        return
    records = [zhlex.EditionRecord(no, p.publication_date, p.withdrawal_date,
                                   p.enactment_date, p.entry_into_force)
               for no, p in pages.items()]
    try:
        dates = zhlex.edition_dates(records)
    except zhlex.ZhlexParseError as exc:
        report.dates_underivable += 1
        _sample(report.dates_underivable_samples, f"{sr_number}: {exc}")
        return

    latest_no = max(pages, key=int)
    latest = pages[latest_no]
    current_stubs = [s for s in stubs if s.withdrawal_date is None]
    in_force = bool(current_stubs)
    listed = {v.version_no for v in latest.versions}
    indexed = set(by_version)
    if listed and listed != indexed:
        report.historie_mismatch += 1
        _sample(report.historie_mismatch_samples,
                f"{sr_number}: index {sorted(indexed - listed)} historie {sorted(listed - indexed)}")

    editions_meta: dict[str, dict] = {}
    texts: dict[str, tuple[str | None, str | None]] = {}
    for no, page in pages.items():
        found = zhlex.text_url(page)
        kind, url = found if found else (None, None)
        texts[no] = (kind, url)
        editions_meta[no] = _edition_metadata(page, kind, url, by_version[no])
        if kind == "html":
            report.html_editions += 1
        elif kind == "pdf":
            report.pdf_editions += 1
        else:
            report.no_text += 1
    tol_id = lexfind.get(sr_number)
    if tol_id is not None:
        report.lexfind_matched += 1
    metadata = {
        "platform": "zhlex",
        "url": latest.act_url or work_uri(sr_number),
        "page_url": by_version[latest_no].page_url,
        "current_version": latest_no if in_force else None,
        "volume": latest.volume,
        "notes": latest.notes,
        "lexfind_tol_id": tol_id,
        "editions": editions_meta,
    }
    first_no = min(pages, key=int)
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute(_UPSERT_ACT, {
            "work": work_uri(sr_number),
            "sr": sr_number,
            "abbreviation": latest.short_title,
            "title_de": latest.title,
            "date_document": pages[first_no].enactment_date,
            "date_entry_force": pages[first_no].entry_into_force or pages[first_no].enactment_date,
            "date_no_longer": None if in_force else latest.withdrawal_date,
            "status": 0 if in_force else 3,
            "metadata": json.dumps(metadata, ensure_ascii=False),
        })
        act_id = cur.fetchone()[0]
    for no, start, end in dates:
        conn.execute(_UPSERT_VERSION, {
            "act_id": act_id,
            "consolidation": consolidation_uri(sr_number, no),
            "date_app": start,
            "date_end": end,
            "xml_url": texts[no][1],
        })
        report.versions += 1
    report.acts += 1
    if report.acts % 50 == 0:
        log.info("acts=%d versions=%d pages_failed=%d html=%d pdf=%d no_text=%d",
                 report.acts, report.versions, report.pages_failed, report.html_editions,
                 report.pdf_editions, report.no_text)


async def _run_async(settings: Settings, only: set[str] | None, transport, rate: float
                     ) -> ActsReport:
    report = ActsReport()
    conn = db.connect(settings)
    try:
        async with Fetcher(concurrency=settings.cantonal_per_host, transport=transport) as fetcher:
            client = zhlex.ZhlexClient(fetcher, rate=rate)
            walk = zhlex.WalkReport()
            until = datetime.date.today() + datetime.timedelta(days=366)
            stubs = await zhlex.walk_index(client, zhlex.FIRST_ENACTMENT, until, walk)
            report.index_requests = walk.requests
            report.capped_slices = walk.capped_slices
            grouped: dict[str, dict[str, zhlex.IndexStub]] = defaultdict(dict)
            for stub in stubs:
                grouped[stub.sr_number][stub.version_no] = stub
            report.editions_indexed = sum(len(v) for v in grouped.values())
            log.info("index: %d editions of %d acts in %d requests, capped slices %s",
                     report.editions_indexed, len(grouped), walk.requests,
                     walk.capped_slices or "-")
            numbers = sorted(grouped)
            if only is not None:
                numbers = [n for n in numbers if n in only]
            lexfind = registry_ids(conn)

            async def one(number: str) -> None:
                try:
                    await _walk_act(client, conn, number, list(grouped[number].values()),
                                    lexfind, report)
                except Exception as exc:                      # noqa: BLE001
                    log.error("ZH %s: %s", number, exc)
                    report.errors += 1

            for start in range(0, len(numbers), _ACT_BATCH):
                await asyncio.gather(*(one(n) for n in numbers[start:start + _ACT_BATCH]))
    finally:
        conn.close()
    return report


def run(settings: Settings, only: set[str] | None = None, transport=None,
        rate: float = 2.0) -> ActsReport:
    """Walk every act of ZH-Lex, or only the Ordnungsnummern in `only`."""
    return asyncio.run(_run_async(settings, only, transport, rate))


def main() -> ActsReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: a network walk, same as
    cantonal-acts. CHPIPE_ZH_ONLY narrows to a comma-separated list of
    numbers (a pilot, a rerun for pages_failed samples)."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    only_env = os.environ.get("CHPIPE_ZH_ONLY")
    only = {s.strip() for s in only_env.split(",") if s.strip()} if only_env else None
    result = run(Settings.from_env(), only=only)
    log.info("acts=%d versions=%d editions_indexed=%d index_requests=%d pages_failed=%d "
             "dates_underivable=%d historie_mismatch=%d html=%d pdf=%d no_text=%d "
             "lexfind_matched=%d errors=%d", result.acts, result.versions,
             result.editions_indexed, result.index_requests, result.pages_failed,
             result.dates_underivable, result.historie_mismatch, result.html_editions,
             result.pdf_editions, result.no_text, result.lexfind_matched, result.errors)
    if result.capped_slices:
        log.warning("CAPPED SLICES: %s -- rows past the 150 cap were not enumerated",
                    ", ".join(result.capped_slices))
    if result.pages_failed:
        log.warning("PAGES FAILED: %d edition page(s) skipped; rerun for them. Sample: %s",
                    result.pages_failed, " || ".join(result.pages_failed_samples))
    if result.dates_underivable:
        log.warning("DATES UNDERIVABLE: %d act(s) skipped. Sample: %s",
                    result.dates_underivable, " || ".join(result.dates_underivable_samples))
    if result.historie_mismatch:
        log.warning("HISTORIE MISMATCH: %d act(s) whose page lists other editions than the "
                    "index. Sample: %s", result.historie_mismatch,
                    " || ".join(result.historie_mismatch_samples))
    return result


if __name__ == "__main__":
    main()
