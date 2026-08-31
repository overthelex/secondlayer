"""Queue primitives against a real Postgres — a mock cannot validate this SQL."""
import os
import pathlib
import psycopg
import pytest
from chpipe import db

from conftest import apply_migration_200

# Derive repo root from this file's location: services/ch-pipeline/tests/test_db_queue.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
# db.complete() re-queues a row in ch_citation_state (migration 200) on the
# 'extracted' branch and ensures a state row on the 'loaded' one -- needed
# here too, since this file exercises complete() directly with both.

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        # ch_act_article (migration 197's table, which 199 indexes but does
        # not create) and migrations 199 + 200 -- see tests/conftest.py.
        # 200 is what creates ch_citation_state, which db.complete() writes
        # to on every 'extracted' and 'loaded' transition.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        yield c


def _seed(conn, doc_id, stage, spider="ZG_Obergericht", attempts=0):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, attempts) "
        "VALUES (%s,%s,%s,%s,%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, stage, attempts),
    )


def test_claim_returns_only_the_requested_stage(conn):
    _seed(conn, "a", "indexed")
    _seed(conn, "b", "fetched")
    rows = db.claim(conn, "indexed", limit=10)
    assert [r["doc_id"] for r in rows] == ["a"]


def test_claim_honours_the_limit(conn):
    for i in range(5):
        _seed(conn, f"d{i}", "indexed")
    assert len(db.claim(conn, "indexed", limit=2)) == 2


def test_claim_can_filter_by_spider(conn):
    _seed(conn, "a", "indexed", spider="ZG_Obergericht")
    _seed(conn, "b", "indexed", spider="CH_BVGer")
    rows = db.claim(conn, "indexed", limit=10, spider="CH_BVGer")
    assert [r["doc_id"] for r in rows] == ["b"]


def test_claim_skips_rows_that_exhausted_their_attempts(conn):
    _seed(conn, "a", "indexed", attempts=3)
    assert db.claim(conn, "indexed", limit=10) == []


def test_complete_moves_the_row_and_writes_fields(conn):
    _seed(conn, "a", "fetched")
    db.complete(conn, "a", "extracted", text_source="pdf", text_quality=0.91)
    row = conn.execute(
        "SELECT stage, text_source, text_quality, last_error, stage_updated_at "
        "FROM ch_court_decisions WHERE doc_id = 'a'").fetchone()
    assert row[0] == "extracted"
    assert row[1] == "pdf"
    assert abs(row[2] - 0.91) < 1e-6
    assert row[3] is None            # completing clears a previous error
    assert row[4] is not None


def test_fail_increments_attempts_and_keeps_the_stage(conn):
    _seed(conn, "a", "fetched")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_court_decisions WHERE doc_id='a'"
    ).fetchone()
    assert row == ("fetched", 1, "connection reset")


def test_fail_moves_to_failed_on_the_last_attempt(conn):
    _seed(conn, "a", "fetched", attempts=2)
    db.fail(conn, "a", "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("failed", 3)


def test_complete_rejects_reserved_column_last_error(conn):
    _seed(conn, "a", "fetched")
    with pytest.raises(ValueError, match="last_error"):
        db.complete(conn, "a", "extracted", last_error="should not work")


def test_complete_rejects_reserved_column_stage(conn):
    _seed(conn, "a", "fetched")
    with pytest.raises(ValueError, match="stage"):
        db.complete(conn, "a", "extracted", stage="should not work")


def test_complete_rejects_unknown_column(conn):
    _seed(conn, "a", "fetched")
    with pytest.raises(ValueError, match="unknown_col"):
        db.complete(conn, "a", "extracted", unknown_col="should not work")


def test_complete_still_works_with_allowed_columns(conn):
    _seed(conn, "a", "fetched")
    db.complete(conn, "a", "extracted", text_source="pdf", text_quality=0.91)
    row = conn.execute(
        "SELECT stage, text_source, text_quality FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row[0] == "extracted"
    assert row[1] == "pdf"
    assert abs(row[2] - 0.91) < 1e-6


def test_retry_failed_restores_failed_row(conn):
    _seed(conn, "a", "fetched", attempts=2)
    db.fail(conn, "a", "network error", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("failed", 3, "network error")

    count = db.retry_failed(conn, "fetched")
    row = conn.execute(
        "SELECT stage, attempts, last_error, stage_updated_at "
        "FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row[0] == "fetched"
    assert row[1] == 0
    # last_error is deliberately preserved. The README tells the operator to
    # read it before retrying; clearing it on the way out destroys the very
    # evidence that decision was based on. complete() clears it on success.
    assert row[2] == "network error"
    assert row[3] is not None, "a retried row must not look stale to monitoring"
    assert count == 1


def test_retry_failed_respects_spider_filter(conn):
    _seed(conn, "a", "fetched", spider="ZG_Obergericht", attempts=2)
    _seed(conn, "b", "fetched", spider="CH_BVGer", attempts=2)
    db.fail(conn, "a", "error", max_attempts=3)
    db.fail(conn, "b", "error", max_attempts=3)

    count = db.retry_failed(conn, "fetched", spider="CH_BVGer")
    assert count == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='b'").fetchone()[0] == "fetched"
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == "failed"


def test_retry_failed_leaves_non_failed_rows_untouched(conn):
    _seed(conn, "a", "indexed")
    _seed(conn, "b", "fetched", attempts=2)
    db.fail(conn, "b", "error", max_attempts=3)

    count = db.retry_failed(conn, "fetched")
    assert count == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == "indexed"


def test_retry_failed_returns_row_count(conn):
    for i in range(3):
        _seed(conn, f"doc{i}", "fetched", attempts=2)
        db.fail(conn, f"doc{i}", "error", max_attempts=3)

    count = db.retry_failed(conn, "fetched")
    assert count == 3


# --- The rows the queue could hand out but never update ---
#
# claim() had no `doc_id IS NOT NULL` predicate while complete() and fail()
# both key on `WHERE doc_id = %s`, which never matches NULL. Reproduced on a
# scratch database with a legacy-shaped row (ecli set, doc_id NULL): the row
# was claimed, db.fail() was a silent no-op (attempts still 0, last_error
# still NULL, stage still 'indexed'), and the very next claim returned the
# same row again. With no `limit`, `while True` never terminates and the same
# documents are re-fetched forever from a volunteer-run mirror.
#
# This is not hypothetical for legacy rows only: documents withdrawn from the
# entscheidsuche listing are never re-indexed, so they keep doc_id NULL and
# sit at 'indexed' indefinitely.

def _seed_legacy(conn, ecli, stage, spider="CH_BGer"):
    """A row shaped like the 678,165 already on prod: keyed by ecli, no doc_id."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, stage) VALUES (%s,%s,%s)",
        (ecli, spider, stage))


def test_claim_never_hands_out_a_row_it_could_not_update(conn):
    _seed_legacy(conn, "ECLI:CH:CH_BGer:1C_100_2020", "indexed")
    assert db.claim(conn, "indexed", limit=10) == [], (
        "a row with no doc_id cannot be completed or failed, so claiming it "
        "produces an endless re-fetch loop")


def test_claim_still_returns_keyed_rows_alongside_unkeyed_ones(conn):
    _seed_legacy(conn, "ECLI:CH:CH_BGer:legacy", "indexed")
    _seed(conn, "keyed", "indexed")
    assert [r["doc_id"] for r in db.claim(conn, "indexed", limit=10)] == ["keyed"]


def test_unkeyed_count_makes_the_skipped_population_visible(conn):
    """Skipping them silently would trade one invisible failure for another."""
    _seed_legacy(conn, "ECLI:CH:CH_BGer:a", "indexed")
    _seed_legacy(conn, "ECLI:CH:CH_BGer:b", "indexed")
    _seed_legacy(conn, "ECLI:CH:CH_BGer:c", "fetched")
    _seed(conn, "keyed", "indexed")
    assert db.unkeyed_count(conn, "indexed") == 2
    assert db.unkeyed_count(conn, "fetched") == 1
    assert db.unkeyed_count(conn, "indexed", spider="ZG_Obergericht") == 0


def test_complete_raises_when_it_updates_nothing(conn):
    """A keyed write that matches no row is a bug, not a success."""
    with pytest.raises(db.QueueWriteMissed, match="ghost"):
        db.complete(conn, "ghost", "extracted", text_quality=0.9)


def test_fail_raises_when_it_updates_nothing(conn):
    with pytest.raises(db.QueueWriteMissed, match="ghost"):
        db.fail(conn, "ghost", "connection reset", max_attempts=3)


def test_complete_and_fail_still_succeed_for_a_real_row(conn):
    _seed(conn, "a", "fetched")
    db.complete(conn, "a", "extracted", text_quality=0.9)
    db.fail(conn, "a", "boom", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("extracted", 1)


# --- Retry budget, retry delay, and where a row failed ---

def test_complete_resets_the_attempt_budget_for_the_next_stage(conn):
    """attempts is a per-stage budget, not a lifetime one. A row that
    survived two transient fetch retries used to arrive at extract with one
    attempt left for the remaining three stages."""
    _seed(conn, "a", "indexed")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    db.fail(conn, "a", "connection reset", max_attempts=3)
    assert conn.execute(
        "SELECT attempts FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == 2

    db.complete(conn, "a", "fetched", text_source="pdf")
    assert conn.execute(
        "SELECT attempts FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] == 0


def test_a_row_that_just_failed_is_not_offered_again_immediately(conn):
    """Spec section 8's 1/5/30-minute backoff. Without a time predicate the
    same run re-claims a failed row on its very next iteration, so a
    30-second source hiccup burns all three attempts within seconds."""
    _seed(conn, "a", "indexed")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    assert db.claim(conn, "indexed", limit=10) == []


def test_the_row_comes_back_once_the_backoff_has_elapsed(conn):
    _seed(conn, "a", "indexed")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    conn.execute("UPDATE ch_court_decisions SET stage_updated_at = "
                 "now() - interval '2 minutes' WHERE doc_id='a'")
    assert [r["doc_id"] for r in db.claim(conn, "indexed", limit=10)] == ["a"]


def test_the_second_attempt_waits_longer_than_the_first(conn):
    """1 minute, then 5. Two minutes is enough after one failure and not
    enough after two."""
    _seed(conn, "a", "indexed", attempts=1)
    db.fail(conn, "a", "connection reset", max_attempts=5)   # attempts -> 2
    conn.execute("UPDATE ch_court_decisions SET stage_updated_at = "
                 "now() - interval '2 minutes' WHERE doc_id='a'")
    assert db.claim(conn, "indexed", limit=10, max_attempts=5) == []
    conn.execute("UPDATE ch_court_decisions SET stage_updated_at = "
                 "now() - interval '6 minutes' WHERE doc_id='a'")
    assert len(db.claim(conn, "indexed", limit=10, max_attempts=5)) == 1


def test_the_backoff_can_be_switched_off(conn):
    _seed(conn, "a", "indexed")
    db.fail(conn, "a", "connection reset", max_attempts=3)
    assert len(db.claim(conn, "indexed", limit=10, backoff_minutes=())) == 1


def test_a_row_that_never_failed_is_never_delayed(conn):
    _seed(conn, "a", "indexed")
    assert len(db.claim(conn, "indexed", limit=10)) == 1


def test_fail_records_the_stage_the_row_died_in(conn):
    """'failed' is reachable from five places and nothing recorded which, so
    recovery could only send every failure to one caller-chosen stage."""
    _seed(conn, "a", "ocr_pending", attempts=2)
    db.fail(conn, "a", "tesseract crashed", max_attempts=3)
    row = conn.execute(
        "SELECT stage, failed_stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("failed", "ocr_pending")


def test_fail_does_not_record_an_origin_while_attempts_remain(conn):
    _seed(conn, "a", "ocr_pending")
    db.fail(conn, "a", "tesseract crashed", max_attempts=3)
    assert conn.execute(
        "SELECT failed_stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] is None


def test_mark_failed_keeps_the_error_and_the_origin(conn):
    """complete(..., 'failed') cleared last_error as part of its own SET
    list, so two of the three terminal call sites lost the diagnosis."""
    _seed(conn, "a", "fetched")
    db.mark_failed(conn, "a", "html quality 0.31 below 0.55",
                   from_stage="fetched", text_quality=0.31)
    row = conn.execute(
        "SELECT stage, failed_stage, last_error, text_quality "
        "FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row[0] == "failed"
    assert row[1] == "fetched"
    assert "html quality 0.31" in row[2]
    assert abs(row[3] - 0.31) < 1e-6


def test_mark_failed_rejects_a_reserved_column(conn):
    _seed(conn, "a", "fetched")
    with pytest.raises(ValueError, match="last_error"):
        db.mark_failed(conn, "a", "x", from_stage="fetched", last_error="no")


def test_mark_failed_raises_when_it_updates_nothing(conn):
    with pytest.raises(db.QueueWriteMissed, match="ghost"):
        db.mark_failed(conn, "ghost", "x", from_stage="fetched")


def test_retry_failed_sends_each_row_back_where_it_came_from(conn):
    """The README's copy-paste example hardcoded 'indexed', which pushes an
    OCR-terminal row back to the front of the queue and re-runs days of OCR
    on a document that was already read twice."""
    _seed(conn, "fetchfail", "indexed", attempts=2)
    _seed(conn, "ocrfail", "ocr_pending", attempts=2)
    db.fail(conn, "fetchfail", "404", max_attempts=3)
    db.fail(conn, "ocrfail", "tesseract crashed", max_attempts=3)

    assert db.retry_failed(conn) == 2
    stages = dict(conn.execute(
        "SELECT doc_id, stage FROM ch_court_decisions").fetchall())
    assert stages["fetchfail"] == "indexed"
    assert stages["ocrfail"] == "ocr_pending", \
        "an OCR failure must not be sent back to the front of the queue"


def test_retry_failed_clears_the_origin_once_the_row_is_requeued(conn):
    _seed(conn, "a", "fetched", attempts=2)
    db.fail(conn, "a", "boom", max_attempts=3)
    db.retry_failed(conn)
    assert conn.execute(
        "SELECT failed_stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()[0] is None


def test_retry_failed_leaves_rows_with_no_origin_alone(conn):
    """index marks a row failed when the listing offers neither HTML nor
    PDF. It never entered a queue stage, so there is nowhere to send it
    back to -- re-queueing just burns three more attempts against a listing
    that still offers nothing. Re-run `index` for those."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, last_error) "
        "VALUES ('e:n','S','n','failed','no body: listing offers neither html nor pdf')")
    assert db.retry_failed(conn) == 0
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='n'").fetchone()[0] == "failed"


def test_retry_failed_still_honours_an_explicit_stage(conn):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage) "
        "VALUES ('e:n','S','n','failed')")
    assert db.retry_failed(conn, "indexed") == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='n'").fetchone()[0] == "indexed"


def test_failed_by_stage_groups_the_triage_query(conn):
    _seed(conn, "a", "indexed", attempts=2)
    _seed(conn, "b", "indexed", attempts=2)
    _seed(conn, "c", "ocr_pending", attempts=2)
    for doc_id in ("a", "b", "c"):
        db.fail(conn, doc_id, "boom", max_attempts=3)
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage) "
        "VALUES ('e:n','S','n','failed')")
    assert dict(db.failed_by_stage(conn)) == {"indexed": 2, "ocr_pending": 1, None: 1}
