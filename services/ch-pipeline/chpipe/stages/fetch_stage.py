"""Stage 2: download the document body from the entscheidsuche mirror.

HTML is preferred wherever it exists: it carries structure, it needs no text
layer, and it cannot be a scan. Measured 2026-08-23, HTML availability is per
spider, not global — GE_Gerichte, CH_BGE, TI_Gerichte and VD_Omni ship HTML,
while CH_BVGer (94,081 documents) and ZH_Obergericht (37,381) are PDF only.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import pathlib
import re
from dataclasses import dataclass

from .. import db, text_extract
from ..config import Settings
from ..http import FetchError, Fetcher

log = logging.getLogger(__name__)

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._ -]+$")


@dataclass
class FetchReport:
    fetched_html: int = 0
    fetched_pdf: int = 0
    failed: int = 0
    bytes_written: int = 0


def raw_path(raw_dir: pathlib.Path, spider: str, doc_id: str,
             extension: str) -> pathlib.Path:
    """Never trust a doc id or spider name from a remote directory listing to
    describe its own path safely.

    _SAFE_NAME is a cheap first line -- it rejects '/' and null bytes -- but
    it is not enough on its own: it accepts a bare '..', a bare '.', and any
    run of dots, spaces and hyphens, so ".." passes it outright. For doc_id
    that is masked in THIS module because the caller always appends a
    non-empty '.{extension}', so a bare '..' never surfaces as a literal path
    segment here -- but raw_path and write_body are general, exported
    helpers, and spider is used bare (raw_dir / spider). So the path is also
    validated by construction: build each segment, resolve it, and confirm it
    is still strictly inside its parent. That check does not depend on the
    extension-append accident and holds regardless of how a caller combines
    these arguments.
    """
    if not _SAFE_NAME.match(doc_id) or not _SAFE_NAME.match(spider):
        raise ValueError(f"unsafe path component: {spider}/{doc_id}")

    base = raw_dir.resolve()
    spider_dir = (raw_dir / spider).resolve()
    if spider_dir == base or not spider_dir.is_relative_to(base):
        raise ValueError(
            f"unsafe path component: spider={spider!r} escapes {raw_dir}")

    doc_dir = (spider_dir / doc_id).resolve()
    if doc_dir == spider_dir or not doc_dir.is_relative_to(spider_dir):
        raise ValueError(
            f"unsafe path component: doc_id={doc_id!r} escapes {spider_dir}")

    path = raw_dir / spider / f"{doc_id}.{extension}"
    if not path.resolve().is_relative_to(base):
        raise ValueError(f"unsafe path component: {spider}/{doc_id} escapes {raw_dir}")
    return path


def choose_body(row) -> tuple[str, str] | None:
    """('html'|'pdf', url) for the body we want, or None if there is none."""
    if row.get("html_url"):
        return "html", row["html_url"]
    if row.get("pdf_url"):
        return "pdf", row["pdf_url"]
    return None


def write_body(raw_dir: pathlib.Path, spider: str, doc_id: str, extension: str,
               payload: bytes) -> tuple[pathlib.Path, str]:
    path = raw_path(raw_dir, spider, doc_id, extension)
    digest = hashlib.sha256(payload).hexdigest()
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        return path, digest
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(payload)
    tmp.replace(path)            # atomic, so a killed run leaves no half file
    return path, digest


async def _fetch_batch(fetcher: Fetcher, conn, rows: list[dict], settings: Settings,
                       report: FetchReport) -> None:
    async def one(row) -> None:
        # No path through this task may raise into asyncio.gather: a fetch
        # failure, a write failure (full disk, a permission problem, an
        # unsafe path component), a database error completing the row, and
        # even a database error while RECORDING one of those failures must
        # all stay inside this function. Anything that escapes cancels the
        # sibling tasks in the batch and unwinds out of the whole stage run
        # -- round 1 guarded write_body()/db.complete() but left its own
        # three db.fail() calls unguarded, which is exactly this bug. One
        # outer guard around the whole body, rather than one per call site,
        # is what actually closes it -- the same ruling as _index_spider's
        # one(). except Exception, not bare except, so CancelledError and
        # KeyboardInterrupt still propagate.
        try:
            choice = choose_body(row)
            if choice is None:
                db.fail(conn, row["doc_id"], "no body url", settings.max_attempts)
                report.failed += 1
                return
            extension, url = choice
            try:
                payload, content_type = await fetcher.body(url)
            except FetchError as exc:
                # The highest-volume failure path in the whole pipeline: a
                # volunteer-run mirror, 800,000 requests. Logging nothing
                # here left the operator with a `last_error` column and no
                # log line to correlate it against.
                log.warning("%s/%s: fetch failed: %s",
                            row["spider"], row["doc_id"], exc)
                db.fail(conn, row["doc_id"], str(exc), settings.max_attempts)
                report.failed += 1
                return

            if extension == "html":
                # Transcode NOW, while the Content-Type header still exists.
                # After this the file on disk is UTF-8 by construction, so a
                # resumed run -- which has the file but no response -- needs
                # no charset from anywhere. See text_extract.to_utf8().
                payload = text_extract.to_utf8(payload, content_type)

            _, digest = write_body(settings.raw_dir, row["spider"],
                                   row["doc_id"], extension, payload)
            db.complete(conn, row["doc_id"], "fetched",
                        text_source=extension,
                        pdf_sha256=digest if extension == "pdf" else None)
            report.bytes_written += len(payload)
            if extension == "html":
                report.fetched_html += 1
            else:
                report.fetched_pdf += 1
        except Exception as exc:
            log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
            try:
                db.fail(conn, row["doc_id"], str(exc), settings.max_attempts)
            except Exception as fail_exc:
                log.error("%s/%s: also failed recording the failure: %s",
                         row["spider"], row["doc_id"], fail_exc)
            report.failed += 1

    await asyncio.gather(*(one(r) for r in rows))


async def _run_async(settings: Settings, limit: int | None,
                     spider: str | None) -> FetchReport:
    report = FetchReport()
    conn = db.connect(settings)
    batch = 500
    # Rows without a doc_id cannot be claimed (see db.claim); say how many
    # are being skipped rather than letting them sit invisibly at this stage.
    unkeyed = db.unkeyed_count(conn, "indexed", spider)
    if unkeyed:
        log.warning("%d rows at stage 'indexed' have no doc_id and cannot be "
                    "claimed; run `index` to key them", unkeyed)
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            while True:
                size = batch if remaining is None else min(batch, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "indexed", limit=size, spider=spider,
                                max_attempts=settings.max_attempts,
                                backoff_minutes=settings.retry_backoff_minutes)
                if not rows:
                    break

                await _fetch_batch(fetcher, conn, rows, settings, report)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("fetched html=%d pdf=%d failed=%d",
                         report.fetched_html, report.fetched_pdf, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> FetchReport:
    return asyncio.run(_run_async(settings, limit, spider))


def main() -> FetchReport:
    """Entry point. A function, not an `if __name__` block, so the
    CHPIPE_SPIDER contract every stage shares is reachable from a test."""
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("html=%d pdf=%d failed=%d bytes=%d", result.fetched_html,
             result.fetched_pdf, result.failed, result.bytes_written)
    return result


if __name__ == "__main__":
    main()
