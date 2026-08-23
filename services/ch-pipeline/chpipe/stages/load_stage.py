"""Stage 5: promote extracted rows to loaded.

Separate from extract on purpose. `extract` already writes `full_text`; this
stage does nothing but a final sanity check and a stage flip. It is kept
separate because the `UPDATE ... SET stage = 'loaded'` here is the statement
that moves roughly 500,000 rows from NULL to text on the production table,
and that transition fires trg_jstats, the delta trigger behind
v_jurisdiction_fulltext_stats. Folding this into extract would mean that
trigger fires interleaved with fetch/extract concurrency instead of in one
resumable, single-purpose pass -- keeping it here means the trigger's
behaviour is verified once (Gate B) and exercised in exactly one known way.
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
    skipped_empty: int = 0


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
                    report.skipped_empty += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("loaded=%d skipped_empty=%d", report.loaded, report.skipped_empty)
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
    log.info("loaded=%d skipped_empty=%d", result.loaded, result.skipped_empty)
