import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import load_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_load_stage.py is 3 levels down from the repo root (matches the
# convention already used in tests/test_extract_stage.py).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
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


def _row(conn, doc_id, text, quality, stage="extracted"):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, full_text, "
        "text_quality, stage) VALUES (%s,'S',%s,%s,%s,%s)",
        (f"e:{doc_id}", doc_id, text, quality, stage))


def test_promotes_a_good_extraction_to_loaded(conn, settings):
    _row(conn, "a", "x" * 500, 0.8)
    report = load_stage.run(settings)
    assert report.loaded == 1
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='a'").fetchone()["stage"] == "loaded"


def test_refuses_to_load_a_row_whose_text_vanished(conn, settings):
    """A row can only reach 'extracted' with text; if it has none, something
    upstream is broken and marking it loaded would hide that."""
    _row(conn, "a", None, 0.8)
    report = load_stage.run(settings)
    assert report.loaded == 0
    assert report.skipped_empty == 1
    row = conn.execute(
        "SELECT stage, last_error, failed_stage FROM ch_court_decisions "
        "WHERE doc_id='a'").fetchone()
    assert row["stage"] == "failed"
    assert row["last_error"]
    # And the origin, so retry_failed can send it back to 'extracted' rather
    # than to the front of the queue.
    assert row["failed_stage"] == "extracted"


def test_leaves_other_stages_alone(conn, settings):
    _row(conn, "a", "x" * 500, 0.8, stage="ocr_pending")
    assert load_stage.run(settings).loaded == 0


# --- Guard: one bad row must not abort the batch (same defect class fixed in
# index_stage, fetch_stage and extract_stage) ---

def test_a_db_complete_failure_for_one_row_does_not_abort_the_rest_of_the_batch(
        conn, settings, monkeypatch):
    """load_stage does a per-row length query and two writes (db.complete,
    then the last_error UPDATE). If either of those raises for one row --
    e.g. Postgres rejecting a value the earlier stages let through -- that
    exception must not escape the batch loop and kill the whole run. The
    failing row must be recorded (via db.fail) and counted, and the other
    rows in the same batch must still be loaded."""
    _row(conn, "good1", "x" * 500, 0.8)
    _row(conn, "bad", "x" * 500, 0.8)
    _row(conn, "good2", "x" * 500, 0.8)

    real_complete = load_stage.db.complete

    def flaky_complete(conn_, doc_id, next_stage, **fields):
        if doc_id == "bad":
            raise RuntimeError("simulated write failure")
        return real_complete(conn_, doc_id, next_stage, **fields)

    monkeypatch.setattr(load_stage.db, "complete", flaky_complete)

    # limit=3 caps run() to a single batch: without it the outer while-loop
    # would re-claim "bad" on the next iteration (it never advances past
    # 'extracted' after a failed write) and burn its whole retry budget
    # inside this one run() call, masking the assertion this test makes.
    report = load_stage.run(settings, limit=3)   # must not raise

    rows = {r["doc_id"]: r for r in conn.execute(
        "SELECT doc_id, stage, attempts, last_error FROM ch_court_decisions").fetchall()}

    assert rows["good1"]["stage"] == "loaded"
    assert rows["good2"]["stage"] == "loaded"
    assert rows["bad"]["stage"] == "extracted"      # attempts left, stays in queue
    assert rows["bad"]["attempts"] == 1
    assert rows["bad"]["last_error"]
    assert report.loaded == 2
