"""Stage 4: OCR the documents that failed the text-layer quality gate.

This runs on the same 8 cores that serve live traffic, so it is the lowest
priority thing on the box: nice 19, a small worker count, and it stops
claiming work whenever the one-minute load average reaches the ceiling.
Calibration on 120 real PDFs (Task 9) found that only 5% of documents need
this stage at all, so the workload is expected to be a small tail, not the
bulk of the corpus -- which is exactly why it can afford to be this
conservative about prod capacity.
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import time
from dataclasses import dataclass

from .. import db, ocr, text_quality, throttle
from ..config import Settings
from ..throttle import should_pause
from .fetch_stage import raw_path

log = logging.getLogger(__name__)

PAUSE_SECONDS = throttle.PAUSE_SECONDS


@dataclass
class OcrReport:
    recovered: int = 0
    still_bad: int = 0
    failed: int = 0
    seconds: float = 0.0


def _ocr_one(settings: Settings, row) -> tuple[str, float]:
    path = raw_path(settings.raw_dir, row["spider"], row["doc_id"], "pdf")
    text = ocr.ocr_pdf(path, list(row.get("languages") or []))
    return text, text_quality.score(text, list(row.get("languages") or []))


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> OcrReport:
    report = OcrReport()
    conn = db.connect(settings)
    started = time.monotonic()
    # Rows without a doc_id cannot be claimed (see db.claim); say how many
    # are being skipped rather than letting them sit invisibly at this stage.
    unkeyed = db.unkeyed_count(conn, "ocr_pending", spider)
    if unkeyed:
        log.warning("%d rows at stage 'ocr_pending' have no doc_id and cannot be "
                    "claimed; run `index` to key them", unkeyed)
    remaining = limit
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.ocr_workers) as pool:
            while True:
                throttle.wait_for_capacity(settings.load_ceiling, "ocr")
                size = settings.ocr_workers * 4
                if remaining is not None:
                    size = min(size, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "ocr_pending", limit=size, spider=spider,
                                max_attempts=settings.max_attempts,
                                backoff_minutes=settings.retry_backoff_minutes)
                if not rows:
                    break
                futures = {pool.submit(_ocr_one, settings, r): r for r in rows}
                # Same defect class already fixed in index_stage, fetch_stage
                # and extract_stage: an exception from one document -- either
                # from future.result() itself, or from the db.complete()
                # write that follows it -- must not escape the as_completed
                # loop and abort the rest of the batch. The try/except below
                # therefore wraps future.result() AND both possible writes
                # (db.complete for success, db.fail for failure), not just
                # the former. A failure recording the failure (db.fail
                # itself raising) is also guarded so it cannot take the
                # batch down either.
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    try:
                        text, quality = future.result()
                        if quality >= text_quality.ACCEPT_THRESHOLD:
                            db.complete(conn, row["doc_id"], "extracted",
                                        full_text=text, text_quality=quality,
                                        text_source="ocr")
                            report.recovered += 1
                        else:
                            # OCR had its turn and the result is still
                            # unusable. Keep the score so the corpus can be
                            # honest about which documents it failed to
                            # read, rather than silently dropping them --
                            # and keep the reason, which db.complete() would
                            # have wiped along with last_error.
                            db.mark_failed(
                                conn, row["doc_id"],
                                f"ocr quality {quality:.4f} below "
                                f"{text_quality.ACCEPT_THRESHOLD}; the scan is "
                                "not readable",
                                from_stage="ocr_pending",
                                text_quality=quality, text_source="ocr")
                            report.still_bad += 1
                    except Exception as exc:                    # noqa: BLE001
                        log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
                        try:
                            db.fail(conn, row["doc_id"], f"{type(exc).__name__}: {exc}",
                                    settings.max_attempts)
                        except Exception as fail_exc:
                            log.error("%s/%s: also failed recording the failure: %s",
                                     row["spider"], row["doc_id"], fail_exc)
                        report.failed += 1
                        continue
                if remaining is not None:
                    remaining -= len(rows)
                log.info("recovered=%d still_bad=%d failed=%d",
                         report.recovered, report.still_bad, report.failed)
    finally:
        conn.close()
    report.seconds = time.monotonic() - started
    return report


def main() -> OcrReport:
    """Entry point. A function, not an `if __name__` block, so the
    CHPIPE_SPIDER contract every stage shares is reachable from a test.

    renice lives here rather than in run(): os.nice() is irreversible for a
    non-root process, so doing it inside run() permanently drags down every
    caller that imports the module -- including the test suite, which is
    exactly what the previous placement did."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_OCR)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("recovered=%d still_bad=%d failed=%d in %.0fs", result.recovered,
             result.still_bad, result.failed, result.seconds)
    return result


if __name__ == "__main__":
    main()
