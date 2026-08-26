"""Extraction stage: run chpipe.citations over every `loaded` decision's
full text and write the raw edges it finds -- BGE/docket/ECLI case
references into ch_case_citations, article references into
ch_legislation_citations.

This is extraction only. Nothing here resolves a citation to the row it
points at (to_ecli / article_id stay NULL) -- that is a later stage's job,
over the raw edges this one produces. See chpipe/citations.py for the
extraction rules themselves.

Queue model: unlike the stage-column queue in db.claim(), a decision does
not move off `loaded` here -- ch_citation_state.extracted_at (migration 200)
is a flag, stamped once a decision's text has been scanned SUCCESSFULLY.
ch_court_decisions itself is only ever READ by this stage: it is 19 GB with
a 7.6 GB full-text GIN, and a flag column on it could not be written without
rewriting the row into every one of those indexes (migration 200's header
carries the measurement).

A decision whose extraction raises keeps its old edges, is NOT stamped, and
spends one attempt: db.fail_citations() increments ch_citation_state.attempts
and stores the reason in ch_citation_state.last_error. (That is this stage's
own last_error, on its own table -- the stage-column queue's last_error on
ch_court_decisions belongs to db.fail()/db.mark_failed() and is still not
touched here.) Once a decision reaches settings.max_attempts the claim stops
offering it, so a text that raises every night is retired instead of being
re-read forever; the exception is logged with the decision's ecli and counted
in `failed` each time.

Within a run the attempt counter is not enough on its own: the claim query
keeps offering a failure until the run's own increments are visible to the
NEXT claim, and with max_attempts of 3 that is still two more re-extractions
of the same poison text ahead of everything behind it. So this run also
remembers the eclis that raised and skips them in later batches; a batch that
is nothing but rows this run already failed ends the run with a warning
naming the count.

Per batch the order is: extract everything (in a thread pool -- this is
CPU-bound Python holding the GIL, same shape as extract_stage's quality
scoring), THEN one delete per edge table for the decisions that extracted
CLEANLY, THEN one executemany per edge table, THEN the stamp for those same
decisions. If either write raises, the exception propagates and the stamp
for that batch never runs -- the claim query offers the same rows again on
the next run, which repeats the same delete-then-insert from scratch, and ON
CONFLICT DO NOTHING (see db.insert_citations) makes re-inserting the rows
that already made it in a no-op rather than a duplicate or an error.

The delete is what makes a re-extraction a replacement instead of an
addition: a decision is only re-claimed after complete(-> 'extracted')
re-queued it in ch_citation_state, i.e. after it was given NEW text, and an edge the old
text produced but the new one does not would otherwise survive forever
(nothing collides with it, so ON CONFLICT never sees it). See
db.delete_citations. Scoping the delete to the decisions that extracted
cleanly is the other half of that: a re-extraction whose NEW text raises
would otherwise have its old edges deleted with nothing to put back, and
(stamped) never be claimed again -- silent, permanent loss of real
citations.

Memory: claim_for_citations() selects full_text for the whole batch at
once, so a batch is worth roughly (batch size x mean decision length) of
resident Python strings -- at the default 200 rows that is tens of MB on
Swiss full texts, and long ones can push it further. `CHPIPE_CIT_BATCH`
overrides the batch size for a host where that is too much (or too little);
the queue is a flag on a narrow side table, so a smaller batch costs nothing
but extra round-trips.
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
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

# Rows claimed (and therefore full texts held in memory) per batch. See the
# module docstring; CHPIPE_CIT_BATCH overrides it.
BATCH_SIZE = 200


def _batch_size() -> int:
    """The configured batch size. Read per run, not at import, so a test can
    set CHPIPE_CIT_BATCH around a call. A non-numeric or non-positive value
    is a typo in an operator's env, not a request for an infinite batch --
    fall back to the default and say so."""
    raw = (os.environ.get("CHPIPE_CIT_BATCH") or "").strip()
    if not raw:
        return BATCH_SIZE
    try:
        size = int(raw)
    except ValueError:
        size = 0
    if size <= 0:
        log.warning("CHPIPE_CIT_BATCH=%r is not a positive integer; using %d",
                    raw, BATCH_SIZE)
        return BATCH_SIZE
    return size


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
    cases = citations.extract_cases(text)
    # A decision's masthead repeats its own docket ("Urteil 4A_22/2017 vom ...")
    # and a BGE prints its own key; that is not a citation. Measured on the first
    # full backfill: 3 of 42 sampled docket edges were the citing decision itself.
    own = (row.get("docket_number") or "").strip()
    if own:
        cases = [c for c in cases if c.raw != own]
    return cases, citations.extract_statutes(text)


def run(settings: Settings, limit: int | None = None,
        spider: str | None = None) -> CitationsReport:
    report = CitationsReport()
    conn = db.connect(settings)
    remaining = limit
    batch = _batch_size()
    # Decisions whose extraction raised in THIS run. They are left unstamped
    # (so a later run retries them) and therefore keep coming back from the
    # claim query -- skipping them here is what keeps this run moving past
    # them instead of re-extracting the same poison until the process is
    # killed. See the module docstring.
    poisoned: set[str] = set()
    try:
        with concurrent.futures.ThreadPoolExecutor(settings.cpu_workers) as pool:
            while True:
                throttle.wait_for_capacity(settings.load_ceiling, "citations")
                size = batch if remaining is None else min(batch, remaining)
                if size <= 0:
                    break
                rows = db.claim_for_citations(
                    conn, size, spider=spider,
                    max_attempts=settings.max_attempts)
                if not rows:
                    break
                rows = [r for r in rows if r["ecli"] not in poisoned]
                if not rows:
                    log.warning("citations: the queue head is nothing but the "
                                "%d decision(s) whose extraction failed this "
                                "run; stopping", len(poisoned))
                    break

                futures = {pool.submit(extract_one, r): r for r in rows}
                case_rows: list[tuple] = []
                statute_rows: list[tuple] = []
                stamped_eclis: list[str] = []
                failures: list[tuple[str, str]] = []
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    ecli = row["ecli"]
                    from_date = _from_date(row["decision_date"])
                    try:
                        case_refs, statute_refs = future.result()
                    except Exception as exc:                    # noqa: BLE001
                        # Not stamped and not deleted: this decision keeps
                        # whatever edges it already had, and the next run
                        # gets to try again on the same text -- until its
                        # attempts run out.
                        log.error("%s: %s", ecli, exc)
                        report.failed += 1
                        poisoned.add(ecli)
                        failures.append((ecli, f"{type(exc).__name__}: {exc}"))
                        continue
                    for ref in case_refs:
                        case_rows.append((ecli, ref.raw, ref.kind, ref.context,
                                          from_date, row["court_code"]))
                    for ref in statute_refs:
                        statute_rows.append((ecli, ref.abbr, ref.article, ref.paragraph,
                                             ref.lang, ref.context, from_date))
                    stamped_eclis.append(ecli)

                # Delete, then insert, then stamp -- if either write raises,
                # this batch is not stamped and the claim loop picks it up
                # again on the next run, re-deleting and re-inserting from
                # scratch. Scoped to the decisions that extracted cleanly:
                # a failed one must keep the edges it already has. See the
                # module docstring.
                # The failures first, and on their own table: a poison
                # text must spend its attempt even if the edge writes below
                # go on to raise, otherwise a batch that fails on write
                # re-reads the same text on every run with the counter
                # stuck at zero.
                db.fail_citations(conn, failures)
                db.delete_citations(conn, stamped_eclis)
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
