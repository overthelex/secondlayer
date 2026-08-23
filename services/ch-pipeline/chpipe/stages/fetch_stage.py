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

from .. import db
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
    if not _SAFE_NAME.match(doc_id) or not _SAFE_NAME.match(spider):
        raise ValueError(f"unsafe path component: {spider}/{doc_id}")
    return raw_dir / spider / f"{doc_id}.{extension}"


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
        choice = choose_body(row)
        if choice is None:
            db.fail(conn, row["doc_id"], "no body url", settings.max_attempts)
            report.failed += 1
            return
        extension, url = choice
        try:
            payload = await fetcher.bytes(url)
        except FetchError as exc:
            db.fail(conn, row["doc_id"], str(exc), settings.max_attempts)
            report.failed += 1
            return
        # write_body() can raise on a full disk, a permission problem, or an
        # unsafe path component; db.complete() can raise on any database
        # error. Either raising inside this asyncio.gather cancels the sibling
        # tasks in the batch and unwinds out of the whole stage run. Log the
        # spider, the document id and the exception, count the document as
        # failed, and move on — the same ruling as _index_spider's one().
        try:
            _, digest = write_body(settings.raw_dir, row["spider"],
                                   row["doc_id"], extension, payload)
            db.complete(conn, row["doc_id"], "fetched",
                        text_source=extension,
                        pdf_sha256=digest if extension == "pdf" else None)
        except Exception as exc:
            log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
            db.fail(conn, row["doc_id"], str(exc), settings.max_attempts)
            report.failed += 1
            return
        report.bytes_written += len(payload)
        if extension == "html":
            report.fetched_html += 1
        else:
            report.fetched_pdf += 1

    await asyncio.gather(*(one(r) for r in rows))


async def _run_async(settings: Settings, limit: int | None,
                     spider: str | None) -> FetchReport:
    report = FetchReport()
    conn = db.connect(settings)
    batch = 500
    remaining = limit
    try:
        async with Fetcher(concurrency=settings.http_concurrency) as fetcher:
            while True:
                size = batch if remaining is None else min(batch, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "indexed", limit=size, spider=spider,
                                max_attempts=settings.max_attempts)
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


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("html=%d pdf=%d failed=%d bytes=%d", result.fetched_html,
             result.fetched_pdf, result.failed, result.bytes_written)
