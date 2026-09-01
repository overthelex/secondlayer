"""Applies migration 207 to a scratch database. A mocked DB cannot validate SQL.

207 creates ch_decision_index, the inbound-citation aggregate table
decision_index_stage maintains. Nothing else -- no seed, no ALTER of an
existing table -- so the properties worth pinning are that it applies on a
database that already has 199, that applying it twice is a no-op, and that
the shape matches what the stage's own SQL writes.
"""
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import MIGRATION_207, apply_migration_207

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        for t in ("ch_decision_index", "ch_act_alias", "ch_case_citations",
                  "ch_legislation_citations", "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                docket_number text,
                stage text
            )
        """)
        yield c


def test_applies_and_is_idempotent(conn):
    apply_migration_207(conn)
    # Second application must be a clean no-op -- the migration runner
    # re-applies a file whenever schema_migrations is missing a row.
    conn.execute(MIGRATION_207.read_text())

    cols = {r["column_name"] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'ch_decision_index'").fetchall()}
    assert cols == {"ecli", "cited_by_count", "citing_courts",
                    "first_citing_date", "last_citing_date", "refreshed_at"}


def test_ecli_is_the_primary_key(conn):
    apply_migration_207(conn)

    conn.execute(
        "INSERT INTO ch_decision_index (ecli, cited_by_count, citing_courts) "
        "VALUES ('ECLI:CH:X', 1, 1)")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "INSERT INTO ch_decision_index (ecli, cited_by_count, citing_courts) "
            "VALUES ('ECLI:CH:X', 2, 2)")
