"""AKN XML -> ch_act_article rows plus a plain-text rendering of the edition.

Reads ch_act_version.akn_xml back out of Postgres as a Python str (a `text`
column round-trips through psycopg as str, not bytes) and re-encodes it as
UTF-8 before handing it to chpipe.akn. That re-encode is only safe because
of what fetch_xml_stage wrote in the first place: it re-serialises every
document through lxml with an explicit UTF-8 declaration before storing it
(see fetch_xml_stage's module docstring), so the declared encoding inside
the text this stage reads back always matches the UTF-8 bytes it produces
here. Without that normalisation at write time, a document that declared a
non-UTF-8 encoding would round-trip as a str correctly, but re-encoding it
as UTF-8 and handing it to a parser that honours the (still non-UTF-8)
prolog would double-decode the text -- the same class of corruption
fetch_stage.py's to_utf8() exists to prevent on the court-decisions side.
Conclusion: the round trip through the text column does not change the
bytes the parser sees, precisely because fetch_xml_stage already normalised
the encoding declaration before the column was ever written.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .. import akn, db, throttle
from ..config import Settings

log = logging.getLogger(__name__)


@dataclass
class ParseReport:
    parsed: int = 0
    articles: int = 0
    empty: int = 0
    failed: int = 0
    # (act_id, lang) for every edition this run actually promoted to
    # 'parsed'. A supervised backfill has no use for it -- it runs `diff`
    # and `provenance` over the whole corpus afterwards anyway -- but the
    # nightly delta does: those two stages and project-legacy are what turn
    # a newly parsed edition into a change log, a provenance record and a
    # served row, and without knowing WHICH acts moved the delta would have
    # to re-walk all 12,033 editions every night to find out.
    acts: set[tuple[int, str]] = field(default_factory=set)


# Named so a test can break it the same way test_provenance_stage.py breaks
# provenance_stage._INSERT and test_diff_stage.py breaks
# diff_stage._UPSERT_CHANGE: monkeypatch this to bad SQL and watch the
# transaction below roll back cleanly.
_INSERT = (
    "INSERT INTO ch_act_article (version_id, e_id, article_number, "
    "marginal_note, text, ordinal, parent_e_id, notes) "
    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)")

# Named for the same reason as _INSERT: it is the third statement inside the
# transaction below, and "article_count rolls back with the rows it counts"
# is only provable by a test that can break this one specifically.
_SET_COUNT = "UPDATE ch_act_version SET article_count = %s WHERE version_id = %s"


def store_articles(conn, version_id: int, articles: list[akn.Article]) -> int:
    """Replace this version's articles. Replace rather than upsert: an
    edition's XML is immutable once fetched, so the only reason to parse it
    twice is that the *parser* changed -- and when that happens, every row
    from the old parse is stale, not just the ones whose e_id changed. An
    upsert-by-e_id would leave orphaned rows behind whenever the parser
    starts recognising an eId it used to miss, or stops recognising one it
    used to produce, so this deletes the version's rows outright and
    reinserts the full set inside the same call.

    db.connect() opens the connection with autocommit=True, so an unguarded
    DELETE would commit on its own: a hard kill between the delete and the
    inserts would leave the edition with no articles at all, committed, and
    article_count still claiming the old number -- a state the code could
    not otherwise reach, and one that reads as "Fedlex publishes an empty
    act" rather than as damage. This exact defect was found and closed in
    diff_stage at 323c0d83 (see its `with conn.transaction():` block and
    comment) and again in provenance_stage.store(); wrapping the delete, the
    inserts AND the article_count write in one explicit transaction on the
    autocommit connection gives store_articles() the same all-or-nothing
    replacement. article_count is inside the block deliberately: it is a
    statement ABOUT the rows this call writes, so a count that survived a
    rolled-back insert would be a lie of exactly the kind the rest of this
    module's counters exist to prevent.
    """
    with conn.transaction():
        conn.execute("DELETE FROM ch_act_article WHERE version_id = %s", (version_id,))
        with conn.cursor() as cur:
            cur.executemany(
                _INSERT,
                [(version_id, a.e_id, a.article_number, a.marginal_note, a.text,
                  a.ordinal, a.parent_e_id, list(a.notes)) for a in articles])
        conn.execute(_SET_COUNT, (len(articles), version_id))
    return len(articles)


def run(settings: Settings, limit: int | None = None) -> ParseReport:
    report = ParseReport()
    conn = db.connect(settings)
    remaining = limit
    try:
        while True:
            size = 100 if remaining is None else min(100, remaining)
            if size <= 0:
                break
            # Spec section 8's dynamic backpressure, on the CPU stage of
            # the legislation half: 12,033 lxml parses on eight cores shared
            # with live traffic. Renicing alone only decides who wins a
            # contended core; it does not stop this loop taking on new work
            # while the box is already busy. Checked before CLAIMING, not
            # per edition, so work in flight finishes rather than being
            # abandoned half-done.
            throttle.wait_for_capacity(settings.load_ceiling, "parse-akn")
            # backoff_minutes passed explicitly -- see fetch_xml_stage's
            # claim for what its absence silently disabled.
            rows = db.claim_versions(
                conn, "fetched", limit=size,
                max_attempts=settings.max_attempts,
                backoff_minutes=settings.retry_backoff_minutes)
            if not rows:
                break
            for row in rows:
                # One bad edition -- a parser exception, a write failure --
                # must not abort a run over 12,033 of them. Same per-item
                # guard as extract_stage.run(): the whole per-row body is
                # wrapped, not just the parse call, so a failure on the
                # store_articles()/complete_version() write is caught the
                # same way as a failure inside chpipe.akn.
                try:
                    stored = conn.execute(
                        "SELECT akn_xml FROM ch_act_version WHERE version_id = %s",
                        (row["version_id"],)).fetchone()["akn_xml"]
                    if not stored:
                        db.fail_version(conn, row["version_id"], "no akn_xml",
                                        settings.max_attempts)
                        report.failed += 1
                        continue
                    # See the module docstring for why re-encoding as UTF-8
                    # here is safe given how fetch_xml_stage normalised the
                    # document before writing this column.
                    payload = stored.encode("utf-8")
                    # One parse, both products. parse_articles() and
                    # plain_text() each ran their own fromstring() and their
                    # own note-strip walk over the same document, roughly
                    # doubling the cost of the stage with the least headroom.
                    articles, text = akn.parse_edition(payload)
                    store_articles(conn, row["version_id"], articles)
                    db.complete_version(conn, row["version_id"], "parsed",
                                        full_text=text)
                except Exception as exc:                        # noqa: BLE001
                    log.error("version %s: %s", row["version_id"], exc)
                    try:
                        db.fail_version(conn, row["version_id"], f"{exc}",
                                        settings.max_attempts)
                    except Exception as fail_exc:
                        log.error("version %s: also failed recording the "
                                  "failure: %s", row["version_id"], fail_exc)
                    report.failed += 1
                    continue
                report.parsed += 1
                report.acts.add((row["act_id"], row["lang"]))
                report.articles += len(articles)
                if not articles:
                    report.empty += 1
            if remaining is not None:
                remaining -= len(rows)
            log.info("parsed=%d articles=%d empty=%d failed=%d", report.parsed,
                     report.articles, report.empty, report.failed)
    finally:
        conn.close()
    return report


def main() -> ParseReport:
    """Entry point. A function, not an `if __name__` block -- see
    tests/test_entry_points.py.

    nice 10 per spec section 8: this is a CPU stage, 12,033 lxml parses. The
    capacity wait lives in run(), before each claim; renice lives here,
    because os.nice() is irreversible for a non-root process and a run()
    that reniced would permanently drag down every caller that imports the
    module -- the test suite included.
    """
    import os
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    throttle.renice(throttle.NICE_CPU)
    result = run(Settings.from_env(),
                 limit=int(os.environ["CHPIPE_LIMIT"]) if os.environ.get("CHPIPE_LIMIT") else None)
    log.info("parsed=%d articles=%d empty=%d failed=%d", result.parsed,
             result.articles, result.empty, result.failed)
    return result


if __name__ == "__main__":
    main()
