"""Full text of the Federal Gazette materials: the pdf-a file of every
'discovered' ch_material row through pdftotext, gated by the same text
quality score the Fedlex pdf-a editions use (LEXAI-2038).

fedlex_pdf_text_stage with the queue swapped: claim / complete / fail run
against ch_material (db.claim_materials and friends), the download, the
size cap, the temp-file-under-raw_dir and the PdfToolMissing discipline
are the same and for the same reasons -- read that module's comments for
the why. What is different:

  * No article split. A Botschaft is prose with numbered sections, not a
    consolidation; the serving side finds the paragraphs that discuss an
    article at query time (regexp_split_to_table over full_text), so the
    text is stored as pdftotext -layout wrote it.
  * The quality gate is informational as well as a gate: the score is
    stored in text_quality so a later audit can rank the tail without
    re-extracting.

Measured 2026-09-02 on one 42-page Botschaft (2026/1948 de): 659 KB of
PDF, 129 K characters, clean text layer, numbered table of contents
intact. ~10.5K files at the box's ~1.5 s each is a few hours; the
supervised backfill owns that, the nightly delta drains a capped tail.

Env:
    CHPIPE_LIMIT   at most this many rows this run (delta passes its own cap)
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
PDF_TMP_DIRNAME = ".materials-text-tmp"
# Same ceiling as fedlex_pdf_text_stage.MAX_PDF_BYTES: the budget dispatch
# (Botschaft zum Voranschlag, several hundred pages) is the heaviest real
# file and sits far below it.
MAX_PDF_BYTES = 80_000_000


@dataclass
class MaterialsTextReport:
    claimed: int = 0
    parsed: int = 0
    # failed is the total; empty and low_quality are subsets of it (the
    # fedlex_pdf_text_stage convention).
    failed: int = 0
    empty: int = 0
    low_quality: int = 0
    bytes_downloaded: int = 0


async def _process_one(fetcher: Fetcher, conn, row: dict, settings: Settings,
                       report: MaterialsTextReport, tmp_dir: Path) -> None:
    material_id = row["material_id"]
    try:
        try:
            payload = await fetcher.bytes(row["pdf_url"])
        except FetchError as exc:
            log.warning("material %s: fetch failed: %s", material_id, exc)
            db.fail_material(conn, material_id, str(exc), settings.max_attempts)
            report.failed += 1
            return
        if len(payload) > MAX_PDF_BYTES:
            db.fail_material(conn, material_id, "pdf_too_large", settings.max_attempts)
            report.failed += 1
            return
        report.bytes_downloaded += len(payload)

        with tempfile.NamedTemporaryFile(suffix=".pdf", dir=str(tmp_dir)) as tmp:
            tmp.write(payload)
            tmp.flush()
            text = from_pdf(Path(tmp.name))

        if not text:
            db.fail_material(conn, material_id, "empty_text_layer", settings.max_attempts)
            report.failed += 1
            report.empty += 1
            return

        quality = text_quality.score(text, [row["lang"]])
        if quality < text_quality.ACCEPT_THRESHOLD:
            db.fail_material(conn, material_id, f"quality {quality:.2f}",
                             settings.max_attempts)
            report.failed += 1
            report.low_quality += 1
            return

        db.complete_material(conn, material_id, full_text=text, text_quality=quality,
                             pdf_bytes=len(payload),
                             fetched_at=datetime.now(timezone.utc))
        report.parsed += 1
    except PdfToolMissing:
        raise
    except Exception as exc:                            # noqa: BLE001
        log.error("material %s: %s", material_id, exc)
        try:
            db.fail_material(conn, material_id, str(exc), settings.max_attempts)
        except Exception as fail_exc:                   # noqa: BLE001
            log.error("material %s: also failed recording the failure: %s",
                      material_id, fail_exc)
        report.failed += 1


async def _run_async(settings: Settings, limit: int | None, transport) -> MaterialsTextReport:
    report = MaterialsTextReport()
    conn = db.connect(settings)
    remaining = limit
    processed = 0
    # Every material_id this run has claimed. A row that comes back from
    # the claim a second time means neither complete_material() nor
    # fail_material() wrote it (a database error in the failure path, say),
    # and without this guard the loop would re-claim it forever -- the walk
    # stops and says so instead. The version-queue stages share the shape
    # of this loop without the guard; the first run of THIS stage's test
    # suite found the hang in under a minute, which is why it is here.
    seen: set[int] = set()
    tmp_dir = settings.raw_dir / PDF_TMP_DIRNAME
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        async with Fetcher(concurrency=settings.http_concurrency, transport=transport) as fetcher:
            while True:
                size = BATCH_SIZE if remaining is None else min(BATCH_SIZE, remaining)
                if size <= 0:
                    break
                rows = db.claim_materials(conn, limit=size,
                                          max_attempts=settings.max_attempts,
                                          backoff_minutes=settings.retry_backoff_minutes)
                if not rows:
                    break
                stuck = [r["material_id"] for r in rows if r["material_id"] in seen]
                if stuck:
                    log.error("materials-text: %d rows re-claimed without a write-back "
                              "(first: %s); stopping this run", len(stuck), stuck[0])
                    break
                seen.update(r["material_id"] for r in rows)
                report.claimed += len(rows)
                for row in rows:
                    await _process_one(fetcher, conn, row, settings, report, tmp_dir)
                    processed += 1
                    if processed % PROGRESS_EVERY == 0:
                        log.info("materials-text progress: claimed=%d parsed=%d failed=%d",
                                 report.claimed, report.parsed, report.failed)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("materials-text parsed=%d failed=%d", report.parsed, report.failed)
    finally:
        conn.close()
    return report


def run(settings: Settings, limit: int | None = None, transport=None) -> MaterialsTextReport:
    return asyncio.run(_run_async(settings, limit, transport))


def main() -> MaterialsTextReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py. nice 10, as fedlex_pdf_text_stage: the
    download dominates."""
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    limit = int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None
    result = run(Settings.from_env(), limit=limit)
    log.info("materials-text claimed=%d parsed=%d failed=%d empty=%d low_quality=%d bytes=%d",
             result.claimed, result.parsed, result.failed, result.empty,
             result.low_quality, result.bytes_downloaded)
    return result


if __name__ == "__main__":
    main()
