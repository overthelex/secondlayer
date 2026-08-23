"""Queue primitives against a real Postgres — a mock cannot validate this SQL."""
import os
import pathlib
import psycopg
import pytest
from chpipe import db

MIGRATION = pathlib.Path("mcp_backend/src/migrations/196_ch_court_pipeline.sql")

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
        "SELECT stage, attempts, last_error FROM ch_court_decisions WHERE doc_id='a'").fetchone()
    assert row == ("fetched", 0, None)
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
