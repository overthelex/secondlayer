"""Download one Lexwork version's show_as_json payload per discovered
cantonal edition -- the cantonal twin of fetch_xml_stage, over the same
ch_act_version queue, filtered to source='lexwork'.

What is stored: the payload, verbatim, in akn_xml (the column's meaning is
"the raw document of this edition"; for Fedlex that is Akoma Ntoso, here it
is JSON -- migration 201's COMMENT says so) plus an audit copy on disk.
What is checked before storing: that the body parses as JSON and has a
document tree at text_of_law.selected_version.json_content.document.content.
An HTML error page or a login redirect stored as a "payload" is the exact
defect that once filled 96% of ch_legislation with CSS; the check is what
keeps that from repeating on the cantonal side.

One payload carries every language of the version, and cantonal_acts_stage
created one queue row per language of the canton -- so sibling rows share
one URL. claim_versions orders by (act_id, date_applicability, lang), which
puts siblings next to each other in a batch; a per-batch cache keyed on the
URL turns the second and third download into a dictionary lookup. The
cache is per batch on purpose: holding every payload of a 150K-version run
in memory is the kind of "it is only a few hours" mistake throttle.py's
docstring warns about.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .. import cantons, db, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..lexwork_api import LexworkClient

log = logging.getLogger(__name__)

# The BE constitution's payload is 784 KB with all languages; the largest
# cantonal acts (tax law, building law) are a few MB. Anything past this is
# not a version, it is a mistake.
MAX_JSON_BYTES = 30_000_000

_BY_HOST = {c.host: c for c in cantons.LEXWORK.values()}


@dataclass
class FetchReport:
    fetched: int = 0
    failed: int = 0
    bytes_written: int = 0
    cache_hits: int = 0


def payload_path(settings: Settings, version_id: int):
    return settings.raw_dir / "cantonal" / f"{version_id}.json"


def validate(payload: bytes) -> str | None:
    """The payload as text if it is a Lexwork version document, else None."""
    try:
        data = json.loads(payload)
    except ValueError:
        return None
    try:
        root = data["text_of_law"]["selected_version"]["json_content"]["document"]["content"]
    except (KeyError, TypeError):
        return None
    if not isinstance(root, dict) or not root.get("uid"):
        return None
    return payload.decode("utf-8")


def _canton_of(url: str) -> cantons.Canton | None:
    return _BY_HOST.get(urlsplit(url).hostname or "")


def url_prefix(canton_code: str | None) -> str | None:
    """CHPIPE_CANTON -> the xml_url prefix that selects one host's rows.
    Several codes cannot be expressed as one LIKE; run them one at a time."""
    if not canton_code:
        return None
    codes = cantons.lexwork_codes(canton_code)
    if len(codes) != 1:
        raise ValueError("cantonal-fetch runs one canton at a time or all of them; "
                         f"got {canton_code!r}")
    return f"https://{cantons.LEXWORK[codes[0]].host}/"


async def _fetch_batch(client: LexworkClient, conn, rows: list[dict],
                       settings: Settings, report: FetchReport) -> None:
    cache: dict[str, str] = {}
    pending: dict[str, asyncio.Future] = {}

    async def download(url: str) -> str:
        """One download per URL per batch, however many rows share it."""
        if url in cache:
            report.cache_hits += 1
            return cache[url]
        if url in pending:
            report.cache_hits += 1
            return await pending[url]
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        pending[url] = future
        try:
            canton = _canton_of(url)
            if canton is None:
                raise FetchError(f"{url} is not on a known Lexwork host")
            body = await client.get_bytes(canton, url)
            if len(body) > MAX_JSON_BYTES:
                raise FetchError(f"payload is {len(body)} bytes")
            text = validate(body)
            if text is None:
                raise FetchError(f"response is not a Lexwork show_as_json payload ({len(body)} bytes)")
            cache[url] = text
            report.bytes_written += len(body)
            future.set_result(text)
            return text
        except BaseException as exc:
            future.set_exception(exc)
            raise

    async def one(row: dict) -> None:
        try:
            url = row["xml_url"]
            if not url:
                db.fail_version(conn, row["version_id"], "no xml_url", settings.max_attempts)
                report.failed += 1
                return
            try:
                text = await download(url)
            except FetchError as exc:
                log.warning("version %s: fetch failed: %s", row["version_id"], exc)
                db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
                report.failed += 1
                return
            path = payload_path(settings, row["version_id"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            db.complete_version(conn, row["version_id"], "fetched",
                                akn_xml=text,
                                fetched_at=datetime.now(timezone.utc))
            report.fetched += 1
        except Exception as exc:                            # noqa: BLE001
            log.error("version %s: %s", row["version_id"], exc)
            try:
                db.fail_version(conn, row["version_id"], str(exc), settings.max_attempts)
            except Exception as fail_exc:
                log.error("version %s: also failed recording the failure: %s",
                          row["version_id"], fail_exc)
            report.failed += 1

    await asyncio.gather(*(one(r) for r in rows))


async def _run_async(settings: Settings, canton_code: str | None,
                     limit: int | None, transport) -> FetchReport:
    report = FetchReport()
    prefix = url_prefix(canton_code)
    conn = db.connect(settings)
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            client = LexworkClient(fetcher, per_host=settings.cantonal_per_host)
            while True:
                size = 100 if remaining is None else min(100, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source="lexwork", url_prefix=prefix)
                if not rows:
                    break
                await _fetch_batch(client, conn, rows, settings, report)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("cantonal fetched=%d failed=%d cache_hits=%d",
                         report.fetched, report.failed, report.cache_hits)
    finally:
        conn.close()
    return report


def run(settings: Settings, canton_code: str | None = None,
        limit: int | None = None, transport=None) -> FetchReport:
    return asyncio.run(_run_async(settings, canton_code, limit, transport))


def main() -> FetchReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: network-bound, no capacity wait."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 canton_code=os.environ.get("CHPIPE_CANTON") or None,
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d bytes=%d cache_hits=%d", result.fetched,
             result.failed, result.bytes_written, result.cache_hits)
    return result


if __name__ == "__main__":
    main()
