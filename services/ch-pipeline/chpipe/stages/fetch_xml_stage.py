"""Download the Akoma Ntoso XML named by each discovered version.

~170,000 files (56,328 consolidations across three to five languages, of
which about 12,033 carry the XML manifestation versions_stage's query
requires). The XML is written to disk AND kept in ch_act_version.akn_xml:
the column is what parse_akn_stage (and any future re-parse) reads, and what
a resumed run depends on. The file under raw_dir is the audit copy, kept so
a human can open exactly what Fedlex returned -- no other stage ever reads
it back off disk, and a run must not depend on it still being there.

Two defects this stage exists to not repeat, both drawn from production's
ch_legislation (96% CSS, migration 197's docstring):

  * A download that is not Akoma Ntoso -- an HTML error page, a redirect
    target -- must not be stored as if it were. _validate_and_normalize()
    parses the payload and checks its root element before anything is
    written; a response that fails either check is recorded as a failure,
    never as a fetched edition.
  * ch_act_version.akn_xml is a `text` column, so what parse_akn_stage
    re-encodes as UTF-8 must actually decode as UTF-8. Fedlex has always
    served UTF-8 in practice (verified against the OR fixture), but nothing
    guarantees a document's declared encoding matches that forever, and if
    it ever did not, storing the original prolog verbatim would mean
    parse_akn_stage's re-encode/re-parse applies the *stored* (wrong)
    declared encoding to bytes that are *actually* UTF-8 -- a double-decode.
    _validate_and_normalize() re-serialises through lxml once, with an
    explicit UTF-8 declaration, so what lands in the column always matches
    what will later be re-encoded, regardless of what the server sent. The
    raw bytes as received are still what lands on disk.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from lxml import etree

from .. import akn, db, throttle
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

MAX_XML_BYTES = 20_000_000          # the OR at 2.4 MB is a large act, not the limit


@dataclass
class FetchXmlReport:
    fetched: int = 0
    failed: int = 0
    bytes_written: int = 0


def xml_path(settings: Settings, version_id: int):
    directory = settings.raw_dir / "legislation" / f"{version_id // 1000:04d}"
    return directory / f"{version_id}.xml"


def _validate_and_normalize(payload: bytes) -> bytes | None:
    """Parse `payload` and, if it is genuinely Akoma Ntoso, return a
    canonical UTF-8 serialisation of it. Returns None for anything that is
    not well-formed XML rooted in the AKN namespace -- an HTML error page
    chief among them. See the module docstring for why the re-serialisation
    (not just a namespace check) matters for the database round trip.
    """
    try:
        root = etree.fromstring(payload)
    except etree.XMLSyntaxError:
        return None
    if root.tag != f"{{{akn.AKN_NS}}}akomaNtoso":
        return None
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


async def _fetch_batch(fetcher, conn, rows: list[dict], settings: Settings,
                       report: FetchXmlReport) -> None:
    async def one(row) -> None:
        # No path through this task may raise into asyncio.gather: one bad
        # edition (a fetch failure, a non-AKN response, a disk error, a
        # database error, even a database error while RECORDING one of
        # those) must not cancel the sibling tasks in the batch and unwind
        # the whole stage run over the other 12,032 editions. Same shape as
        # fetch_stage._fetch_batch's one() -- see its comment for the round
        # 1 defect this guards against. except Exception, not bare, so
        # CancelledError/KeyboardInterrupt still propagate.
        try:
            if not row["xml_url"]:
                db.fail_version(conn, row["version_id"], "no xml_url",
                                settings.max_attempts)
                report.failed += 1
                return
            try:
                payload = await fetcher.bytes(row["xml_url"])
            except FetchError as exc:
                log.warning("version %s: fetch failed: %s",
                           row["version_id"], exc)
                db.fail_version(conn, row["version_id"], str(exc),
                                settings.max_attempts)
                report.failed += 1
                return
            if len(payload) > MAX_XML_BYTES:
                db.fail_version(conn, row["version_id"],
                                f"xml is {len(payload)} bytes",
                                settings.max_attempts)
                report.failed += 1
                return

            normalized = _validate_and_normalize(payload)
            if normalized is None:
                # The exact defect that left production's ch_legislation 96%
                # CSS: the old importer stored whatever the server returned,
                # an HTML error page in most cases, and its text-extraction
                # fallback turned a stylesheet into "full text".
                db.fail_version(
                    conn, row["version_id"],
                    f"response is not Akoma Ntoso XML ({len(payload)} bytes)",
                    settings.max_attempts)
                report.failed += 1
                return

            # The audit copy on disk is exactly what Fedlex returned, not
            # the normalised form -- a human reading it back should see the
            # real response, byte for byte.
            path = xml_path(settings, row["version_id"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)

            # akn_xml and fetched_at land in ONE UPDATE. Clearing fetched_at
            # here and restoring it with a second statement is the same
            # pattern that made last_error inconsistent across three call
            # sites in the decisions pipeline -- a crash between the two
            # statements would leave a 'fetched' row with no fetched_at.
            db.complete_version(
                conn, row["version_id"], "fetched",
                akn_xml=normalized.decode("utf-8"),
                fetched_at=datetime.now(timezone.utc))
            report.fetched += 1
            report.bytes_written += len(payload)
        except Exception as exc:                            # noqa: BLE001
            log.error("version %s: %s", row["version_id"], exc)
            try:
                db.fail_version(conn, row["version_id"], str(exc),
                                settings.max_attempts)
            except Exception as fail_exc:
                log.error("version %s: also failed recording the failure: %s",
                          row["version_id"], fail_exc)
            report.failed += 1

    await asyncio.gather(*(one(r) for r in rows))


async def _run_async(settings: Settings, limit: int | None) -> FetchXmlReport:
    report = FetchXmlReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            while True:
                size = 200 if remaining is None else min(200, remaining)
                if size <= 0:
                    break
                # backoff_minutes is passed explicitly, exactly as
                # fetch_stage does: without it this stage silently ran on
                # db.RETRY_BACKOFF_MINUTES's module default and
                # CHPIPE_RETRY_BACKOFF_MINUTES did nothing at all -- including
                # the empty value config.py documents as "no wait", which the
                # tests and a maintenance window both rely on.
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes)
                if not rows:
                    break

                await _fetch_batch(fetcher, conn, rows, settings, report)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("xml fetched=%d failed=%d", report.fetched, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None) -> FetchXmlReport:
    return asyncio.run(_run_async(settings, limit))


def main() -> FetchXmlReport:
    """Entry point. A function, not an `if __name__` block, so what the
    entry point decides -- the limit it reads, the priority it sets -- is
    reachable from a test. See tests/test_entry_points.py for the shipped
    bug that argument comes from.

    nice 10 per spec section 8: I/O bound, but it still holds the GIL and a
    connection pool while pulling ~12,000 files onto a box serving live
    traffic. No capacity wait -- the work is network-bound, not CPU-bound.
    """
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("fetched=%d failed=%d bytes=%d", result.fetched, result.failed,
             result.bytes_written)
    return result


if __name__ == "__main__":
    main()
