"""Walk each act's editions in date order and write the change log.

Fedlex publishes editions, not amendments. ch_act_change is computed here, and
it is the answer to "which article changed, when" -- the question the flat
table could not express at all.

THE CHANGE LOG COVERS ONLY THE EDITIONS FEDLEX SERVES AS XML, NOT AN ACT'S
FULL HISTORY. Measured directly against the live endpoint for SR 220 (the
Code of Obligations, in force since 1912): Fedlex serves exactly 14 German
XML manifestations for that act, the earliest dated 2021-01-01. The computed
change log for the OR therefore covers 5.75 years, not the 114 it has existed
-- every edition before 2021 exists on Fedlex only as PDF/HTML, which this
pipeline does not parse into articles at all (see versions_stage.py and
fetch_xml_stage.py: the corpus is built only from consolidations that carry
an XML manifestation). This is a Fedlex publishing limit, not a choice this
stage makes, but it is not obvious from the schema or from a query result --
"the amendment history of the OR" reads as complete, and it is not. Any
consumer of ch_act_change needs this stated, not left as a fact only visible
by cross-referencing ch_act_version's own date range.

Editions are compared in date_applicability order, never insertion order: a
corpus that discovered editions out of the order Fedlex published them (a
plausible walk order for versions_stage, which is driven by work batches, not
by date) would otherwise diff a later edition against an earlier one it
happens to have been written after, not the one immediately before it in
force. Languages are diffed separately -- one lang value drives every query in
a run, and diff_articles.diff() is only ever called with two editions of the
same lang -- so a German wording change is never compared against a French
edition of the same date.

Guarding the per-act body: same defect class as acts_stage.run()'s per-row
try/except and parse_akn_stage.run()'s per-version one. One act with
malformed articles (a bad row, a parser exception surfacing late) must not
kill a walk over thousands of others -- the whole per-act body, from reading
its editions through writing every comparison's changes, is wrapped, and a
failure inside it is logged, counted in report.errors, and skipped, so the
walk continues.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import db, diff_articles, throttle
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class DiffReport:
    acts: int = 0
    comparisons: int = 0
    changes: int = 0
    added: int = 0
    modified: int = 0
    repealed: int = 0
    # Change rows a PREVIOUS run wrote for an edition that THIS run no
    # longer produces at all. Not the number of rows _CLEAR_CHANGES deletes
    # (a routine re-run deletes and rewrites the identical set, which says
    # nothing) -- only the ones that would have been left behind as orphans.
    # See _CLEAR_CHANGES below. A non-zero value means the parser or the
    # differ changed its mind about an eId, which is exactly the event that
    # used to leave contradicted history in the table in silence.
    orphaned: int = 0
    # One act whose editions raise (a malformed article, a write error) must
    # not abort the walk over the rest of ch_act. Counted here instead, same
    # shape as acts_stage.ActsReport.errors / parse_akn_stage.ParseReport.failed.
    errors: int = 0


# Every change this run is about to compute for `to_version_id` replaces
# every change a previous run computed for it. Deleting first, rather than
# relying on the upsert alone, is the same argument
# parse_akn_stage.store_articles() makes for itself one file over: "an
# upsert-by-e_id would leave orphaned rows behind whenever the parser starts
# recognising an eId it used to miss, or stops recognising one it used to
# produce".
#
# The upsert below corrects rows the new run re-emits. It cannot touch a
# (to_version_id, e_id) pair the new run no longer emits at all -- and this
# branch went through five rounds of parser and differ improvements, each of
# which changes exactly that set. The stale rows then sit in ch_act_change
# looking like computed history, with nothing counting them.
#
# Keyed on to_version_id alone, not on the (from, to) pair: the whole change
# set of an edition is recomputed here, and keying on the pair would strand
# the rows written when a different edition was that edition's predecessor
# -- which is precisely what happens when a newly discovered edition lands
# between two existing ones.
#
# RETURNING e_id so the report can name the orphans specifically. The delete
# removes every row for the edition either way; what is worth counting is
# the subset this run does not put back, because a re-run that rewrites the
# identical set is not news and would otherwise drown the signal.
_CLEAR_CHANGES = "DELETE FROM ch_act_change WHERE to_version_id = %s RETURNING e_id"

_UPSERT_CHANGE = """
INSERT INTO ch_act_change
    (act_id, lang, from_version_id, to_version_id, e_id,
     article_number, change_type, date_applicability)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (to_version_id, e_id) DO UPDATE SET
    from_version_id    = EXCLUDED.from_version_id,
    change_type        = EXCLUDED.change_type,
    article_number     = EXCLUDED.article_number,
    date_applicability = EXCLUDED.date_applicability
"""


def _articles(conn, version_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT e_id, article_number, text FROM ch_act_article "
        "WHERE version_id = %s ORDER BY ordinal", (version_id,)).fetchall()]


def run(settings: Settings, lang: str = "de", act_id: int | None = None) -> DiffReport:
    report = DiffReport()
    conn = db.connect(settings)
    try:
        sql = ("SELECT DISTINCT act_id FROM ch_act_version "
               "WHERE lang = %s AND stage = 'parsed'")
        params: list = [lang]
        if act_id is not None:
            sql += " AND act_id = %s"
            params.append(act_id)
        sql += " ORDER BY act_id"
        acts = [r["act_id"] for r in conn.execute(sql, params).fetchall()]

        for current_act in acts:
            # Spec section 8's dynamic backpressure. This stage walks the
            # whole corpus holding two article sets per comparison, on the
            # same eight cores as live traffic, so it takes the same guard
            # as parse-akn. Checked before starting an act rather than
            # before each comparison: an act is this stage's unit of work,
            # and abandoning one half-diffed is what the per-act guard
            # below exists to avoid.
            throttle.wait_for_capacity(settings.load_ceiling, "diff")
            # The whole per-act body is guarded, not just one query inside
            # it: a malformed row can surface from the versions SELECT, from
            # _articles(), from diff_articles.diff() itself, or from the
            # write -- and any of those must count as one failed act, not
            # kill the walk over the rest of ch_act. See the module
            # docstring.
            try:
                versions = conn.execute(
                    "SELECT version_id, date_applicability FROM ch_act_version "
                    "WHERE act_id = %s AND lang = %s AND stage = 'parsed' "
                    "ORDER BY date_applicability, version_id",
                    (current_act, lang)).fetchall()
                previous = None
                for version in versions:
                    if previous is None:
                        previous = version
                        continue
                    changes = diff_articles.diff(
                        _articles(conn, previous["version_id"]),
                        _articles(conn, version["version_id"]))
                    report.comparisons += 1
                    # The connection is autocommit, so without this block
                    # the delete would commit on its own and a hard kill
                    # before the writes would leave the edition's change log
                    # empty and committed -- a state the pre-batch code
                    # could not reach. One explicit transaction makes the
                    # replacement atomic; the surrounding per-act guard
                    # still turns any failure into one failed act.
                    with conn.transaction():
                        stale = {r["e_id"] for r in conn.execute(
                            _CLEAR_CHANGES, (version["version_id"],)).fetchall()}
                        for change in changes:
                            conn.execute(_UPSERT_CHANGE, (
                                current_act, lang, previous["version_id"],
                                version["version_id"], change.e_id,
                                change.article_number, change.change_type,
                                version["date_applicability"]))
                    # Counted only once the replacement is durable: a
                    # rolled-back pair must not inflate the report.
                    report.orphaned += len(stale - {c.e_id for c in changes})
                    for change in changes:
                        report.changes += 1
                        setattr(report, change.change_type,
                                getattr(report, change.change_type) + 1)
                    previous = version
            except Exception as exc:                        # noqa: BLE001
                log.error("act %s: %s", current_act, exc)
                report.errors += 1
                continue

            report.acts += 1
            if report.acts % 200 == 0:
                log.info("acts=%d changes=%d orphaned=%d", report.acts,
                         report.changes, report.orphaned)
    finally:
        conn.close()
    return report


def main() -> DiffReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 per spec section 8: CPU-bound, and it runs over the whole
    corpus. The capacity wait is in run(), before each act; renice is here,
    because os.nice() is irreversible for a non-root process.
    """
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(), lang=os.environ.get("CHPIPE_LANG") or "de")
    log.info("acts=%d comparisons=%d changes=%d (added=%d modified=%d repealed=%d) "
             "orphaned=%d errors=%d", result.acts, result.comparisons,
             result.changes, result.added, result.modified, result.repealed,
             result.orphaned, result.errors)
    if result.orphaned:
        log.warning("ORPHANED: %d change row(s) a previous run wrote are no "
                    "longer produced and have been removed -- the parser or "
                    "the differ changed its mind about those articles. Not an "
                    "error, but the number to read after any parser change.",
                    result.orphaned)
    return result


if __name__ == "__main__":
    main()
