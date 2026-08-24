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
    versions_without_notes: int = 0
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
    "as_reference, bbl_reference, effective_date, source_act_date, raw_note) "
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)")


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
                  r.effective_date, r.source_act_date, r.raw_note) for r in rows])
    return len(rows)


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
                report.versions_without_notes += 1
                continue
            try:
                rows = amendment_notes.extract(stored.encode("utf-8"), lang=lang)
            except Exception as exc:                       # noqa: BLE001
                log.warning("version %s: %s", version_id, exc)
                report.failed += 1
                continue
            if not rows:
                report.versions_without_notes += 1
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
    log.info("versions=%d rows=%d without_notes=%d failed=%d", result.versions,
             result.rows, result.versions_without_notes, result.failed)
    return result


if __name__ == "__main__":
    main()
