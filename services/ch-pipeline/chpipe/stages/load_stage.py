"""Stage 5: promote extracted rows to loaded.

What this stage is NOT: it is not the statement that moves rows from NULL to
text, and it does not fire trg_jstats. That claim stood here through several
rounds and was wrong. Migration 156 attaches the trigger as
`AFTER INSERT OR DELETE OR UPDATE OF full_text`, and this stage writes only
`stage` and its bookkeeping columns -- `full_text` is written by
extract_stage (and by ocr_stage for a recovered scan), which is where the
NULL -> text transition actually happens and where Gate B has to be
measured. tests/test_jstats_trigger.py measures both directions.

What it IS, and the reason it stays a separate stage: a read-back. `extract`
writes `full_text` from memory and moves on; `load` claims the row again,
asks the DATABASE how long the text it stored actually is, and only then
marks the document done. A row that reached 'extracted' with no text --
a write that silently did not land, a value trimmed by something downstream
-- is caught here rather than counted as corpus. 'loaded' therefore means
"verified present in the destination table", which is a different and
stronger claim than "we called UPDATE", and it is the state the coverage
gates count. Keeping it as its own resumable pass also means the final
sweep over ~500,000 rows can be run, interrupted and re-run without
touching the extraction work.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db
from ..config import Settings

log = logging.getLogger(__name__)

MIN_TEXT_LENGTH = 200          # same threshold the coverage numbers use


@dataclass
class LoadReport:
    loaded: int = 0
    # A measured finding: the row reached 'extracted' with less than
    # MIN_TEXT_LENGTH characters of text. Something upstream is broken.
    skipped_empty: int = 0
    # An exception -- a dropped connection, a constraint violation, anything.
    # Kept apart from skipped_empty, which used to be incremented from both
    # branches: "skipped_empty=1200" then asserted a cause the stage had not
    # measured, and every other stage in this pipeline already reports these
    # two populations separately.
    failed: int = 0


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> LoadReport:
    report = LoadReport()
    conn = db.connect(settings)
    remaining = limit
    # Rows without a doc_id cannot be claimed (see db.claim); say how many
    # are being skipped rather than letting them sit invisibly at this stage.
    unkeyed = db.unkeyed_count(conn, "extracted", spider)
    if unkeyed:
        log.warning("%d rows at stage 'extracted' have no doc_id and cannot be "
                    "claimed; run `index` to key them", unkeyed)
    try:
        while True:
            size = 1000 if remaining is None else min(1000, remaining)
            if size <= 0:
                break
            rows = db.claim(conn, "extracted", limit=size, spider=spider,
                            max_attempts=settings.max_attempts,
                            backoff_minutes=settings.retry_backoff_minutes)
            if not rows:
                break
            # Each row is resolved independently. load_stage does a per-row
            # length query and one write (db.complete for the good case,
            # db.mark_failed for the empty-text case); either raising for a
            # single row (e.g. a dropped connection, or a value that trips a
            # constraint) must not abort the rest of the batch. This is the same defect class already fixed in
            # index_stage, fetch_stage and extract_stage: an exception
            # escaping the per-row work via the loop body would kill the
            # whole run. Genuine exceptions are routed to db.fail() -- which
            # is retry-budgeted via `attempts` -- so a transient error gets
            # another chance and a permanent one eventually lands on
            # 'failed'. This is deliberately distinct from the empty-text
            # branch below, which is not a transient failure: a row that
            # reached 'extracted' with no text can never gain text on retry,
            # so it is failed immediately via db.complete() rather than
            # spending its attempts budget.
            for row in rows:
                try:
                    length = conn.execute(
                        "SELECT coalesce(length(full_text), 0) AS n "
                        "FROM ch_court_decisions WHERE doc_id = %s",
                        (row["doc_id"],)).fetchone()["n"]
                    if length < MIN_TEXT_LENGTH:
                        # A row can only reach 'extracted' with text. If it
                        # has none by the time load claims it, something
                        # upstream is broken, and marking it loaded would
                        # hide that -- fail it immediately and record why.
                        # This used to be db.complete(..., "failed") plus a
                        # follow-up UPDATE, because complete() clears
                        # last_error; db.mark_failed() is the one helper all
                        # three terminal call sites now share.
                        db.mark_failed(
                            conn, row["doc_id"],
                            f"extracted but text is {length} chars",
                            from_stage="extracted")
                        report.skipped_empty += 1
                        continue
                    db.complete(conn, row["doc_id"], "loaded")
                    report.loaded += 1
                except Exception as exc:                       # noqa: BLE001
                    log.error("%s/%s: %s", row["spider"], row["doc_id"], exc)
                    try:
                        db.fail(conn, row["doc_id"], f"{type(exc).__name__}: {exc}",
                                settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("%s/%s: also failed recording the failure: %s",
                                 row["spider"], row["doc_id"], fail_exc)
                    report.failed += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("loaded=%d skipped_empty=%d failed=%d", report.loaded,
                     report.skipped_empty, report.failed)
    finally:
        conn.close()
    return report


def main() -> LoadReport:
    """Entry point. A function, not an `if __name__` block, so the
    CHPIPE_SPIDER contract every stage shares is reachable from a test."""
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("loaded=%d skipped_empty=%d failed=%d", result.loaded,
             result.skipped_empty, result.failed)
    return result


if __name__ == "__main__":
    main()
