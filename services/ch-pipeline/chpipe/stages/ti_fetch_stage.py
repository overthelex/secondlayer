"""Download Ticino's flat act page per discovered edition -- the TI twin of
cantonal_fetch_stage over the same ch_act_version queue, filtered to
source='ti_rl'.

What is stored: the page, verbatim, in akn_xml ("the raw document of this
edition": Akoma Ntoso for Fedlex, JSON for Lexwork, HTML here) plus an
audit copy on disk. What is checked before storing: that the body is an
act page (ti_rl.is_act_page). The portal answers an unknown id with HTTP
200 and "L'atto normativo cercato non è presente!" -- storing that as an
edition is the CSS-in-ch_legislation defect in a new coat, and the status
code cannot tell the two apart. Such a row fails with that sentence as its
reason and retries like a 404 would, in case the id was a list hiccup.

Pace: one request at a time, at most one per second (REQUEST_INTERVAL).
The portal is a PHP application on a cantonal server; the constitution
took 10.7 s to render on 2026-08-26 and a small decree 3.1 s, so it is the
server's time we are spending, not ours. 623 pages is ~40 minutes at that
pace, once.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import db, throttle, ti_rl
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

REQUEST_INTERVAL = 1.0
# The constitution is 223 KB, the colours decree 327 KB (11 inline PNGs).
# Anything past this is not an act page.
MAX_HTML_BYTES = 20_000_000


@dataclass
class TiFetchReport:
    fetched: int = 0
    failed: int = 0
    # HTTP 200 with the portal's "not present" body
    not_present: int = 0
    bytes_written: int = 0


def page_path(settings: Settings, version_id: int):
    return settings.raw_dir / "ti_rl" / f"{version_id}.html"


async def _one(fetcher: Fetcher, conn, row: dict, settings: Settings,
               report: TiFetchReport) -> None:
    try:
        url = row["xml_url"]
        if not url:
            db.fail_version(conn, row["version_id"], "no xml_url", settings.max_attempts)
            report.failed += 1
            return
        try:
            text = await fetcher.text(url)
        except FetchError as exc:
            log.warning("version %s: fetch failed: %s", row["version_id"], exc)
            db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
            report.failed += 1
            return
        if len(text) > MAX_HTML_BYTES:
            db.fail_version(conn, row["version_id"], f"page is {len(text)} chars",
                            settings.max_attempts)
            report.failed += 1
            return
        if not ti_rl.is_act_page(text):
            reason = ti_rl.MISSING_TEXT if ti_rl.MISSING_TEXT in text else "not an act page"
            db.fail_version(conn, row["version_id"], reason, settings.max_attempts)
            report.not_present += 1
            return
        path = page_path(settings, row["version_id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        db.complete_version(conn, row["version_id"], "fetched", akn_xml=text,
                            fetched_at=datetime.now(timezone.utc))
        report.fetched += 1
        report.bytes_written += len(text)
    except Exception as exc:                                    # noqa: BLE001
        log.error("version %s: %s", row["version_id"], exc)
        try:
            db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
        except Exception as fail_exc:
            log.error("version %s: also failed recording the failure: %s",
                      row["version_id"], fail_exc)
        report.failed += 1


async def _run_async(settings: Settings, limit: int | None, transport,
                     interval: float) -> TiFetchReport:
    report = TiFetchReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        async with Fetcher(concurrency=1, timeout=120.0, transport=transport) as fetcher:
            while True:
                size = 50 if remaining is None else min(50, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source="ti_rl")
                if not rows:
                    break
                for row in rows:
                    await _one(fetcher, conn, row, settings, report)
                    if interval:
                        await asyncio.sleep(interval)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("TI fetched=%d failed=%d not_present=%d bytes=%d",
                         report.fetched, report.failed, report.not_present, report.bytes_written)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None, transport=None,
        interval: float = REQUEST_INTERVAL) -> TiFetchReport:
    return asyncio.run(_run_async(settings, limit, transport, interval))


def main() -> TiFetchReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: network-bound, one request a second."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d not_present=%d bytes=%d", result.fetched, result.failed,
             result.not_present, result.bytes_written)
    return result


if __name__ == "__main__":
    main()
