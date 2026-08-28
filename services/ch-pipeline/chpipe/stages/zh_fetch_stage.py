"""Download the Domino HTML rendering of one ZH-Lex edition per discovered
row whose text link is a WebRT page -- the ZH twin of cantonal_fetch_stage
over the same ch_act_version queue, filtered to source='zhlex' AND the
notes.zh.ch WebRT prefix. Editions whose xml_url is a PDF
(OpenAttachment...) are never claimed here; they belong to the shared
PDF path (source 'zhlex' stays, the prefix tells the two apart).

What is stored: the page decoded at fetch time (the only moment the
Content-Type header exists; the pages declare ISO-8859-1) into akn_xml as
UTF-8 text, plus an audit copy on disk. What is checked before storing:
that zhlex.parse_webrt finds numbered provisions in it. A Domino error
page, a login form or an edition that is a table of fees with no § is
retired at once with reason 'no_provisions' (max_attempts=1): tomorrow's
download does not add a § to it, and hiding it as a retry would be the
same defect that once filled ch_legislation with CSS.

Measured 2026-08-27 on 101/000 and 131.1/004: 59 KB and 146 KB.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import db, text_extract, throttle, zhlex
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

MAX_HTML_BYTES = 20_000_000


@dataclass
class FetchReport:
    fetched: int = 0
    failed: int = 0
    no_provisions: int = 0
    bytes_written: int = 0


def payload_path(settings: Settings, version_id: int):
    return settings.raw_dir / "zhlex" / f"{version_id}.html"


async def _one(client: zhlex.ZhlexClient, conn, row: dict, settings: Settings,
               report: FetchReport) -> None:
    version_id = row["version_id"]
    try:
        url = row["xml_url"] or ""
        if not url.startswith(zhlex.WEBRT_PREFIX):
            db.fail_version(conn, version_id, f"not a WebRT url: {url[:80]}", max_attempts=1)
            report.failed += 1
            return
        try:
            body, content_type = await client.body(url)
        except FetchError as exc:
            log.warning("version %s: fetch failed: %s", version_id, exc)
            db.fail_version(conn, version_id, str(exc), settings.max_attempts)
            report.failed += 1
            return
        if len(body) > MAX_HTML_BYTES:
            db.fail_version(conn, version_id, f"payload is {len(body)} bytes", settings.max_attempts)
            report.failed += 1
            return
        try:
            zhlex.parse_webrt(body, content_type)
        except zhlex.ZhlexParseError as exc:
            db.fail_version(conn, version_id, f"no_provisions: {exc}", max_attempts=1)
            report.no_provisions += 1
            return
        text = text_extract.decode_html(body, content_type)
        path = payload_path(settings, version_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        db.complete_version(conn, version_id, "fetched", akn_xml=text,
                            fetched_at=datetime.now(timezone.utc))
        report.fetched += 1
        report.bytes_written += len(body)
    except Exception as exc:                                    # noqa: BLE001
        log.error("version %s: %s", version_id, exc)
        try:
            db.fail_version(conn, version_id, str(exc), settings.max_attempts)
        except Exception as fail_exc:
            log.error("version %s: also failed recording the failure: %s", version_id, fail_exc)
        report.failed += 1


async def _run_async(settings: Settings, limit: int | None, transport, rate: float) -> FetchReport:
    report = FetchReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.cantonal_per_host, transport=transport) as fetcher:
            client = zhlex.ZhlexClient(fetcher, rate=rate)
            while True:
                size = 50 if remaining is None else min(50, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source="zhlex", url_prefix=zhlex.WEBRT_PREFIX)
                if not rows:
                    break
                await asyncio.gather(*(_one(client, conn, r, settings, report) for r in rows))
                if remaining is not None:
                    remaining -= len(rows)
                log.info("zh fetched=%d failed=%d no_provisions=%d",
                         report.fetched, report.failed, report.no_provisions)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None, transport=None,
        rate: float = 2.0) -> FetchReport:
    return asyncio.run(_run_async(settings, limit, transport, rate))


def main() -> FetchReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: network-bound."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d no_provisions=%d bytes=%d", result.fetched,
             result.failed, result.no_provisions, result.bytes_written)
    return result


if __name__ == "__main__":
    main()
