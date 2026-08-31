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

No article split happens on the fetch path -- article_count stays NULL on
every row this stage completes, PDF-era prose has no e_id structure to split
on, and the plan's Task 2 scope was full text only. A pdf-a row that later
gains a real XML manifestation is reclaimed by versions_stage's xml pass
(source flips to 'fedlex', stage resets to 'discovered', full_text/
article_count are cleared) and is walked by fetch_xml_stage/parse_akn_stage
from there -- this stage never has to notice that happened.

CHPIPE_RESPLIT=1 (phase B of the gap plan) is the offline second half the
fetch path never had: no download, no claim -- it walks the rows already at
'parsed' with no articles (article_count IS NULL from the 2026-08 backfill,
or 0) and runs fedlex_split.split_fedlex_text over their STORED full_text.
That is the whole input: the backfill kept no PDFs (NamedTemporaryFile) and
wrote no akn_xml, so full_text -- pdftotext -layout minus the control
characters, line structure intact -- is the only material there is, and the
gate (scripts/fedlex_pdf_gate.py) measured it sufficient: article-number
overlap vs the AKN parse of the same acts median 1.000 / mean 0.962 over 63
pairs, 98% of a 203-row random sample splitting into articles. Rows that
gain articles get them via parse_akn_stage.store_articles (which also sets
article_count, taking the row out of the selection); full_text is NOT
rewritten -- the split's text product is a byproduct, the stored text stays
exactly what the backfill wrote. Rows that still split to nothing are left
untouched and selected again next run, the same contract as
pdf_text_stage's cantonal resplit. Batched by version_id keyset, CHPIPE_LIMIT
honoured, mirroring that mode.

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

from .. import db, fedlex_split, text_quality, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from ..text_extract import PdfToolMissing, from_pdf
from . import parse_akn_stage

log = logging.getLogger(__name__)

BATCH_SIZE = 50
PROGRESS_EVERY = 200

# Downloaded pdf-a bytes go next to the raw corpus, not the system temp
# directory -- same reasoning as ocr_stage.OCR_TMP_DIRNAME: tempfile's
# default is /tmp, which on prod is the root filesystem, while raw_dir sits
# on the volume actually sized for this workload.
PDF_TMP_DIRNAME = ".fedlex-pdf-text-tmp"

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
    # Every row that reached fail_version(), for ANY reason -- a fetch
    # failure, pdf_too_large, an empty text layer, a below-threshold quality
    # score, or an exception this stage did not otherwise expect. `empty`
    # and `low_quality` below are SUBSETS of this count, not siblings of it:
    # both branches increment `failed` and then their own more specific
    # counter (see _process_one), so failed == the total and
    # empty + low_quality == the two reasons this stage can distinguish out
    # of that total. This is NOT the same shape as cantonal_fetch_stage's
    # `pdf_only`, which is disjoint from its `failed` (a pdf-only version is
    # counted only as pdf_only, never also as failed).
    failed: int = 0
    empty: int = 0
    low_quality: int = 0
    bytes_downloaded: int = 0
    # resplit mode (CHPIPE_RESPLIT=1): rows re-read from full_text, how many
    # gained articles, and how many articles -- same counter names as
    # pdf_text_stage.PdfTextReport's resplit half
    resplit: int = 0
    recovered: int = 0
    articles: int = 0


async def _process_one(fetcher: Fetcher, conn, row: dict, settings: Settings,
                        report: FedlexPdfTextReport, tmp_dir: Path) -> None:
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
        with tempfile.NamedTemporaryFile(suffix=".pdf", dir=str(tmp_dir)) as tmp:
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
    tmp_dir = settings.raw_dir / PDF_TMP_DIRNAME
    tmp_dir.mkdir(parents=True, exist_ok=True)
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
                    await _process_one(fetcher, conn, row, settings, report, tmp_dir)
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


# Keyset pagination, not OFFSET: 51K rows at a median 41.5 KB of full_text
# each is ~2 GB if fetched in one go, and OFFSET restarts the scan each
# batch. COALESCE covers both shapes of "no articles": NULL (everything the
# 2026-08 backfill wrote) and 0 (a future run that stored an empty split).
_RESPLIT_ROWS = (
    "SELECT version_id, full_text FROM ch_act_version "
    "WHERE source = 'fedlex_pdf' AND stage = 'parsed' "
    "AND COALESCE(article_count, 0) = 0 AND full_text IS NOT NULL "
    "AND version_id > %s ORDER BY version_id LIMIT %s")

RESPLIT_BATCH = 200


def resplit(settings: Settings, limit: int | None = None) -> FedlexPdfTextReport:
    """CHPIPE_RESPLIT=1: articles for the parsed fedlex_pdf editions, from
    their stored full_text alone. See the module docstring. full_text is
    left untouched; store_articles() writes the rows and article_count in
    one transaction, which is the whole idempotency story -- a recovered
    row leaves the selection, an unrecovered one is re-walked next run."""
    report = FedlexPdfTextReport()
    conn = db.connect(settings)
    last_id = 0
    remaining = limit
    try:
        while True:
            size = RESPLIT_BATCH if remaining is None else min(RESPLIT_BATCH, remaining)
            if size <= 0:
                break
            with conn.cursor() as cur:
                cur.execute(_RESPLIT_ROWS, (last_id, size))
                rows = cur.fetchall()
            if not rows:
                break
            for row in rows:
                version_id, full_text = row["version_id"], row["full_text"]
                last_id = version_id
                report.resplit += 1
                try:
                    articles, _ = fedlex_split.split_fedlex_text(full_text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: resplit failed: %s", version_id, exc)
                    report.failed += 1
                    continue
                if not articles:
                    report.empty += 1
                    continue
                parse_akn_stage.store_articles(conn, version_id, articles)
                report.recovered += 1
                report.articles += len(articles)
            if remaining is not None:
                remaining -= len(rows)
            log.info("fedlex-resplit resplit=%d recovered=%d articles=%d "
                     "empty=%d failed=%d", report.resplit, report.recovered,
                     report.articles, report.empty, report.failed)
    finally:
        conn.close()
    return report


def main() -> FedlexPdfTextReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10: the network download dominates
    (~0.3 s/doc vs ~78 ms of CPU between pdftotext and the quality score,
    per the module docstring's estimate), the same reasoning fetch_xml_stage
    gives for NICE_IO."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    limit = int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None
    if os.environ.get("CHPIPE_RESPLIT", "") not in ("", "0"):
        # offline CPU walk, not a download: renice already applied above
        result = resplit(Settings.from_env(), limit=limit)
        log.info("RESPLIT resplit=%d recovered=%d articles=%d empty=%d failed=%d",
                 result.resplit, result.recovered, result.articles,
                 result.empty, result.failed)
        return result
    result = run(Settings.from_env(), limit=limit)
    log.info("parsed=%d failed=%d (of which empty=%d low_quality=%d) bytes=%d",
             result.parsed, result.failed, result.empty, result.low_quality,
             result.bytes_downloaded)
    return result


if __name__ == "__main__":
    main()
