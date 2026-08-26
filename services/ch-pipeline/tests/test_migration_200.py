"""Applies migration 200 to a scratch database. A mocked DB cannot validate SQL.

200 moves the citation stage's bookkeeping off ch_court_decisions (19 GB, 7.6
GB full-text GIN, where the flag sat inside an index predicate and every
stamp was a non-HOT row rewrite) into ch_citation_state. The seed is the part
worth pinning: it copies the EXISTING stamps rather than starting everything
at NULL, because starting at NULL would enqueue the whole 1.22M-decision
corpus for a multi-hour re-extraction the first time the nightly delta ran.
"""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import MIGRATION_200, apply_migration_199, apply_migration_200

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    """Migration 199's world: the decisions table with its
    citations_extracted_at column and the partial index 200 retires, and no
    ch_citation_state yet. Each test seeds its own rows and applies 200
    itself -- the seed is a one-shot over whatever is in ch_court_decisions
    when it runs, so a fixture that applied 200 first would never exercise
    it."""
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        for t in ("ch_citation_state", "ch_act_alias", "ch_case_citations",
                  "ch_legislation_citations", "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                stage text,
                decision_date date,
                docket_number text
            )
        """)
        # 199 is what 200 reads (the stamps) and what it prunes (the index).
        apply_migration_199(c)
        yield c


def _seed_decisions(conn):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage) VALUES "
        "('ECLI:1','CH_BGer','1','loaded'), "
        "('ECLI:2','CH_BGer','2','loaded'), "
        # not loaded: not part of the citation queue at all
        "('ECLI:3','CH_BGer','3','extracted')")
    # ECLI:1 has already been extracted under the old scheme; 199's column is
    # the only record of that, and losing it means re-extracting it.
    conn.execute("UPDATE ch_court_decisions SET citations_extracted_at = now() "
                 "WHERE ecli = 'ECLI:1'")


def _cols(conn, table):
    return {r["column_name"] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,)).fetchall()}


def _indexes(conn, table):
    return {r["indexname"] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = %s", (table,)).fetchall()}


def test_creates_the_state_table(conn):
    apply_migration_200(conn)
    assert conn.execute(
        "SELECT to_regclass('ch_citation_state') IS NOT NULL AS ok").fetchone()["ok"]
    assert {"ecli", "extracted_at", "attempts", "last_error", "updated_at"} \
        == _cols(conn, "ch_citation_state")
    # attempts and updated_at carry the defaults the stages rely on: nothing
    # ever inserts them explicitly.
    conn.execute("INSERT INTO ch_citation_state (ecli) VALUES ('ECLI:X')")
    row = conn.execute(
        "SELECT * FROM ch_citation_state WHERE ecli = 'ECLI:X'").fetchone()
    assert row["attempts"] == 0
    assert row["extracted_at"] is None
    assert row["updated_at"] is not None


def test_creates_the_pending_index(conn):
    """The claim's whole predicate. Partial, so it holds the backlog rather
    than an entry per decision in the corpus."""
    apply_migration_200(conn)
    assert "idx_ch_citation_state_pending" in _indexes(conn, "ch_citation_state")
    definition = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = "
        "'idx_ch_citation_state_pending'").fetchone()["indexdef"]
    assert "extracted_at IS NULL" in definition


def test_the_seed_copies_the_existing_stamps(conn):
    """The already-extracted corpus must not be re-extracted by accident:
    the seed carries 199's stamps over, and enrols only the decisions that
    are actually at 'loaded'."""
    _seed_decisions(conn)
    apply_migration_200(conn)

    rows = {r["ecli"]: r for r in conn.execute(
        "SELECT * FROM ch_citation_state").fetchall()}
    assert set(rows) == {"ECLI:1", "ECLI:2"}
    assert rows["ECLI:1"]["extracted_at"] is not None
    assert rows["ECLI:2"]["extracted_at"] is None


def test_drops_the_partial_index_on_the_decisions_table(conn):
    """idx_ch_court_cit_queue served only the claim query this migration
    retires, and while it exists its predicate is what makes every write to
    citations_extracted_at a non-HOT rewrite of a row in a 19 GB table."""
    _seed_decisions(conn)
    assert "idx_ch_court_cit_queue" in _indexes(conn, "ch_court_decisions")
    apply_migration_200(conn)
    assert "idx_ch_court_cit_queue" not in _indexes(conn, "ch_court_decisions")


def test_leaves_the_old_column_in_place(conn):
    """Deliberate: dropping a column on a 19 GB table takes an ACCESS
    EXCLUSIVE lock, and until this table has been the source of truth for a
    while the column is the only surviving copy of the pre-migration stamps.
    A later migration may drop it."""
    _seed_decisions(conn)
    apply_migration_200(conn)
    assert "citations_extracted_at" in _cols(conn, "ch_court_decisions")


def test_is_idempotent_and_the_seed_does_not_run_twice(conn):
    """A second application must insert nothing at all. By then the table is
    the live queue, and re-seeding it would resurrect state rows for
    decisions the pipeline has since retired and re-stamp them from a column
    nothing writes any more."""
    _seed_decisions(conn)
    apply_migration_200(conn)

    # The queue has moved on since the seed: one decision extracted, one
    # re-queued, one decision retired from the corpus entirely.
    conn.execute("UPDATE ch_citation_state SET extracted_at = NULL, attempts = 2 "
                 "WHERE ecli = 'ECLI:1'")
    conn.execute("DELETE FROM ch_citation_state WHERE ecli = 'ECLI:2'")
    before = conn.execute(
        "SELECT ecli, extracted_at, attempts FROM ch_citation_state "
        "ORDER BY ecli").fetchall()

    conn.execute(MIGRATION_200.read_text())      # must not raise

    assert conn.execute(
        "SELECT ecli, extracted_at, attempts FROM ch_citation_state "
        "ORDER BY ecli").fetchall() == before


def test_sets_a_lock_timeout_before_anything_else(conn):
    """Same reason as migration 199's: the runner applies a whole file as one
    implicit transaction, so anything here that has to wait on
    ch_court_decisions (the seed reads it) would sit in the lock queue
    holding up everything behind it. Fail fast, retry in a quiet window."""
    statements = [line.strip() for line in MIGRATION_200.read_text().splitlines()
                  if line.strip() and not line.strip().startswith("--")]
    assert statements[0] == "SET lock_timeout = '3s';"
    apply_migration_200(conn)
    assert conn.execute("SHOW lock_timeout").fetchone()["lock_timeout"] == "3s"
