"""Extraction stage: run chpipe.citations over every `loaded` decision's
full text and write the raw edges it finds -- BGE/docket/ECLI case
references into ch_case_citations, article references into
ch_legislation_citations.

This is extraction only. Nothing here resolves a citation to the row it
points at (to_ecli / article_id stay NULL) -- that is a later stage's job,
over the raw edges this one produces. See chpipe/citations.py for the
extraction rules themselves.

Queue model: unlike the stage-column queue in db.claim(), a decision does
not move off `loaded` here -- citations_extracted_at is a flag, stamped once
a decision's text has been scanned (successfully or not). A decision whose
extraction raises is still stamped: one bad text must not park it in the
claim query forever and starve every decision after it in `spider, doc_id`
order. The exception is logged with the decision's ecli and counted in
`failed`; last_error is left alone -- this stage does not own that column
(db.fail()/db.mark_failed() do, for the stage-column queue) and stamping a
flag is not a failure worth recording there.

Per batch the order is: extract everything (in a thread pool -- this is
CPU-bound Python holding the GIL, same shape as extract_stage's quality
scoring), THEN one executemany per edge table, THEN the stamp. If the
inserts raise, the exception propagates and the stamp for that batch never
runs -- the claim query offers the same rows again on the next run, and
ON CONFLICT DO NOTHING (see db.insert_citations) makes re-inserting the rows
that already made it in a no-op rather than a duplicate or an error.
"""
from __future__ import annotations

import concurrent.futures
import logging
from dataclasses import dataclass
from datetime import date

from .. import citations, db, throttle
from ..config import Settings

log = logging.getLogger(__name__)

# 2021-01-01 is the source's placeholder for "no decision date known", not a
# real date -- see migration 196's context comment: none of the CH_BGer rows
# it enrolled carried a decision_date at all. Citing it as from_date would
# assert a fact the source never had.
_PLACEHOLDER_DATE = date(2021, 1, 1)

BATCH_SIZE = 500


@dataclass
class CitationsReport:
    decisions: int = 0
    case_refs: int = 0
    statute_refs: int = 0
    failed: int = 0


def _from_date(decision_date):
    if decision_date is None or decision_date == _PLACEHOLDER_DATE:
        return None
    return decision_date


def extract_one(row) -> tuple[list, list]:
    """Pure extraction over one decision's text. Raises whatever
    chpipe.citations raises -- run() is the layer that turns that into a
    per-decision failure instead of aborting the batch."""
    text = row["full_text"] or ""
    return citations.extract_cases(text), citations.extract_statutes(text)


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> CitationsReport:
    report = CitationsReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.cpu_workers) as pool:
            while True:
                throttle.wait_for_capacity(settings.load_ceiling, "citations")
                size = BATCH_SIZE if remaining is None else min(BATCH_SIZE, remaining)
                if size <= 0:
                    break
                rows = db.claim_for_citations(conn, size, spider=spider)
                if not rows:
                    break

                futures = {pool.submit(extract_one, r): r for r in rows}
                case_rows: list[tuple] = []
                statute_rows: list[tuple] = []
                stamped_eclis: list[str] = []
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    ecli = row["ecli"]
                    from_date = _from_date(row["decision_date"])
                    try:
                        case_refs, statute_refs = future.result()
                    except Exception as exc:                    # noqa: BLE001
                        log.error("%s: %s", ecli, exc)
                        report.failed += 1
                        stamped_eclis.append(ecli)
                        continue
                    for ref in case_refs:
                        case_rows.append((ecli, ref.raw, ref.kind, ref.context,
                                          from_date, row["court_code"]))
                    for ref in statute_refs:
                        statute_rows.append((ecli, ref.abbr, ref.article, ref.paragraph,
                                             ref.lang, ref.context, from_date))
                    stamped_eclis.append(ecli)

                # Inserts first, then the stamp -- if the inserts raise, this
                # batch is not stamped and the claim loop picks it up again
                # on the next run. See the module docstring.
                db.insert_citations(conn, case_rows, statute_rows)
                db.stamp_citations(conn, stamped_eclis)

                report.decisions += len(rows)
                report.case_refs += len(case_rows)
                report.statute_refs += len(statute_rows)
                if remaining is not None:
                    remaining -= len(rows)
                log.info("decisions=%d case_refs=%d statute_refs=%d failed=%d",
                         report.decisions, report.case_refs, report.statute_refs,
                         report.failed)
    finally:
        conn.close()
    return report


def main() -> CitationsReport:
    """Entry point. A function, not an `if __name__` block, so the
    CHPIPE_SPIDER contract every stage shares is reachable from a test."""
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None,
                 spider=os.environ.get("CHPIPE_SPIDER") or None)
    log.info("decisions=%d case_refs=%d statute_refs=%d failed=%d",
             result.decisions, result.case_refs, result.statute_refs, result.failed)
    return result


if __name__ == "__main__":
    main()
