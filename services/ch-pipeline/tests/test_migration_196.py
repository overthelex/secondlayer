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
    # Case 1: long clean text → loaded
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s, %s, %s)",
        ("ECLI:CH:CH_BGer:clean", "CH_BGer", "a" * 500),
    )
    # Case 2: long text with mojibake marker Ã → indexed (needs re-fetch)
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s, %s, %s)",
        ("ECLI:CH:CH_BGer:mojibake_a", "CH_BGer", "EidgenÃ¶ssisches" + ("a" * 485)),
    )
    # Case 3: long text carrying the Â-family marker PAIR → indexed.
    # The original fixture here was "VersicherungsgerichtÂ" + "a"*480 -- a bare
    # Â followed by an ASCII letter, which is not mojibake at all and is
    # exactly the shape of the legitimate French "ÂGE" the old bare-marker
    # LIKE false-positived on. Real Â-family mojibake is a C2 lead byte
    # followed by a continuation byte: "§" (C2 A7) read as Latin-1 is "Â§".
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s, %s, %s)",
        ("ECLI:CH:CH_BGer:mojibake_b", "CH_BGer",
         "Versicherungsgericht, Art. 5 \u00c2\u00a7 2 " + ("a" * 460)),
    )
    # Case 4: NULL or short text → indexed (needs fetch)
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider) VALUES (%s, %s)",
        ("ECLI:CH:ZH_Obergericht:empty", "ZH_Obergericht"),
    )
    _apply(conn)
    rows = dict(conn.execute("SELECT ecli, stage FROM ch_court_decisions").fetchall())
    # Only clean long text is marked loaded; everything else is indexed for re-processing
    assert rows["ECLI:CH:CH_BGer:clean"] == "loaded", "clean long text should be loaded"
    assert rows["ECLI:CH:CH_BGer:mojibake_a"] == "indexed", "text with Ã should be re-fetched"
    assert rows["ECLI:CH:CH_BGer:mojibake_b"] == "indexed", \
        "a C2-lead marker pair should be re-fetched"
    assert rows["ECLI:CH:ZH_Obergericht:empty"] == "indexed", "NULL/short text should be indexed"


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


# --- Enrolment across the three national languages ---
#
# The enrolment UPDATE decides the fate of 678,165 rows, and until now it was
# tested only against ASCII "a" * 500 and two synthetic German mojibake
# strings. There was no French or Italian text in these tests at all, and no
# test that legitimate accented text survives into 'loaded' -- which is the
# regression guard on the whole decision.

def _insert(conn, ecli, spider, full_text):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text) VALUES (%s,%s,%s)",
        (ecli, spider, full_text))


def _stages(conn) -> dict[str, str]:
    return dict(conn.execute("SELECT ecli, stage FROM ch_court_decisions").fetchall())


def test_legitimate_umlaut_text_still_reaches_loaded(conn):
    """The regression guard on the 678,165-row decision: real German with
    real umlauts is NOT mojibake and must not be thrown back into the
    queue for a re-fetch it does not need."""
    _insert(conn, "de:clean", "CH_BGer",
            "Das Bundesgericht hat die Beschwerde des Beschwerdeführers gegen "
            "das Urteil des Obergerichts des Kantons Graubünden abgewiesen. " * 6)
    _apply(conn)
    assert _stages(conn)["de:clean"] == "loaded"


def test_legitimate_french_all_caps_age_is_not_mistaken_for_mojibake(conn):
    """The known false positive of the old `NOT LIKE '%Â%'` marker: "ÂGE" is
    ordinary French all-caps, and a bare Â test re-queues a perfectly good
    row for a pointless re-download."""
    _insert(conn, "fr:age", "GE_Gerichte",
            "ARRÊT DE LA COUR DE JUSTICE. LIMITE D'ÂGE DES MAGISTRATS. Le "
            "recourant, âgé de soixante-cinq ans, conteste la décision du "
            "Conseil d'État relative à l'ÂGE de la retraite. " * 4)
    _apply(conn)
    assert _stages(conn)["fr:age"] == "loaded"


def test_legitimate_italian_text_reaches_loaded(conn):
    _insert(conn, "it:clean", "TI_Gerichte",
            "LA CORTE D'APPELLO. Il ricorrente è stato condannato perché la "
            "società non ha più diritto all'indennità prevista dalla legge. " * 5)
    _apply(conn)
    assert _stages(conn)["it:clean"] == "loaded"


def test_french_mojibake_is_requeued(conn):
    """The same French passage, corrupted the way the 165,363 CH_BGer rows
    were: UTF-8 bytes read as Latin-1."""
    clean = ("ARRÊT DE LA COUR DE JUSTICE. Le recourant, âgé de soixante-cinq "
             "ans, conteste la décision du Conseil d'État. " * 6)
    _insert(conn, "fr:moji", "GE_Gerichte", clean.encode("utf-8").decode("latin-1"))
    _apply(conn)
    assert _stages(conn)["fr:moji"] == "indexed"


def test_italian_mojibake_is_requeued(conn):
    clean = ("Il ricorrente è stato condannato perché la società non ha più "
             "diritto all'indennità prevista dalla legge federale. " * 6)
    _insert(conn, "it:moji", "TI_Gerichte", clean.encode("utf-8").decode("latin-1"))
    _apply(conn)
    assert _stages(conn)["it:moji"] == "indexed"


def test_german_mojibake_is_still_requeued(conn):
    clean = ("Das Bundesgericht hat die Beschwerde des Beschwerdeführers gegen "
             "das Urteil des Obergerichts von Graubünden abgewiesen. " * 6)
    _insert(conn, "de:moji", "CH_BGer", clean.encode("utf-8").decode("latin-1"))
    _apply(conn)
    assert _stages(conn)["de:moji"] == "indexed"
