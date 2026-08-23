"""Applies migration 196 to a scratch database and asserts the resulting shape.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_migration_196.py
"""
import os
import pathlib
import psycopg
import pytest

# Derive repo root from this file's location: services/ch-pipeline/tests/test_migration_196.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        # The columns migration 134 created, which 196 extends.
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[],
                metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        """)
        yield c


def _apply(conn):
    conn.execute(MIGRATION.read_text())


def _columns(conn) -> dict[str, str]:
    rows = conn.execute("""
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'ch_court_decisions'
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def test_adds_queue_columns(conn):
    _apply(conn)
    cols = _columns(conn)
    assert cols["doc_id"] == "text"
    assert cols["canton"] == "text"
    assert cols["html_url"] == "text"
    assert cols["text_source"] == "text"
    assert cols["text_quality"] == "real"
    assert cols["pdf_sha256"] == "text"
    assert cols["stage"] == "text"
    assert cols["attempts"] == "smallint"
    assert cols["last_error"] == "text"
    assert cols["stage_updated_at"] == "timestamp with time zone"


def test_is_idempotent(conn):
    _apply(conn)
    _apply(conn)          # must not raise
    assert _columns(conn)["doc_id"] == "text"


def test_existing_rows_are_preserved_and_marked_indexed(conn):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s, %s, %s)",
        ("ECLI:CH:CH_BGer:x", "CH_BGer", "a" * 500),
    )
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider) VALUES (%s, %s)",
        ("ECLI:CH:ZH_Obergericht:y", "ZH_Obergericht"),
    )
    _apply(conn)
    rows = dict(conn.execute("SELECT ecli, stage FROM ch_court_decisions").fetchall())
    # A row that already carries text is done; a row without text must be re-fetched.
    assert rows["ECLI:CH:CH_BGer:x"] == "loaded"
    assert rows["ECLI:CH:ZH_Obergericht:y"] == "indexed"


def test_doc_id_is_unique_but_nullable(conn):
    _apply(conn)
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('a','S','d1')")
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('b','S',NULL)")
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('c','S',NULL)")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id) VALUES ('d','S','d1')")


def test_stage_index_is_partial_on_unfinished_work(conn):
    _apply(conn)
    definition = conn.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_ch_court_stage'"
    ).fetchone()[0]
    assert "WHERE" in definition and "loaded" in definition


def test_jstats_trigger_counts_null_to_text_transition(conn):
    """Guards the delta trigger against the mass UPDATE this pipeline performs.

    Skipped on a scratch DB that has no jurisdiction_fulltext_stats; run it on a
    prod-shaped copy for the real answer.
    """
    exists = conn.execute(
        "SELECT to_regclass('public.jurisdiction_fulltext_stats') IS NOT NULL"
    ).fetchone()[0]
    if not exists:
        pytest.skip("jurisdiction_fulltext_stats not present in this database")

    before = conn.execute(
        "SELECT fulltext_count FROM jurisdiction_fulltext_stats WHERE jurisdiction = 'CH'"
    ).fetchone()[0]
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider) VALUES ('t1','S')")
    conn.execute("UPDATE ch_court_decisions SET full_text = %s WHERE ecli = 't1'", ("x" * 500,))
    after = conn.execute(
        "SELECT fulltext_count FROM jurisdiction_fulltext_stats WHERE jurisdiction = 'CH'"
    ).fetchone()[0]
    assert after == before + 1, (
        "delta trigger did not count NULL -> text; the mass UPDATE would corrupt "
        "v_jurisdiction_fulltext_stats"
    )
