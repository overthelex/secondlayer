"""Maintains ch_decision_index (migration 207): one row per decision the
corpus cites, with the inbound-citation aggregates the precedent-status
tools read (cited_by_count, citing-court breadth, first/last citing date).

Differential refresh, not TRUNCATE+rebuild: the aggregate is recomputed
set-based over ch_case_citations (a single GROUP BY -- seconds at the
corpus's ~9M edges), but only rows whose numbers actually changed are
written, and only rows whose inbound edges are gone are deleted. TRUNCATE
would take ACCESS EXCLUSIVE and block the serving reads for the whole
rebuild transaction; a nightly DELETE-all would hand autovacuum ~1.5M dead
rows a day for a table the delta only moves a few thousand rows of.

Self-citations (from_ecli = to_ecli: a decision restating its own docket
number) are excluded here even though the extractor already tries not to
write them -- the aggregate must stay correct even over edges extracted by
an older extractor version, and the predicate costs nothing.

Rows are keyed on the CITED decision's ecli. Only cited decisions get a
row: an absent row means "never cited", and ~1M zero-rows would triple the
table for a value absence already encodes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, throttle
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class DecisionIndexReport:
    """upserted counts rows actually written (new or changed), never rows
    the aggregate merely looked at -- the ON CONFLICT arm's IS DISTINCT
    FROM guard skips unchanged rows so a quiet night reports 0."""
    upserted: int = 0
    removed: int = 0
    total: int = 0


# count(DISTINCT from_court) ignores NULLs, and min/max over all-NULL
# from_date is NULL -- both are what the serving side wants (0 known courts,
# no known citing date), so no COALESCE gymnastics here.
#
# The DO UPDATE arm is guarded by IS DISTINCT FROM over every derived
# column: without it, every nightly run rewrites the whole table just to
# bump refreshed_at, which both bloats the table and makes refreshed_at
# useless as a "when did this row last actually change" signal.
_UPSERT = """
WITH agg AS (
    SELECT to_ecli AS ecli,
           count(*)::int                    AS cited_by_count,
           count(DISTINCT from_court)::int  AS citing_courts,
           min(from_date)                   AS first_citing_date,
           max(from_date)                   AS last_citing_date
      FROM ch_case_citations
     WHERE resolved
       AND to_ecli IS NOT NULL
       AND to_ecli <> from_ecli
     GROUP BY to_ecli
), written AS (
    INSERT INTO ch_decision_index AS i
           (ecli, cited_by_count, citing_courts,
            first_citing_date, last_citing_date)
    SELECT ecli, cited_by_count, citing_courts,
           first_citing_date, last_citing_date
      FROM agg
    ON CONFLICT (ecli) DO UPDATE
       SET cited_by_count    = EXCLUDED.cited_by_count,
           citing_courts     = EXCLUDED.citing_courts,
           first_citing_date = EXCLUDED.first_citing_date,
           last_citing_date  = EXCLUDED.last_citing_date,
           refreshed_at      = now()
     WHERE (i.cited_by_count, i.citing_courts,
            i.first_citing_date, i.last_citing_date)
           IS DISTINCT FROM
           (EXCLUDED.cited_by_count, EXCLUDED.citing_courts,
            EXCLUDED.first_citing_date, EXCLUDED.last_citing_date)
    RETURNING 1
)
SELECT count(*) AS n FROM written
"""

# The anti-join probes idx_ch_case_cit_to (partial on to_ecli IS NOT NULL,
# migration 199) once per index row -- ~1.5M primary-key-sized probes, not a
# scan of the 9M-edge table per row.
_DELETE_STALE = """
DELETE FROM ch_decision_index i
 WHERE NOT EXISTS (
       SELECT 1
         FROM ch_case_citations c
        WHERE c.resolved
          AND c.to_ecli = i.ecli
          AND c.to_ecli <> c.from_ecli)
"""


def run(settings: Settings) -> DecisionIndexReport:
    report = DecisionIndexReport()
    conn = db.connect(settings)
    try:
        with conn.cursor() as cur:
            cur.execute(_UPSERT)
            report.upserted = cur.fetchone()["n"]

            cur.execute(_DELETE_STALE)
            report.removed = cur.rowcount

        report.total = conn.execute(
            "SELECT count(*) AS n FROM ch_decision_index").fetchone()["n"]
    finally:
        conn.close()
    return report


def main() -> DecisionIndexReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 (throttle.NICE_IO): the work is two set-based statements
    executed and waited on inside Postgres, the same shape as
    citations_resolve_stage. No wait_for_capacity(): it is two statements
    and done, nothing claims a growing queue in a pausable loop.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("decision-index upserted=%d removed=%d total=%d",
             result.upserted, result.removed, result.total)
    return result


if __name__ == "__main__":
    main()
