"""jolux:basicAct links between a Classified Compilation entry (ch_act) and
the Official Compilation act (ch_as_act) that established it.

This is NOT an amendment relation -- Fedlex publishes none. Verified by
enumerating every predicate on jolux:Act and jolux:ConsolidationAbstract:
what exists is jolux:basicAct (establishment), jolux:rectifies and
jolux:isFollowingAct, none of which is "amends". basicAct answers "which AS
act created this SR entry", nothing more; the amendment history this corpus
actually has lives in ch_act_change (the computed edition diff, diff_stage)
and ch_article_provenance (recovered from AKN footnotes, provenance_stage).
See migration 198's own comment for the same distinction at the schema
level.

Depends on both acts_stage and as_bbl_stage having already run: a
basicAct row this stage cannot resolve on either end is not written, and is
counted (missing_act / missing_as) rather than silently dropped, so a
materially low link count is diagnosable against the discovery walks it
depends on instead of looking like a healthy, small corpus.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, throttle
from .. import fedlex_queries as fq
from ..config import Settings
from ..sparql import DEFAULT_PAGE_SIZE, SparqlClient

log = logging.getLogger(__name__)


@dataclass
class LinkReport:
    """One row of BASIC_ACTS lands in exactly one counter, and

        linked + already_linked + missing_act + missing_as + missing_both == seen

    is an invariant, not an aspiration -- test_the_counters_partition_the_walk
    asserts it. The counters existed before without `already_linked` or
    `missing_both`, and a row missing on BOTH ends incremented two of them, so
    an operator adding them up to cross-check a run found a total larger than
    the walk on exactly the runs worth diagnosing: the ones after a partial
    acts_stage or as_bbl_stage.
    """
    seen: int = 0
    linked: int = 0
    # Both ends resolved and the link was already there -- a re-run, not a
    # finding. Counted so the sum above closes.
    already_linked: int = 0
    # The CC act (ch_act.eli_work_uri) this row names does not exist locally
    # -- acts_stage has not discovered it (yet, or ever).
    missing_act: int = 0
    # The AS/BBl act (ch_as_act.eli_uri) this row names does not exist
    # locally -- as_bbl_stage has not discovered it (yet, or ever).
    missing_as: int = 0
    # Neither end resolved. Its own counter rather than one increment to each
    # of the two above: which walk to re-run is the question this report
    # exists to answer, and "both" is a different answer from either.
    missing_both: int = 0


_LINK = """
INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type)
SELECT a.act_id, s.as_id, 'basic_act'
  FROM ch_act a, ch_as_act s
 WHERE a.eli_work_uri = %(work)s AND s.eli_uri = %(basic)s
ON CONFLICT (act_id, as_id, relation_type) DO NOTHING
"""

_ACT_EXISTS = "SELECT 1 FROM ch_act WHERE eli_work_uri = %s"
_AS_EXISTS = "SELECT 1 FROM ch_as_act WHERE eli_uri = %s"


def link(conn, row: dict) -> int:
    """Insert one basicAct link. Returns 1 when a new row was written, 0
    otherwise -- which covers two different cases the caller cannot tell
    apart from this return value alone: the link already existed (fine,
    ON CONFLICT DO NOTHING), or one of the two acts it names is not yet
    known locally (relation_type's CHECK constraint only allows values this
    stage always supplies, so there is nothing else that can make the
    INSERT itself fail). run() below tells the two apart for reporting."""
    return conn.execute(_LINK, {"work": row["work"],
                                "basic": row["basicAct"]}).rowcount


def run(settings: Settings, page_size: int = DEFAULT_PAGE_SIZE) -> LinkReport:
    """Keyset-walk BASIC_ACTS and link every row it can. See fedlex_queries
    .BASIC_ACTS's own comment for the live count this task actually
    measured (17,055, cross-checked two ways) against the 69,190 figure
    recorded elsewhere in this codebase -- reported, not reconciled here.
    """
    report = LinkReport()
    client = SparqlClient(fq.ENDPOINT)
    conn = db.connect(settings)
    try:
        seen = 0
        for row in client.keyset(fq.BASIC_ACTS, key="work", page_size=page_size):
            if link(conn, row):
                report.linked += 1
            else:
                # Zero rows written: either already linked (both ends exist,
                # nothing to report) or one end is genuinely missing. Only
                # the missing case is worth a second query -- ordering the
                # check that way means the common "already linked" re-run
                # case never pays for it.
                act_known = conn.execute(_ACT_EXISTS,
                                         (row["work"],)).fetchone() is not None
                as_known = conn.execute(_AS_EXISTS,
                                        (row["basicAct"],)).fetchone() is not None
                # One row, one counter -- see LinkReport's docstring for why
                # the both-missing case is not two increments.
                if act_known and as_known:
                    report.already_linked += 1
                elif not act_known and not as_known:
                    report.missing_both += 1
                elif not act_known:
                    report.missing_act += 1
                else:
                    report.missing_as += 1
            seen += 1
            report.seen = seen
            if seen % 10000 == 0:
                log.info("basic-act seen=%d linked=%d already=%d missing_act=%d "
                         "missing_as=%d missing_both=%d", seen, report.linked,
                         report.already_linked, report.missing_act,
                         report.missing_as, report.missing_both)
    finally:
        conn.close()
        client.close()
    return report


def main() -> LinkReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 (throttle.NICE_IO): a short join over already-discovered acts,
    bounded by BASIC_ACTS's own row count (see fedlex_queries.py), not a
    multi-hour CPU stage -- so it takes the same I/O priority as as_bbl,
    acts and versions, not throttle.NICE_CPU. No wait_for_capacity(): the
    walk is bounded by Fedlex's response times and the size of BASIC_ACTS
    itself, not by this machine's cores.
    """
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_IO)
    result = run(Settings.from_env())
    log.info("seen=%d linked=%d already=%d missing_act=%d missing_as=%d "
             "missing_both=%d", result.seen, result.linked,
             result.already_linked, result.missing_act, result.missing_as,
             result.missing_both)
    return result


if __name__ == "__main__":
    main()
