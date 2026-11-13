"""Applies migration 259 to a scratch database. A mocked DB cannot validate SQL."""
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import apply_migration_259

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_text_clean_state CASCADE")
        yield c


def test_migration_259_creates_state_table(conn):
    apply_migration_259(conn)
    apply_migration_259(conn)  # twice: idempotent
    cols = {r["column_name"] for r in conn.execute(
        "select column_name from information_schema.columns "
        "where table_name='ch_text_clean_state'")}
    assert {"doc_id", "spider", "cleaner_version", "raw_sha256", "cleaned_at",
            "attempts", "last_error"} <= cols


def test_pending_index_is_partial_and_defaults(conn):
    apply_migration_259(conn)
    idx = conn.execute(
        "select indexdef from pg_indexes where indexname='idx_ch_text_clean_pending'"
    ).fetchone()["indexdef"]
    assert "cleaned_at IS NULL" in idx and "(spider, doc_id)" in idx
    conn.execute("insert into ch_text_clean_state (doc_id, spider) values ('a','S')")
    r = conn.execute("select attempts, cleaned_at from ch_text_clean_state").fetchone()
    assert r["attempts"] == 0 and r["cleaned_at"] is None
