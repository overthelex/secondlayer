"""Applies migration 202 to a scratch database. A mocked DB cannot validate SQL."""
import os
import pathlib
import psycopg
import pytest

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/202_ch_registries.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

# Minimal stand-ins for migration 129's ch_zefix_companies / ch_shab_publications:
# only the columns 202's ALTER TABLE / CREATE INDEX statements touch or need
# (uid PK, shab_id UNIQUE, company_uid, company_name, publication_date, rubric).
# 129 also creates several unrelated tables (nl_insolvency, ch_finma_regulated,
# ...) that have nothing to do with 202, so applying 129 verbatim here would
# just be dead weight.
_CH_ZEFIX_COMPANIES = """
CREATE TABLE IF NOT EXISTS ch_zefix_companies (
    uid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    legal_form TEXT,
    legal_seat TEXT,
    register_office TEXT,
    status TEXT,
    canton TEXT
)
"""

_CH_SHAB_PUBLICATIONS = """
CREATE TABLE IF NOT EXISTS ch_shab_publications (
    id SERIAL PRIMARY KEY,
    shab_id TEXT UNIQUE,
    publication_date DATE,
    publication_type TEXT,
    rubric TEXT,
    sub_rubric TEXT,
    company_uid TEXT,
    company_name TEXT,
    canton TEXT
)
"""


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_shab_progress", "ch_zefix_progress", "ch_zefix_municipality",
                  "ch_shab_publications", "ch_zefix_companies"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute(_CH_ZEFIX_COMPANIES)
        c.execute(_CH_SHAB_PUBLICATIONS)
        c.execute(MIGRATION.read_text())
        yield c


def _cols(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,)).fetchall()}


def _indexes(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = %s", (table,)).fetchall()}


def _pg_trgm_installed(conn) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'").fetchone())


def test_sets_a_lock_timeout_before_anything_else(conn):
    """Same reasoning as migration 199, and the same assertion: the runner
    applies the whole file as one implicit transaction, so the ALTER TABLEs'
    ACCESS EXCLUSIVE locks on ch_zefix_companies and ch_shab_publications are
    held through every index build that follows. A bounded lock_timeout is
    what keeps that from queueing behind -- and then blocking -- the delta's
    own writers: the migration fails fast and is retried outside the window."""
    statements = [line.strip() for line in MIGRATION.read_text().splitlines()
                  if line.strip() and not line.strip().startswith("--")]
    assert statements[0] == "SET lock_timeout = '3s';"
    # And it really took effect in the session the file was applied in.
    assert conn.execute("SHOW lock_timeout").fetchone()[0] == "3s"


def test_adds_columns(conn):
    assert {"municipality_id", "legal_form_code", "seen_at", "source_iri"} \
        <= _cols(conn, "ch_zefix_companies")

    assert {"language", "publication_number", "title", "registration_office",
            "legal_form", "seat", "detail_fetched_at", "detail_attempts",
            "detail_error"} <= _cols(conn, "ch_shab_publications")


def test_creates_tables(conn):
    for t in ("ch_zefix_municipality", "ch_zefix_progress", "ch_shab_progress"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]

    def _pk_cols(table):
        return [r[0] for r in conn.execute(
            """
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = %s::regclass AND i.indisprimary
            ORDER BY array_position(i.indkey, a.attnum)
            """, (table,)).fetchall()]

    assert _pk_cols("ch_zefix_municipality") == ["id"]
    assert _pk_cols("ch_zefix_progress") == ["run_date", "municipality_id"]
    assert _pk_cols("ch_shab_progress") == ["rubric", "month"]


def test_indexes(conn):
    shab_indexes = _indexes(conn, "ch_shab_publications")
    assert "idx_ch_shab_uid" in shab_indexes
    assert "idx_ch_shab_date" in shab_indexes
    assert "idx_ch_shab_detail_queue" in shab_indexes

    if _pg_trgm_installed(conn):
        assert "idx_ch_shab_name_trgm" in shab_indexes
    else:
        assert "idx_ch_shab_name_trgm" not in shab_indexes


def test_detail_queue_index_is_partial_and_in_the_claims_own_order(conn):
    """Both columns DESC, in that order. shab-detail claims
    `ORDER BY rubric DESC, publication_date DESC` ('KK' > 'HR', so descending
    is bankruptcies first), and an index that does not match that order is not
    read in order at all: the earlier (rubric, publication_date DESC)
    definition made the claim sort the whole unfetched set, measured at 867 ms
    with a disk spill on 1M rows."""
    row = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ch_shab_detail_queue'").fetchone()
    assert row is not None
    assert "WHERE (detail_fetched_at IS NULL)" in row[0]
    assert "rubric DESC" in row[0]
    assert "publication_date DESC" in row[0]


def test_an_older_detail_queue_index_is_replaced(conn):
    """IF NOT EXISTS matches by name, so a database that ran the first version
    of this migration would keep the index that cannot serve the claim. The
    migration drops it when -- and only when -- it is the old shape."""
    conn.execute("DROP INDEX IF EXISTS idx_ch_shab_detail_queue")
    conn.execute("CREATE INDEX idx_ch_shab_detail_queue ON ch_shab_publications "
                 "(rubric, publication_date DESC) WHERE detail_fetched_at IS NULL")
    conn.execute(MIGRATION.read_text())

    indexdef = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ch_shab_detail_queue'"
    ).fetchone()[0]
    assert "rubric DESC" in indexdef


def test_is_idempotent(conn):
    conn.execute(MIGRATION.read_text())      # must not raise


def test_a_municipality_may_have_no_name(conn):
    """Probed live on 2026-08-26: organisations reference 2,111 municipality
    IRIs and only 2,110 are a schema.ld:Municipality contained in a canton.
    <https://ld.admin.ch/municipality/700> (Moutier, 5 organisations) is not,
    so LINDAS publishes no schema:name for it. The zefix stage walks the
    municipalities the ORGANISATIONS reference -- anything else loses those
    five companies -- so the row has to be storable without inventing a name
    for it."""
    conn.execute(
        "INSERT INTO ch_zefix_municipality (id, name, canton, iri) "
        "VALUES (700, NULL, NULL, 'https://ld.admin.ch/municipality/700')")
    assert conn.execute(
        "SELECT name FROM ch_zefix_municipality WHERE id = 700").fetchone()[0] is None
