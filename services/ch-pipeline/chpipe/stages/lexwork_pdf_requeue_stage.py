"""Send the PDF-only Lexwork editions to the PDF text stage (LEXAI-2010).

cantonal_fetch_stage retired every version whose show_as_json payload had
no document tree with last_error 'pdf_only: ...' (18,777 rows on
2026-08-26, 670 in-force acts among them). This stage turns those rows
into pdf_text_stage's input: source 'lexwork_pdf', stage 'discovered',
xml_url = the host's PDF of that version in the row's language.

Where the URL comes from, and why no per-version request is made: the
act's tol record (`/api/{lang}/texts_of_law/{sysnr}`) lists every version
with only {id, structured_document_id, title, version_dates_str} -- NO
pdf_link_tol (checked 2026-08-27 on BE 436.811, FR 10.22, GR); the link
lives in the per-version show_as_json payload the fetch stage threw away
when it raised PdfOnly. The link's shape, however, is one convention on
every host: https://{host}/api/{lang}/versions/{id}/pdf_file -- read off
60 parsed versions' pdf_link_tol on 9 hosts, and confirmed live on 20
PDF-only rows across 7 hosts (BE de+fr, FR de+fr, GR de/it/rm, LU, OW,
SO, VS de+fr): 20/20 answered 200 application/pdf starting with %PDF-.
The language segment selects the language: BE 436.811 v780 is 217,991
bytes in German and 221,271 in French from the same version id.

The tol record is still fetched, once per act, for what it does say:
  * a version the host has SINCE given a structured document (the
    platform converts old editions over time) goes back to the HTML path
    (source 'lexwork', stage 'discovered', xml_url unchanged) -- the HTML
    parse is the better text and carries the modification table;
  * a version id the host no longer lists, or an act it answers 404 to,
    stays failed with a new reason ('pdf_only: version not listed by
    host' / 'pdf_only: act not on host') so the row is never requeued
    blindly.

CHPIPE_CURRENT_ONLY=1 restricts the run to editions with
date_end_applicability IS NULL: the 670 in-force acts first, because
their current text is what the point-in-time tools answer with today.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass

from psycopg.rows import dict_row

from .. import cantons, db, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..lexwork_api import LexworkClient
from . import cantonal_fetch_stage

log = logging.getLogger(__name__)

_VERSION_URL = re.compile(
    r"^https://([^/]+)/api/[a-z]{2}/texts_of_law/([^/]+)/versions/(\d+)/show_as_json$")
_BY_HOST = {c.host: c for c in cantons.LEXWORK.values()}


@dataclass
class RequeueReport:
    requeued_pdf: int = 0
    # the host has given the version a structured document since: HTML path
    requeued_html: int = 0
    not_listed: int = 0
    act_not_on_host: int = 0
    unknown_url: int = 0
    tol_failed: int = 0
    acts_fetched: int = 0


def pdf_url(host: str, lang: str, version_id: int) -> str:
    return f"https://{host}/api/{lang}/versions/{version_id}/pdf_file"


_SELECT = (
    "SELECT version_id, lang, xml_url, date_end_applicability FROM ch_act_version "
    "WHERE source = 'lexwork' AND stage = 'failed' AND last_error LIKE 'pdf_only%%'")
_REQUEUE_PDF = (
    "UPDATE ch_act_version SET source = 'lexwork_pdf', stage = 'discovered', attempts = 0, "
    "last_error = NULL, failed_stage = NULL, xml_url = %s, stage_updated_at = now(), "
    "updated_at = now() WHERE version_id = %s")
_REQUEUE_HTML = (
    "UPDATE ch_act_version SET stage = 'discovered', attempts = 0, last_error = NULL, "
    "failed_stage = NULL, stage_updated_at = now(), updated_at = now() WHERE version_id = %s")
_STAY_FAILED = (
    "UPDATE ch_act_version SET last_error = %s, stage_updated_at = now(), updated_at = now() "
    "WHERE version_id = %s")


def select_rows(conn, prefix: str | None, current_only: bool, limit: int | None) -> list[dict]:
    sql = _SELECT
    params: list = []
    if prefix:
        sql += " AND xml_url LIKE %s"
        params.append(prefix.replace("%", "\\%").replace("_", "\\_") + "%")
    if current_only:
        sql += " AND date_end_applicability IS NULL"
    sql += " ORDER BY xml_url, lang"
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def versions_of(tol: dict) -> dict[int, int | None]:
    """version id -> structured_document_id (None = PDF only) for every
    version the tol record lists: current, old and future."""
    listed = [tol.get("current_version")] + list(tol.get("old_versions") or []) \
        + list(tol.get("future_versions") or [])
    return {int(v["id"]): v.get("structured_document_id") for v in listed if v and v.get("id") is not None}


async def _act(client: LexworkClient, conn, canton: cantons.Canton, sysnr: str,
               rows: list[dict], report: RequeueReport) -> None:
    try:
        tol = await client.text_of_law(canton, sysnr)
    except FetchError as exc:
        log.warning("%s %s: tol fetch failed: %s", canton.code, sysnr, exc)
        report.tol_failed += len(rows)
        return
    report.acts_fetched += 1
    if tol is None:
        for row in rows:
            conn.execute(_STAY_FAILED, ("pdf_only: act not on host", row["version_id"]))
        report.act_not_on_host += len(rows)
        return
    listed = versions_of(tol)
    for row in rows:
        version_id = int(_VERSION_URL.match(row["xml_url"]).group(3))
        if version_id not in listed:
            conn.execute(_STAY_FAILED, ("pdf_only: version not listed by host", row["version_id"]))
            report.not_listed += 1
        elif listed[version_id] is not None:
            conn.execute(_REQUEUE_HTML, (row["version_id"],))
            report.requeued_html += 1
        else:
            conn.execute(_REQUEUE_PDF, (pdf_url(canton.host, row["lang"], version_id),
                                        row["version_id"]))
            report.requeued_pdf += 1


async def _run_async(settings: Settings, canton_code: str | None, current_only: bool,
                     limit: int | None, transport) -> RequeueReport:
    report = RequeueReport()
    prefix = cantonal_fetch_stage.url_prefix(canton_code)
    conn = db.connect(settings)
    try:
        rows = select_rows(conn, prefix, current_only, limit)
        groups: dict[tuple[str, str], list[dict]] = {}
        for row in rows:
            m = _VERSION_URL.match(row["xml_url"] or "")
            if not m or m.group(1) not in _BY_HOST:
                conn.execute(_STAY_FAILED, ("pdf_only: xml_url is not a Lexwork version URL",
                                            row["version_id"]))
                report.unknown_url += 1
                continue
            groups.setdefault((m.group(1), m.group(2)), []).append(row)
        log.info("%d pdf_only rows over %d acts", len(rows), len(groups))
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            client = LexworkClient(fetcher, per_host=settings.cantonal_per_host)
            await asyncio.gather(*(
                _act(client, conn, _BY_HOST[host], sysnr, group, report)
                for (host, sysnr), group in groups.items()))
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None, current_only: bool = False,
        limit: int | None = None, transport=None) -> RequeueReport:
    return asyncio.run(_run_async(settings, canton_code, current_only, limit, transport))


def main() -> RequeueReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: one tol request per act."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 current_only=os.environ.get("CHPIPE_CURRENT_ONLY", "") not in ("", "0"),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("requeued_pdf=%d requeued_html=%d not_listed=%d act_not_on_host=%d "
             "unknown_url=%d tol_failed=%d acts=%d", result.requeued_pdf, result.requeued_html,
             result.not_listed, result.act_not_on_host, result.unknown_url, result.tol_failed,
             result.acts_fetched)
    return result


if __name__ == "__main__":
    main()
