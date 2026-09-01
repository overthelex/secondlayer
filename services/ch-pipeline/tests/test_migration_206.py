"""Applies migration 206 (cantonal aliases) to a scratch database and
asserts the resulting shape: ch_act_alias gains a jurisdiction column that
joins the primary key, existing rows are backfilled to 'CH', and
ch_legislation_citations gains the partial index the batched retry pass
walks.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_migration_206.py
"""
import os
import pathlib

import psycopg
import pytest

from conftest import MIGRATION_206, apply_migration_199

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_case_citations", "ch_legislation_citations",
                  "ch_act_alias", "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        # minimal shape of migration 196's ch_court_decisions, just enough
        # for migration 199's ALTER TABLE / partial index -- same fixture
        # shape as test_migration_199.py.
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text, doc_id text, stage text,
                docket_number text)
        """)
        apply_migration_199(c)
        yield c


def _apply(conn):
    conn.execute(MIGRATION_206.read_text())


def _pk_columns(conn) -> list[str]:
    rows = conn.execute("""
        SELECT k.column_name
          FROM information_schema.key_column_usage k
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = k.constraint_name
           AND tc.table_schema = k.table_schema
         WHERE tc.table_schema = 'public' AND tc.table_name = 'ch_act_alias'
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY k.ordinal_position
    """).fetchall()
    return [r[0] for r in rows]


def test_jurisdiction_joins_the_primary_key(conn):
    _apply(conn)
    assert _pk_columns(conn) == ["abbr", "lang", "sr_number", "jurisdiction"]


def test_existing_rows_are_backfilled_to_ch(conn):
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source) "
        "VALUES ('OR', 'de', '220', 'curated')")
    _apply(conn)
    row = conn.execute(
        "SELECT jurisdiction FROM ch_act_alias WHERE abbr = 'OR'").fetchone()
    assert row[0] == "CH"


def test_two_cantons_may_share_abbr_lang_and_number(conn):
    """The whole point of re-keying: cantonal collections copy each other's
    numbering plans, so the same (abbr, lang, sr_number) under two cantons
    must be two rows, which the old three-column PK forbade."""
    _apply(conn)
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) "
        "VALUES ('EG ZGB', 'de', '210.1', 'cantonal_abbreviation', 'AG'), "
        "       ('EG ZGB', 'de', '210.1', 'cantonal_abbreviation', 'BE')")
    n = conn.execute(
        "SELECT count(*) FROM ch_act_alias WHERE abbr = 'EG ZGB'").fetchone()[0]
    assert n == 2


def test_jurisdiction_vocabulary_is_closed(conn):
    _apply(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) "
            "VALUES ('X', 'de', '1', 'curated', 'DE')")


def test_retry_index_exists(conn):
    _apply(conn)
    assert conn.execute(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'ch_legislation_citations' "
        "AND indexname = 'idx_ch_leg_cit_unresolved_abbr'").fetchone()


def test_applying_twice_is_a_noop(conn):
    _apply(conn)
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) "
        "VALUES ('LOJ', 'fr', 'E 2 05', 'title_paren', 'GE')")
    _apply(conn)
    assert _pk_columns(conn) == ["abbr", "lang", "sr_number", "jurisdiction"]
    row = conn.execute(
        "SELECT jurisdiction FROM ch_act_alias WHERE abbr = 'LOJ'").fetchone()
    assert row[0] == "GE"
