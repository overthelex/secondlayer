"""Turn the AKN footnotes already in ch_act_version.akn_xml into provenance rows.

Downloads nothing: Plan 2 fetched these files once, and re-fetching 12,033
of them to read their footnotes would be load on Fedlex for no new bytes.
amendment_notes.extract() does the actual parsing (see that module's
docstring for why Fedlex publishes no "amends" relation and this and the
computed edition diff, chpipe/diff_articles.py via diff_stage, are the only
two sources of amendment history that exist for this corpus); this stage is
just the walk over ch_act_version and the write.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import amendment_notes, db, throttle
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ProvenanceReport:
    versions: int = 0
    rows: int = 0
    # An edition whose akn_xml holds no amendment note at all -- the normal
    # shape for a never-amended act. Its stale rows, if any, ARE cleared:
    # see run().
    versions_without_notes: int = 0
    # An edition with no akn_xml at all: a hole in the CORPUS, not a quiet
    # act, and the two were one counter until an operator could not tell a
    # fetch gap from a law nobody has touched. Its existing rows are left
    # alone -- this stage has no evidence about them either way.
    versions_without_xml: int = 0
    # Editions whose stale provenance this run deleted because the corrected
    # parse produced nothing. Zero on a steady-state night; non-zero after a
    # parser fix is exactly what says the fix reached the stored rows.
    cleared: int = 0
    # A version whose akn_xml raised out of amendment_notes.extract() --
    # malformed XML, an unexpected shape -- must not abort the walk over the
    # rest of the corpus. Same defect class as parse_akn_stage.ParseReport
    # .failed and diff_stage.DiffReport.errors: counted and skipped, not
    # left to kill the run.
    failed: int = 0


# Named so a test can break it the same way test_diff_stage.py breaks
# diff_stage._UPSERT_CHANGE: monkeypatch this to bad SQL and watch the
# transaction below roll back cleanly.
_INSERT = (
    "INSERT INTO ch_article_provenance (version_id, e_id, action, "
    "as_reference, bbl_reference, effective_date, source_act_date, raw_note, "
    "anchor_level, container_articles) "
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)")


def store(conn, version_id: int, rows: list[amendment_notes.Provenance]) -> int:
    """Replace this version's provenance rows.

    db.connect() opens the connection with autocommit=True, so an unguarded
    DELETE would commit on its own: a hard kill between the delete and the
    inserts would leave the version's provenance empty and committed -- a
    state the code could not otherwise reach. This exact defect was found
    and closed in diff_stage at 323c0d83 (see its `with conn.transaction():`
    block and comment); wrapping both statements in one explicit
    transaction on the autocommit connection gives store() the same
    all-or-nothing replacement.
    """
    with conn.transaction():
        conn.execute("DELETE FROM ch_article_provenance WHERE version_id = %s",
                     (version_id,))
        with conn.cursor() as cur:
            cur.executemany(
                _INSERT,
                [(version_id, r.e_id, r.action, r.as_reference, r.bbl_reference,
                  r.effective_date, r.source_act_date, r.raw_note,
                  r.anchor_level, r.container_articles) for r in rows])
    return len(rows)


def clear(conn, version_id: int) -> int:
    """Delete this version's provenance rows; return how many there were.

    Separate from store() so the count is taken by the DELETE itself rather
    than by a SELECT that could race it, and so store()'s contract (rows
    written) stays what every caller already reads it as.
    """
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM ch_article_provenance WHERE version_id = %s",
                (version_id,))
            return cur.rowcount


def run(settings: Settings, lang: str = "de",
        limit: int | None = None) -> ProvenanceReport:
    report = ProvenanceReport()
    conn = db.connect(settings)
    try:
        sql = ("SELECT version_id FROM ch_act_version "
               "WHERE lang = %s AND stage = 'parsed' ORDER BY version_id")
        params: list = [lang]
        if limit:
            sql += " LIMIT %s"
            params.append(limit)
        version_ids = [r["version_id"] for r in conn.execute(sql, params).fetchall()]

        for version_id in version_ids:
            # Spec section 8's dynamic backpressure, same shape as
            # parse_akn_stage's: a full-corpus lxml walk over ~12,033
            # TOASTed akn_xml payloads on eight cores shared with live
            # traffic. Checked before claiming EACH version, not once at
            # startup -- see throttle.py's docstring for why "it is only a
            # few hours" was already the wrong call twice.
            throttle.wait_for_capacity(settings.load_ceiling, "provenance")
            stored = conn.execute(
                "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                (version_id,)).fetchone()["akn_xml"]
            if not stored:
                # NOT cleared. A missing akn_xml is an absence of evidence,
                # not evidence of absence: whatever rows this version holds
                # were written when the XML was there, and deleting them
                # because of an unrelated fetch gap would destroy a good
                # parse. Counted separately so the gap is visible.
                report.versions_without_xml += 1
                continue
            try:
                rows = amendment_notes.extract(stored.encode("utf-8"), lang=lang)
            except Exception as exc:                       # noqa: BLE001
                log.warning("version %s: %s", version_id, exc)
                report.failed += 1
                continue
            if not rows:
                # A parse that yields nothing is a RESULT, and store() is the
                # only thing that deletes -- so skipping it here left the
                # previous run's rows standing while the report called the
                # night clean. That is this stage's recovery path after any
                # parser fix that tightens a keep-rule: re-running must be
                # able to REMOVE a row it now knows is wrong, not only add.
                report.versions_without_notes += 1
                if clear(conn, version_id):
                    report.cleared += 1
                continue
            report.rows += store(conn, version_id, rows)
            report.versions += 1
            if report.versions % 500 == 0:
                log.info("versions=%d rows=%d", report.versions, report.rows)
    finally:
        conn.close()
    return report


def main() -> ProvenanceReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 per spec section 8: this is the CPU walk parse_akn_stage already
    takes that priority for, over the same corpus. The capacity wait lives
    in run(), before claiming each version; renice lives here, because
    os.nice() is irreversible for a non-root process and a run() that
    reniced would permanently drag down every caller that imports the
    module -- the test suite included.
    """
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    # run-stage.sh exports CHPIPE_LANG unconditionally, empty when no
    # language was given on its command line, so "" must not be treated as
    # a language -- the same shape diff_stage.main() already guards against.
    result = run(Settings.from_env(), lang=os.environ.get("CHPIPE_LANG") or "de")
    log.info("versions=%d rows=%d without_notes=%d cleared=%d "
             "without_xml=%d failed=%d",
             result.versions, result.rows, result.versions_without_notes,
             result.cleared, result.versions_without_xml, result.failed)
    return result


if __name__ == "__main__":
    main()
