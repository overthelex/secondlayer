import os
import pathlib
import psycopg
import pytest
from chpipe.config import Settings
from chpipe.stages import acts_stage, project_legacy_stage, versions_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_project_legacy_stage.py is 3 levels down from the repo root -- same
# convention as test_migration_197.py and test_reports.py, and needed so the
# suite passes whether pytest is invoked from services/ch-pipeline or from
# the repo root (both are required to stay green).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("""
            CREATE TABLE ch_legislation (
                eli_uri text NOT NULL, lang text NOT NULL, sr_number text,
                title text, short_title text, version_date date, in_force boolean,
                date_entry_force date, date_end_validity date, akn_xml text,
                full_text text, html_url text, pdf_url text, xml_url text,
                source text DEFAULT 'fedlex', metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (eli_uri, lang))
        """)
        c.execute(M197.read_text())
        acts_stage.upsert_act(c, {
            "work": WORK, "srNotation": "220",
            "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"})
        acts_stage.apply_titles(c, [
            {"work": WORK, "lang": L + "DEU", "title": "Obligationenrecht",
             "titleShort": "OR"}])
        yield c


def _edition(conn, date, text, lang="DEU"):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + lang, "fileUrl": f"https://x/{date}.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', full_text=%s "
                 "WHERE version_id=%s", (text, vid))
    return vid


def test_projects_the_latest_edition(conn, settings):
    _edition(conn, "2020-01-01", "alte Fassung")
    _edition(conn, "2026-01-01", "neue Fassung")
    assert project_legacy_stage.run(settings) == 1
    row = conn.execute(
        "SELECT version_date, full_text FROM ch_legislation WHERE lang='de'").fetchone()
    assert str(row[0]) == "2026-01-01"
    assert row[1] == "neue Fassung"


def test_the_sr_number_column_now_holds_the_real_sr_number(conn, settings):
    """Deliberate change of meaning: this column used to hold an ELI fragment."""
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert conn.execute(
        "SELECT sr_number FROM ch_legislation").fetchone()[0] == "220"


def test_in_force_is_populated_rather_than_null(conn, settings):
    """Every one of the 5,594 rows in the old table had in_force NULL."""
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert conn.execute("SELECT in_force FROM ch_legislation").fetchone()[0] is True


def test_the_title_and_short_title_come_from_the_act(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    row = conn.execute("SELECT title, short_title FROM ch_legislation").fetchone()
    assert row == ("Obligationenrecht", "OR")


def test_each_language_gets_its_own_row(conn, settings):
    _edition(conn, "2026-01-01", "de text", lang="DEU")
    _edition(conn, "2026-01-01", "fr text", lang="FRA")
    assert project_legacy_stage.run(settings) == 2
    langs = {r[0] for r in conn.execute("SELECT lang FROM ch_legislation").fetchall()}
    assert langs == {"de", "fr"}


def test_rerunning_replaces_rather_than_duplicating(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    project_legacy_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_legislation").fetchone()[0] == 1


# --- Decision 1: distinguishing a written row from a pre-existing survivor ---
# Measured on prod: 5,382 of ch_legislation's 5,594 rows hold a CSS blob
# instead of legislation text (the old importer built filestore URLs by
# string pattern and got HTML error pages back). The projection upserts on
# (eli_uri, lang), so any junk row whose eli_uri this corpus never re-derives
# is never touched and survives, indistinguishable at a glance from a row
# this run actually wrote. These tests pin down the two halves of the fix:
# every written row is marked, and an untouched row is counted, not silently
# treated as accounted for.

def test_a_written_row_is_marked_with_its_provenance(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    meta = conn.execute(
        "SELECT metadata_json FROM ch_legislation").fetchone()[0]
    assert meta["projected_from"] == "ch_act_version"


def test_unaccounted_rows_counts_a_pre_existing_row_the_projection_never_touches(
        conn, settings):
    conn.execute(
        "INSERT INTO ch_legislation (eli_uri, lang, full_text) VALUES "
        "('https://fedlex.data.admin.ch/eli/cc/1/999_999_999', 'de', "
        "'.some-css { color: red; }')")
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert project_legacy_stage.unaccounted_rows(conn) == 1


def test_unaccounted_rows_is_zero_once_every_row_is_marked(conn, settings):
    _edition(conn, "2026-01-01", "x")
    project_legacy_stage.run(settings)
    assert project_legacy_stage.unaccounted_rows(conn) == 0


# --- Decision 2: stage='parsed' is not the same claim as "usable" ---
# A parsed edition with article_count = 0 is real: Fedlex serves genuine
# nineteenth-century declarations whose <act> has no <body> at all. The
# projection must be able to say which editions it wrote are like that,
# rather than silently projecting emptiness into the compatibility table.

def test_empty_latest_editions_counts_a_parsed_but_bodyless_edition(conn, settings):
    vid = _edition(conn, "2026-01-01", "")
    conn.execute("UPDATE ch_act_version SET article_count = 0 WHERE version_id = %s",
                 (vid,))
    assert project_legacy_stage.empty_latest_editions(conn) == 1


def test_empty_latest_editions_is_zero_when_the_latest_edition_has_articles(
        conn, settings):
    vid = _edition(conn, "2026-01-01", "x")
    conn.execute("UPDATE ch_act_version SET article_count = 3 WHERE version_id = %s",
                 (vid,))
    assert project_legacy_stage.empty_latest_editions(conn) == 0
