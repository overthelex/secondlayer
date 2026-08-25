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
        # ... and the same for migration 197's ch_act_article, which this
        # migration indexes but does not create. IF NOT EXISTS so a real
        # 197-shaped table left behind by another test is used as it stands.
        c.execute("""
            CREATE TABLE IF NOT EXISTS ch_act_article (
                article_id bigserial PRIMARY KEY,
                version_id bigint,
                article_number text,
                e_id text,
                ordinal integer
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


def test_sets_a_lock_timeout_before_anything_else(conn):
    """The migration runner applies the whole file as one implicit
    transaction, so the ALTER TABLE's ACCESS EXCLUSIVE lock on
    ch_court_decisions is held until the file's last statement commits --
    through both ch_court_decisions index builds. A bounded lock_timeout is
    what keeps that from queueing behind (and then blocking) the delta's own
    writers indefinitely: the migration fails fast and is retried outside the
    window instead."""
    statements = [line.strip() for line in MIGRATION.read_text().splitlines()
                  if line.strip() and not line.strip().startswith("--")]
    assert statements[0] == "SET lock_timeout = '3s';"
    # And it really took effect in the session the file was applied in.
    assert conn.execute("SHOW lock_timeout").fetchone()[0] == "3s"


def test_creates_the_article_resolution_index(conn):
    """Step 3 of citations_resolve_stage looks an article up by
    (version_id, article_number); migration 197 indexes article_number alone
    and (version_id, ordinal), neither of which serves that lookup. Measured
    6.6x on the composite."""
    assert "idx_ch_act_article_version_number" in _indexes(conn, "ch_act_article")
