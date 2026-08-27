"""Full text for the pdf-a editions versions_stage discovered where no XML
manifestation exists (source='fedlex_pdf', stage='discovered', xml_url = the
pdf-a file URL -- see versions_stage's module docstring for why the pdf URL
lives in a column called xml_url).

This is fetch_xml_stage's shape, not extract_stage's: the queue is
ch_act_version, claimed with claim_versions(..., source='fedlex_pdf') so this
stage and fetch_xml_stage's source='fedlex' claim never collide on the same
row, and a row that fails is recorded with fail_version()/db.complete_version()
exactly as fetch_xml_stage records fetched/failed XML editions. What differs
is what happens to the downloaded bytes: fetch_xml_stage stores an XML
document verbatim; this stage runs it through text_extract.from_pdf() and
text_quality.score() and stores the resulting plain text, the same gate
extract_stage applies to the decisions corpus's own PDFs.

No article split happens here -- article_count stays NULL on every row this
stage completes, PDF-era prose has no e_id structure to split on, and the
plan's Task 2 scope is full text only. A pdf-a row that later gains a real
XML manifestation is reclaimed by versions_stage's xml pass (source flips to
'fedlex', stage resets to 'discovered', full_text/article_count are cleared)
and is walked by fetch_xml_stage/parse_akn_stage from there -- this stage
never has to notice that happened.

SEQUENTIAL, NOT FANNED OUT (this is the one place this stage's structure
differs from fetch_xml_stage's asyncio.gather-per-batch): text_extract.from_pdf()
is a blocking `pdftotext` subprocess call, and text_quality.score() is pure
Python that holds the GIL for ~19 ms/doc (see config.py's docstring for the
measurement). Both would block the event loop for every row in a gathered
batch regardless of how many tasks were "concurrent", so gathering here would
buy nothing over a plain loop while adding the same failure-isolation
machinery fetch_xml_stage needs it for. At roughly 0.3 s network + 60 ms
pdftotext per document (spec estimate), 50,000 pdf-a rows is ~5 hours single
process; FOR UPDATE SKIP LOCKED already lets an operator run more than one
process at once for a supervised backfill, so there is no multi-worker
claiming logic here to duplicate that.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .. import db, text_quality, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..text_extract import PdfToolMissing, from_pdf

log = logging.getLogger(__name__)

BATCH_SIZE = 50
PROGRESS_EVERY = 200

# 80 MB: comfortably above any real Fedlex pdf-a edition (the largest control
# acts run a few MB even as XML) and small enough that a run cannot be made
# to hold an unbounded file in memory by one bad URL. Checked after the
# whole body is in hand -- Fetcher has no raw-byte streaming primitive (only
# stream_text(), which decodes as it goes and is for text bodies), the same
# limitation fetch_xml_stage's MAX_XML_BYTES lives with for the same reason.
MAX_PDF_BYTES = 80_000_000


@dataclass
class FedlexPdfTextReport:
    claimed: int = 0
    parsed: int = 0
    # A row that reached fail_version() for ANY reason -- a fetch failure,
    # pdf_too_large, or an exception this stage did not otherwise expect.
    # `empty` and `low_quality` below are NOT a subset of this count; they
    # are the same fail_version() call, bucketed by reason instead, the same
    # split cantonal_fetch_stage.FetchReport draws between `failed` and
    # `pdf_only`.
    failed: int = 0
    empty: int = 0
    low_quality: int = 0
    bytes_downloaded: int = 0


async def _process_one(fetcher: Fetcher, conn, row: dict, settings: Settings,
                        report: FedlexPdfTextReport) -> None:
    version_id = row["version_id"]
    try:
        if not row["xml_url"]:
            db.fail_version(conn, version_id, "no xml_url", settings.max_attempts)
            report.failed += 1
            return
        try:
            payload = await fetcher.bytes(row["xml_url"])
        except FetchError as exc:
            log.warning("version %s: fetch failed: %s", version_id, exc)
            db.fail_version(conn, version_id, str(exc), settings.max_attempts)
            report.failed += 1
            return

        if len(payload) > MAX_PDF_BYTES:
            db.fail_version(conn, version_id, "pdf_too_large", settings.max_attempts)
            report.failed += 1
            return
        report.bytes_downloaded += len(payload)

        # PdfToolMissing must escape this function (and _process_one's own
        # try/except below), not be recorded as a per-row failure -- a box
        # with no pdftotext binary cannot process ANY row, and marking every
        # one of them 'failed: pdftotext not installed' would burn the whole
        # queue's attempts budget on a deployment problem, not a document
        # problem.
        with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
            tmp.write(payload)
            tmp.flush()
            text = from_pdf(Path(tmp.name))

        if not text:
            db.fail_version(conn, version_id, "empty_text_layer", settings.max_attempts)
            report.failed += 1
            report.empty += 1
            return

        quality = text_quality.score(text, [row["lang"]])
        if quality < text_quality.ACCEPT_THRESHOLD:
            db.fail_version(conn, version_id, f"quality {quality:.2f}",
                            settings.max_attempts)
            report.failed += 1
            report.low_quality += 1
            return

        db.complete_version(conn, version_id, "parsed", full_text=text,
                            fetched_at=datetime.now(timezone.utc))
        report.parsed += 1
    except PdfToolMissing:
        raise
    except Exception as exc:                            # noqa: BLE001
        # Same defect class fetch_xml_stage's _fetch_batch guards against:
        # one bad row (a database error, an unexpected exception from
        # text_quality.score) must not abort the rest of the batch.
        log.error("version %s: %s", version_id, exc)
        try:
            db.fail_version(conn, version_id, str(exc), settings.max_attempts)
        except Exception as fail_exc:
            log.error("version %s: also failed recording the failure: %s",
                      version_id, fail_exc)
        report.failed += 1


async def _run_async(settings: Settings, limit: int | None,
                     transport) -> FedlexPdfTextReport:
    report = FedlexPdfTextReport()
    conn = db.connect(settings)
    remaining = limit
    processed = 0
    try:
        async with Fetcher(concurrency=settings.http_concurrency,
                           transport=transport) as fetcher:
            while True:
                size = BATCH_SIZE if remaining is None else min(BATCH_SIZE, remaining)
                if size <= 0:
                    break
                rows = db.claim_versions(
                    conn, "discovered", limit=size,
                    max_attempts=settings.max_attempts,
                    backoff_minutes=settings.retry_backoff_minutes,
                    source="fedlex_pdf")
                if not rows:
                    break
                report.claimed += len(rows)

                for row in rows:
                    await _process_one(fetcher, conn, row, settings, report)
                    processed += 1
                    if processed % PROGRESS_EVERY == 0:
                        log.info("fedlex-pdf-text progress: claimed=%d parsed=%d "
                                "failed=%d", report.claimed, report.parsed,
                                report.failed)

                if remaining is not None:
                    remaining -= len(rows)
                log.info("fedlex-pdf-text parsed=%d failed=%d",
                         report.parsed, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None, transport=None) -> FedlexPdfTextReport:
    return asyncio.run(_run_async(settings, limit, transport))


def main() -> FedlexPdfTextReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: the network download dominates
    (~0.3 s/doc vs ~78 ms of CPU between pdftotext and the quality score,
    per the module docstring's estimate), the same reasoning fetch_xml_stage
    gives for NICE_IO."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d failed=%d empty=%d low_quality=%d bytes=%d",
             result.parsed, result.failed, result.empty, result.low_quality,
             result.bytes_downloaded)
    return result


if __name__ == "__main__":
    main()
