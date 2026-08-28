"""Download one SIL act page per discovered GE/NE edition -- the SIL twin
of cantonal_fetch_stage over the same ch_act_version queue, filtered to
source='sil'.

What is stored: the page DECODED (sil.decode: the declared windows-1252)
in akn_xml -- the column holds "the raw document of this edition" in
whatever the source speaks; for SIL that is Word HTML -- plus an audit
copy on disk (raw/sil/{version_id}.htm, the bytes as served). Decoding
here, not in the parser, is deliberate: the Content-Type header carries
no charset on either host, so once the bytes are stored the <meta> tag is
the only statement of the encoding, and a text column cannot hold bytes.
What is checked before storing: that the body has a <body> and a <title>
-- the shape of every SIL page, and not of an IIS error page or a redirect
to a portal front page, which would otherwise be stored as an act.

A 404 is retired at once (max_attempts=1) with the reason in last_error:
the TOC named the page a moment ago, so a 404 is a host-side inconsistency
worth a look in Gate F's failed_by_reason, not something tomorrow's retry
resolves. Politeness: both hosts are small cantonal IIS boxes; requests
are spaced at least PACE_SECONDS apart per stage process and capped by
CHPIPE_CANTONAL_PER_HOST in flight (2 req/s at the default).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from .. import cantons, db, sil, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

# The largest page sampled is NE 101 (the constitution) at 231 KB; GE's
# constitution (A 2 00) is 194 KB. Ten times that is not an act.
MAX_HTML_BYTES = 5_000_000
PACE_SECONDS = 0.5


@dataclass
class SilFetchReport:
    fetched: int = 0
    failed: int = 0
    gone: int = 0            # 404, retired at once
    bytes_written: int = 0


class _Pacer:
    """At most one request start per PACE_SECONDS, across the concurrency
    the semaphore allows: a floor on spacing, not a ceiling on throughput."""

    def __init__(self, seconds: float) -> None:
        self._seconds = seconds
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self._next:
                await asyncio.sleep(self._next - now)
                now = time.monotonic()
            self._next = now + self._seconds


def payload_path(settings: Settings, version_id: int):
    return settings.raw_dir / "sil" / f"{version_id}.htm"


def validate(raw: bytes) -> str | None:
    """The decoded page if it looks like a SIL act page, else None."""
    text = sil.decode(raw)
    lowered = text[:8192].lower()
    if "<body" not in text.lower() or "<title" not in lowered:
        return None
    return text


def url_prefix(canton_code: str | None) -> str | None:
    """CHPIPE_CANTON -> the xml_url prefix of one host's rows; None for both."""
    if not canton_code:
        return None
    codes = cantons.sil_codes(canton_code)
    if len(codes) != 1:
        raise ValueError("sil-fetch runs one canton at a time or all of them; "
                         f"got {canton_code!r}")
    return f"https://{cantons.SIL[codes[0]].host}/"


async def _fetch_batch(fetcher: Fetcher, pacer: _Pacer, sem: asyncio.Semaphore, conn,
                       rows: list[dict], settings: Settings, report: SilFetchReport) -> None:
    async def one(row: dict) -> None:
        try:
            url = row["xml_url"]
            if not url:
                db.fail_version(conn, row["version_id"], "no xml_url", settings.max_attempts)
                report.failed += 1
                return
            try:
                async with sem:
                    await pacer.wait()
                    raw = await fetcher.bytes(url)
            except FetchError as exc:
                if "404 for" in str(exc):
                    db.fail_version(conn, row["version_id"],
                                    f"404: act page gone ({url})", max_attempts=1)
                    report.gone += 1
                    return
                log.warning("version %s: fetch failed: %s", row["version_id"], exc)
                db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
                report.failed += 1
                return
            if len(raw) > MAX_HTML_BYTES:
                db.fail_version(conn, row["version_id"], f"page is {len(raw)} bytes",
                                settings.max_attempts)
                report.failed += 1
                return
            text = validate(raw)
            if text is None:
                db.fail_version(conn, row["version_id"],
                                f"response is not a SIL act page ({len(raw)} bytes)",
                                settings.max_attempts)
                report.failed += 1
                return
            path = payload_path(settings, row["version_id"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            db.complete_version(conn, row["version_id"], "fetched", akn_xml=text,
                                fetched_at=datetime.now(timezone.utc))
            report.fetched += 1
            report.bytes_written += len(raw)
        except Exception as exc:                            # noqa: BLE001
            log.error("version %s: %s", row["version_id"], exc)
            try:
                db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
            except Exception as fail_exc:
                log.error("version %s: also failed recording the failure: %s",
                          row["version_id"], fail_exc)
            report.failed += 1

    await asyncio.gather(*(one(r) for r in rows))


async def _run_async(settings: Settings, canton_code: str | None, limit: int | None,
                     transport, pace: float) -> SilFetchReport:
    report = SilFetchReport()
    prefix = url_prefix(canton_code)
    conn = db.connect(settings)
    remaining = limit
    pacer = _Pacer(pace)
    sem = asyncio.Semaphore(max(1, settings.cantonal_per_host))
    try:
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            while True:
                size = 50 if remaining is None else min(50, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source="sil", url_prefix=prefix)
                if not rows:
                    break
                await _fetch_batch(fetcher, pacer, sem, conn, rows, settings, report)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("sil fetched=%d failed=%d gone=%d bytes=%d",
                         report.fetched, report.failed, report.gone, report.bytes_written)
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None, limit: int | None = None,
        transport=None, pace: float = PACE_SECONDS) -> SilFetchReport:
    return asyncio.run(_run_async(settings, canton_code, limit, transport, pace))


def main() -> SilFetchReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: network-bound, no capacity wait."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d gone=%d bytes=%d", result.fetched, result.failed,
             result.gone, result.bytes_written)
    return result


if __name__ == "__main__":
    main()
