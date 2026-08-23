"""Which stage actually fires trg_jstats — measured, not assumed.

`load_stage`'s docstring claimed it was kept separate from `extract` because
its `UPDATE ... SET stage = 'loaded'` is "the statement that moves roughly
500,000 rows from NULL to text" and therefore fires `trg_jstats`. It is not.
Migration 156 attaches the trigger as

    AFTER INSERT OR DELETE OR UPDATE OF full_text ON ch_court_decisions

and `load` writes only `stage` (plus its bookkeeping columns), never
`full_text` — so the trigger is not even considered. The NULL -> text
transition happens in `extract_stage`, which writes `full_text` in the same
`db.complete()` statement that moves the row to 'extracted', and in
`ocr_stage` for a recovered scan.

The consequence for the operator was worse than the wrong docstring: the
README's Gate B told them to snapshot `v_jurisdiction_fulltext_stats` around
a `load` run and confirm the delta matched `LoadReport.loaded`. That
measurement returns exactly zero every time, and reads as a broken trigger.

The trigger function under test is executed verbatim out of
156_jurisdiction_fulltext_stats.sql — retyping it here would test a copy
rather than the migration, and a mocked database cannot validate any of it.
"""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import extract_stage, load_stage

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
MIGRATION_156 = _REPO_ROOT / "mcp_backend/src/migrations/156_jurisdiction_fulltext_stats.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

GOOD_DE_HTML = ("<html><body>" + "<p>Das Bundesgericht hat die Beschwerde des "
                "Beschwerdeführers gegen das Urteil des Obergerichts abgewiesen, "
                "soweit darauf einzutreten ist.</p>" * 8 + "</body></html>")


def _slice(text: str, start_marker: str, end_marker: str) -> str:
    """Lift one statement out of a migration file, verbatim."""
    start = text.index(start_marker)
    end = text.index(end_marker, start) + len(end_marker)
    return text[start:end]


def _install_jstats(conn) -> None:
    """Recreate, from migration 156 itself, exactly what it builds for
    ch_court_decisions: the summary table, the inline trigger function, and
    the trigger. 156 cannot be applied whole to a scratch database — it also
    attaches triggers to and seeds counts from ~20 other jurisdictions'
    tables, none of which exist here — so the three pieces that concern this
    table are taken out of it by text, not retyped.

    The old skipped test dropped ch_court_decisions in its fixture, which
    dropped the trigger with it, so it could never have passed even with its
    column names fixed (it queried fulltext_count/jurisdiction; 156 defines
    fulltext_decisions/jurisdiction_code).
    """
    source = MIGRATION_156.read_text()
    conn.execute(_slice(source, "CREATE TABLE IF NOT EXISTS jurisdiction_fulltext_stats",
                        ");"))
    conn.execute(_slice(source, "CREATE OR REPLACE FUNCTION trg_jurisdiction_stats_inline()",
                        "$$ LANGUAGE plpgsql;"))
    # The same shape 156's DO block formats for each inline table.
    conn.execute("DROP TRIGGER IF EXISTS trg_jstats ON ch_court_decisions")
    conn.execute("""
        CREATE TRIGGER trg_jstats
            AFTER INSERT OR DELETE OR UPDATE OF full_text ON ch_court_decisions
            FOR EACH ROW EXECUTE FUNCTION trg_jurisdiction_stats_inline('CH')
    """)
    conn.execute("""
        INSERT INTO jurisdiction_fulltext_stats
            (jurisdiction_code, jurisdiction_name, total_decisions, fulltext_decisions)
        VALUES ('CH', 'Швейцарія',
                (SELECT count(*) FROM ch_court_decisions),
                (SELECT count(*) FROM ch_court_decisions WHERE full_text IS NOT NULL))
        ON CONFLICT (jurisdiction_code) DO UPDATE SET
            total_decisions = EXCLUDED.total_decisions,
            fulltext_decisions = EXCLUDED.fulltext_decisions
    """)


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("DROP TABLE IF EXISTS jurisdiction_fulltext_stats CASCADE")
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
        c.execute(MIGRATION_196.read_text())
        _install_jstats(c)
        yield c


def _fulltext_count(conn) -> int:
    return conn.execute(
        "SELECT fulltext_decisions AS n FROM jurisdiction_fulltext_stats "
        "WHERE jurisdiction_code = 'CH'").fetchone()["n"]


def _direct_count(conn) -> int:
    return conn.execute(
        "SELECT count(*) AS n FROM ch_court_decisions "
        "WHERE full_text IS NOT NULL").fetchone()["n"]


def _settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=99.0, max_attempts=3, retry_backoff_minutes=())


def test_the_trigger_counts_a_null_to_text_transition(conn):
    """The spec's Gate B assertion, on the transition itself."""
    before = _fulltext_count(conn)
    conn.execute("INSERT INTO ch_court_decisions (ecli, spider) VALUES ('t1','S')")
    conn.execute("UPDATE ch_court_decisions SET full_text = %s WHERE ecli='t1'",
                 ("x" * 500,))
    assert _fulltext_count(conn) == before + 1
    assert _fulltext_count(conn) == _direct_count(conn)


def test_load_does_not_fire_the_trigger(conn, tmp_path):
    """The finding. `load` writes only `stage`, so Gate B measured against a
    `load` run reports a delta of exactly zero and reads as a dead trigger."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, full_text) "
        "VALUES ('e:a','S','a','extracted',%s)", ("x" * 500,))
    before = _fulltext_count(conn)

    report = load_stage.run(_settings(tmp_path))

    assert report.loaded == 1
    assert _fulltext_count(conn) == before, (
        "load flips `stage`, never `full_text`; the trigger is AFTER "
        "UPDATE OF full_text and is not even considered")


def test_extract_is_the_stage_that_fires_the_trigger(conn, tmp_path):
    """Where the NULL -> text transition actually happens: extract writes
    full_text in the same statement that moves the row to 'extracted'."""
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text(GOOD_DE_HTML)
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, "
        "text_source, languages) VALUES ('e:d','S','d','fetched','html',%s)",
        (["de"],))
    before = _fulltext_count(conn)

    report = extract_stage.run(_settings(tmp_path), spider="S", limit=1)

    assert report.extracted == 1
    assert _fulltext_count(conn) == before + 1
    assert _fulltext_count(conn) == _direct_count(conn)


def test_re_extracting_a_row_that_already_had_text_moves_no_counter(conn, tmp_path):
    """The subtlety that makes a naive Gate B arithmetic wrong: the 165,363
    mojibake rows already carry text, so re-extracting them is text -> text.
    `(OLD.full_text IS NULL) <> (NEW.full_text IS NULL)` is false and the
    counter does not move, even though the row was rewritten. The delta to
    expect is the number of rows whose full_text was NULL beforehand, not
    the number extracted."""
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text(GOOD_DE_HTML)
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, "
        "text_source, languages, full_text) "
        "VALUES ('e:d','S','d','fetched','html',%s,%s)",
        (["de"], "EidgenÃ¶ssisches" + "a" * 400))
    before = _fulltext_count(conn)

    assert extract_stage.run(_settings(tmp_path), spider="S", limit=1).extracted == 1

    assert _fulltext_count(conn) == before
    assert _fulltext_count(conn) == _direct_count(conn)


def test_the_view_agrees_with_a_direct_count_after_a_whole_pass(conn, tmp_path):
    """Spec section 9, Gate B's second half: v_jurisdiction_fulltext_stats
    for CH must converge with a direct count(*)."""
    conn.execute(_slice(MIGRATION_156.read_text(),
                        "CREATE OR REPLACE VIEW v_jurisdiction_fulltext_stats",
                        "ORDER BY total_decisions DESC;"))
    (tmp_path / "S").mkdir()
    for i in range(3):
        (tmp_path / "S" / f"d{i}.html").write_text(GOOD_DE_HTML)
        conn.execute(
            "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, "
            "text_source, languages) VALUES (%s,'S',%s,'fetched','html',%s)",
            (f"e:d{i}", f"d{i}", ["de"]))

    extract_stage.run(_settings(tmp_path), spider="S")
    load_stage.run(_settings(tmp_path), spider="S")

    view = conn.execute(
        "SELECT fulltext_decisions AS n FROM v_jurisdiction_fulltext_stats "
        "WHERE jurisdiction_code = 'CH'").fetchone()["n"]
    assert view == _direct_count(conn) == 3
