"""Applies migration 199 to a scratch database. A mocked DB cannot validate SQL."""
import os
import pathlib
import psycopg
import pytest

# Derive repo root from this file's location: services/ch-pipeline/tests/test_migration_199.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/199_ch_citation_graph.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_alias", "ch_case_citations", "ch_legislation_citations",
                  "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        # minimal shape of migration 196's ch_court_decisions, just enough for
        # the ALTER TABLE / partial index this migration adds to it
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
        c.execute(MIGRATION.read_text())
        yield c


def _cols(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,)).fetchall()}


def test_creates_tables(conn):
    for t in ("ch_act_alias", "ch_case_citations", "ch_legislation_citations"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]

    assert {"abbr", "lang", "sr_number", "source"} <= _cols(conn, "ch_act_alias")

    assert {"id", "from_ecli", "to_raw", "cite_kind", "to_ecli", "resolved",
            "match_method", "citation_context", "from_date", "from_court"} \
        <= _cols(conn, "ch_case_citations")

    assert {"id", "from_ecli", "abbr_raw", "article", "paragraph", "lang",
            "sr_number", "act_id", "version_id", "article_id", "resolved",
            "match_method", "citation_context", "from_date"} \
        <= _cols(conn, "ch_legislation_citations")

    assert "citations_extracted_at" in _cols(conn, "ch_court_decisions")


def test_is_idempotent(conn):
    conn.execute(MIGRATION.read_text())      # must not raise


def test_unique_treats_null_paragraph_as_equal(conn):
    """UNIQUE NULLS NOT DISTINCT: a repeated (from_ecli, abbr_raw, article, NULL)
    must collide, not silently duplicate the way plain UNIQUE would treat NULL."""
    conn.execute(
        "INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, paragraph) "
        "VALUES ('ECLI:CH:1', 'OR', '336', NULL)")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, paragraph) "
            "VALUES ('ECLI:CH:1', 'OR', '336', NULL)")


def test_cite_kind_check(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_case_citations (from_ecli, to_raw, cite_kind) "
            "VALUES ('ECLI:CH:1', 'BGE 142 III 102', 'foo')")


def _indexes(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = %s", (table,)).fetchall()}


def test_creates_the_docket_and_pending_resolution_indexes(conn):
    """Step 4's resolution UPDATE ... FROM statements filter
    ch_court_decisions on docket_number and ch_legislation_citations /
    ch_case_citations on match_method IS NULL -- these partial indexes are
    what keeps that a seek instead of a sequential scan over millions of
    rows."""
    assert "idx_ch_court_docket" in _indexes(conn, "ch_court_decisions")
    assert "idx_ch_leg_cit_pending" in _indexes(conn, "ch_legislation_citations")
    assert "idx_ch_case_cit_pending" in _indexes(conn, "ch_case_citations")
