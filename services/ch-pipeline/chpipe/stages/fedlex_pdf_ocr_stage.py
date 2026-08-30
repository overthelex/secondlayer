"""OCR rescue for the pdf-a editions whose text layer failed the quality
gate (source='fedlex_pdf', stage='failed', last_error 'quality N.NN' or
'empty_text_layer' -- the two verdicts fedlex_pdf_text_stage can reach about
the document itself rather than about fetching it).

The 2026-08 backfill left 402 such rows: 284 at quality 0.15 are pre-digital
consolidations scanned to PDF with no (or a junk) text layer, the rest sit
just under ACCEPT_THRESHOLD. This stage re-downloads each PDF and runs it
through the same CPU tesseract machinery the decisions corpus uses
(chpipe.ocr.ocr_pdf: pdftoppm page by page at 300 dpi), then applies the
same quality gate. A rescue lands exactly like a fedlex_pdf_text_stage
success (stage='parsed', full_text, article_count stays NULL); a scan
tesseract cannot read either is retired by REWRITING last_error to
'ocr quality ...', which no longer matches this stage's claim filter -- the
row stays 'failed', keeps its story, and stops consuming the queue.

No new stage value, no migration: 'failed' rows are claimed directly by
last_error class. That makes the queue walk self-terminating (every claimed
row either leaves 'failed' or leaves the filter) without widening migration
197's stage CHECK. A fetch error leaves the row completely untouched -- it
is remembered in-memory for this run (so the claim loop cannot spin on it)
and claimable again on the next run.

SEQUENTIAL like fedlex_pdf_text_stage, and low-priority like ocr_stage:
tesseract is minutes per document on prod's shared cores, so main() runs at
NICE_OCR and run() checks the load-average ceiling between batches.

Not wired into the nightly delta: new fedlex_pdf quality failures are rare
(the pdf-a corpus is historical; new Fedlex editions arrive as XML), and a
scan can take long enough that an unbounded nightly walk is a risk with no
payoff. Run supervised via `./run-stage.sh fedlex-pdf-ocr` when
failed_by_stage_versions() shows a tail worth rescuing.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .. import db, ocr, text_quality, throttle
from ..config import Settings
from ..http import FetchError, Fetcher
from .fedlex_pdf_text_stage import MAX_PDF_BYTES

log = logging.getLogger(__name__)

BATCH_SIZE = 10

OCR_TMP_DIRNAME = ".fedlex-pdf-ocr-tmp"

# The two last_error classes fedlex_pdf_text_stage writes about the DOCUMENT
# (as opposed to about fetching it): a text layer that scored under the gate,
# and no text layer at all. Everything else on a failed fedlex_pdf row -- a
# fetch error, 'pdf_too_large', 'no xml_url' -- is not something OCR can fix.
_CLAIM = """
SELECT version_id, xml_url, lang
  FROM ch_act_version
 WHERE source = 'fedlex_pdf' AND stage = 'failed'
   AND (last_error LIKE 'quality %%' OR last_error = 'empty_text_layer')
   AND NOT (version_id = ANY(%(seen)s))
 ORDER BY version_id
 LIMIT %(limit)s
"""

# The retirement write: the row stays 'failed', but its last_error no longer
# matches _CLAIM, so the walk cannot pick it up again. stage_updated_at moves
# so an operator reading the queue can see OCR had its turn and when.
_RETIRE = """
UPDATE ch_act_version
   SET last_error = %s, stage_updated_at = now(), updated_at = now()
 WHERE version_id = %s
"""


@dataclass
class FedlexPdfOcrReport:
    claimed: int = 0
    recovered: int = 0
    still_bad: int = 0
    # A fetch failure leaves the row untouched and claimable next run --
    # counted, remembered for this run, never retired.
    fetch_failed: int = 0
    bytes_downloaded: int = 0


async def _run_async(settings: Settings, limit: int | None,
                     transport) -> FedlexPdfOcrReport:
    report = FedlexPdfOcrReport()
    conn = db.connect(settings)
    remaining = limit
    tmp_dir = settings.raw_dir / OCR_TMP_DIRNAME
    tmp_dir.mkdir(parents=True, exist_ok=True)
    # Rows this run must not claim again: retired rows leave the filter by
    # themselves, but a fetch-failed row stays claimable by design, and
    # without this the while-loop would spin on it until the run is killed.
    seen: list[int] = []
    try:
        async with Fetcher(concurrency=settings.http_concurrency,
                           transport=transport) as fetcher:
            while True:
                throttle.wait_for_capacity(settings.load_ceiling, "fedlex-pdf-ocr")
                size = BATCH_SIZE if remaining is None else min(BATCH_SIZE, remaining)
                if size <= 0:
                    break
                rows = conn.execute(
                    _CLAIM, {"seen": seen, "limit": size}).fetchall()
                if not rows:
                    break
                report.claimed += len(rows)
                for row in rows:
                    await _process_one(fetcher, conn, dict(row), settings,
                                       report, tmp_dir, seen)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("fedlex-pdf-ocr recovered=%d still_bad=%d fetch_failed=%d",
                         report.recovered, report.still_bad, report.fetch_failed)
    finally:
        conn.close()
    return report


async def _process_one(fetcher: Fetcher, conn, row: dict, settings: Settings,
                       report: FedlexPdfOcrReport, tmp_dir: Path,
                       seen: list[int]) -> None:
    version_id = row["version_id"]
    seen.append(version_id)
    try:
        try:
            payload = await fetcher.bytes(row["xml_url"])
        except FetchError as exc:
            # Transient by assumption: leave the row exactly as it is, so
            # the next run can try again. Retiring it here would burn the
            # document's one OCR shot on a network hiccup.
            log.warning("version %s: fetch failed: %s", version_id, exc)
            report.fetch_failed += 1
            return

        if len(payload) > MAX_PDF_BYTES:
            conn.execute(_RETIRE, ("ocr skipped: pdf_too_large", version_id))
            report.still_bad += 1
            return
        report.bytes_downloaded += len(payload)

        # OcrToolMissing must escape (same contract as PdfToolMissing in
        # fedlex_pdf_text_stage): a box with no tesseract cannot process ANY
        # row, and retiring the whole queue over a deployment problem would
        # spend every document's one OCR shot on nothing.
        with tempfile.NamedTemporaryFile(suffix=".pdf", dir=str(tmp_dir)) as tmp:
            tmp.write(payload)
            tmp.flush()
            text = ocr.ocr_pdf(Path(tmp.name), [row["lang"]], tmp_root=tmp_dir)

        quality = text_quality.score(text, [row["lang"]])
        if quality >= text_quality.ACCEPT_THRESHOLD:
            db.complete_version(conn, version_id, "parsed", full_text=text,
                                fetched_at=datetime.now(timezone.utc))
            report.recovered += 1
        else:
            conn.execute(_RETIRE,
                         (f"ocr quality {quality:.2f} below "
                          f"{text_quality.ACCEPT_THRESHOLD}; the scan is not "
                          "readable", version_id))
            report.still_bad += 1
    except ocr.OcrToolMissing:
        raise
    except Exception as exc:                            # noqa: BLE001
        # One bad row must not abort the walk -- but unlike a fetch error
        # this is not known-transient, so retire it with the reason rather
        # than leaving a row that may crash every future run in the queue.
        log.error("version %s: %s", version_id, exc)
        try:
            conn.execute(_RETIRE, (f"ocr error: {type(exc).__name__}: {exc}"[:2000],
                                   version_id))
        except Exception as retire_exc:
            log.error("version %s: also failed recording the failure: %s",
                      version_id, retire_exc)
        report.still_bad += 1


def run(settings: Settings, limit: int | None = None,
        transport=None) -> FedlexPdfOcrReport:
    return asyncio.run(_run_async(settings, limit, transport))


def main() -> FedlexPdfOcrReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. NICE_OCR for the same reason ocr_stage's
    main() uses it: tesseract dominates, and it shares prod's cores with
    live traffic."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_OCR)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("claimed=%d recovered=%d still_bad=%d fetch_failed=%d bytes=%d",
             result.claimed, result.recovered, result.still_bad,
             result.fetch_failed, result.bytes_downloaded)
    return result


if __name__ == "__main__":
    main()
