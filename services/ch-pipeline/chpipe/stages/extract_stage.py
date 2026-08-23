"""Stage 3: raw body -> plain text, with a measured quality score.

Routing:
  html, good quality -> extracted
  html, bad quality  -> failed        (there is no scan behind an HTML page,
                                        so OCR cannot rescue it -- OCR needs a
                                        raster image, and an HTML page has no
                                        scan behind it to raster)
  pdf,  good quality -> extracted
  pdf,  bad or empty -> ocr_pending   (a PDF can carry a scanned image under a
                                        missing or junk text layer, so OCR has
                                        something to work with)
"""
from __future__ import annotations

import concurrent.futures
import logging
from dataclasses import dataclass

from .. import db, text_extract, text_quality
from ..config import Settings
from .fetch_stage import raw_path

log = logging.getLogger(__name__)


@dataclass
class ExtractReport:
    extracted: int = 0
    queued_for_ocr: int = 0
    failed: int = 0


def extract_one(settings: Settings, row) -> tuple[str, float, str]:
    source = row["text_source"] or "pdf"
    path = raw_path(settings.raw_dir, row["spider"], row["doc_id"], source)
    if not path.exists():
        raise FileNotFoundError(path)

    if source == "html":
        text = text_extract.from_html(path.read_bytes())
    else:
        text = text_extract.from_pdf(path)

    languages = list(row.get("languages") or [])
    quality = text_quality.score(text, languages)

    if quality >= text_quality.ACCEPT_THRESHOLD:
        return text, quality, "extracted"
    if source == "pdf":
        return text, quality, "ocr_pending"
    return text, quality, "failed"


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> ExtractReport:
    report = ExtractReport()
    conn = db.connect(settings)
    remaining = limit
    # Rows without a doc_id cannot be claimed (see db.claim); say how many
    # are being skipped rather than letting them sit invisibly at this stage.
    unkeyed = db.unkeyed_count(conn, "fetched", spider)
    if unkeyed:
        log.warning("%d rows at stage 'fetched' have no doc_id and cannot be "
                    "claimed; run `index` to key them", unkeyed)
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.cpu_workers) as pool:
            while True:
                size = 200 if remaining is None else min(200, remaining)
                if size <= 0:
                    break
                rows = db.claim(conn, "fetched", limit=size, spider=spider,
                                max_attempts=settings.max_attempts,
                                backoff_minutes=settings.retry_backoff_minutes)
                if not rows:
                    break
                futures = {pool.submit(extract_one, settings, r): r for r in rows}
                # Each future is resolved and completed independently: a
                # single document that fails to extract, OR whose db.complete
                # write fails (e.g. a Postgres DataError from a byte the
                # extractor did not know to strip), must not abort the rest
                # of the batch (two earlier stages had exactly this defect --
                # an exception escaping the loop via future.result() kills
                # the whole run). The try/except therefore wraps
                # future.result() AND the write that follows it, not just
                # the former -- a failure on either path is routed to
                # db.fail() the same way. Report counters are only
                # incremented once the row's fate is durably recorded, so a
                # failed write is never double-counted as both a success and
                # a failure.
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    try:
                        text, quality, next_stage = future.result()
                        if next_stage == "failed":
                            # Bad-quality HTML with no scan behind it: there
                            # is nothing left to try, so this is terminal --
                            # but the score that condemned it is the whole
                            # diagnosis and must survive. db.complete()
                            # clears last_error as part of its own SET list,
                            # so it cannot be used here.
                            db.mark_failed(
                                conn, row["doc_id"],
                                f"html quality {quality:.4f} below "
                                f"{text_quality.ACCEPT_THRESHOLD} and there is "
                                "no scan behind an HTML page to OCR",
                                from_stage="fetched", text_quality=quality)
                        else:
                            fields = {"text_quality": quality}
                            if next_stage == "extracted":
                                fields["full_text"] = text
                            db.complete(conn, row["doc_id"], next_stage, **fields)
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
                    if next_stage == "extracted":
                        report.extracted += 1
                    elif next_stage == "ocr_pending":
                        report.queued_for_ocr += 1
                    else:
                        report.failed += 1
                if remaining is not None:
                    remaining -= len(rows)
                log.info("extracted=%d ocr_pending=%d failed=%d", report.extracted,
                         report.queued_for_ocr, report.failed)
    finally:
        conn.close()
    return report


if __name__ == "__main__":
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("extracted=%d ocr_pending=%d failed=%d", result.extracted,
             result.queued_for_ocr, result.failed)
