import os
import pathlib
import psycopg
import pytest
from conftest import reset_legislation_schema
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
        reset_legislation_schema(c)
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


# --- Finding 4: one unbatched, unbounded statement against production ---
# _PROJECT was a single INSERT ... SELECT over the whole corpus: no LIMIT, no
# batching, no statement timeout, no progress output. ~15,000 rows each
# carrying full akn_xml (2.2 MB for SR 220 alone) and full_text into a table
# with a GIN FTS index. Interrupted, it wrote nothing and left nothing to
# resume from -- the opposite of the queue discipline this branch applies
# everywhere else, and against CLAUDE.md's rule for large Postgres
# operations.

def _three_editions(conn):
    for lang in ("DEU", "FRA", "ITA"):
        _edition(conn, "2026-01-01", f"{lang} text", lang=lang)


def test_the_projection_is_written_in_batches_not_one_statement(conn, settings):
    sizes = []
    real = project_legacy_stage._write_batch
    _three_editions(conn)

    def spy(c, ids):
        sizes.append(len(ids))
        return real(c, ids)

    import unittest.mock as _mock
    with _mock.patch.object(project_legacy_stage, "_write_batch", spy):
        assert project_legacy_stage.run(settings, batch_size=2) == 3
    assert sizes == [2, 1], "the whole corpus went out in one statement"


def test_an_interrupted_run_keeps_the_batches_it_already_wrote(conn, settings):
    """The property the single statement could not have: partial progress
    survives, and a re-run finishes the job because every write is an
    upsert. Under one statement an interrupt left zero rows behind."""
    _three_editions(conn)
    real = project_legacy_stage._write_batch
    calls = {"n": 0}

    def flaky(c, ids):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("interrupted mid-projection")
        return real(c, ids)

    import unittest.mock as _mock
    with _mock.patch.object(project_legacy_stage, "_write_batch", flaky):
        with pytest.raises(RuntimeError):
            project_legacy_stage.run(settings, batch_size=1)

    assert conn.execute("SELECT count(*) FROM ch_legislation").fetchone()[0] == 1
    # And the run that follows it completes the corpus.
    assert project_legacy_stage.run(settings, batch_size=1) == 3
    assert conn.execute("SELECT count(*) FROM ch_legislation").fetchone()[0] == 3


def test_a_batch_runs_under_a_statement_timeout(conn, settings):
    """A pathological batch must become a failed batch, not a session
    holding locks on a live table indefinitely."""
    _three_editions(conn)
    seen = []
    real = project_legacy_stage._write_batch

    def spy(c, ids):
        # db.connect() hands out dict rows; SHOW keys them by setting name.
        seen.append(c.execute("SHOW statement_timeout").fetchone()["statement_timeout"])
        return real(c, ids)

    import unittest.mock as _mock
    with _mock.patch.object(project_legacy_stage, "_write_batch", spy):
        project_legacy_stage.run(settings, batch_size=2, statement_timeout="7min")
    assert seen and all(t == "7min" for t in seen)


def test_the_timeout_can_be_disabled_for_a_maintenance_window(conn, settings):
    _three_editions(conn)
    seen = []
    real = project_legacy_stage._write_batch

    def spy(c, ids):
        # db.connect() hands out dict rows; SHOW keys them by setting name.
        seen.append(c.execute("SHOW statement_timeout").fetchone()["statement_timeout"])
        return real(c, ids)

    import unittest.mock as _mock
    with _mock.patch.object(project_legacy_stage, "_write_batch", spy):
        project_legacy_stage.run(settings, statement_timeout="0")
    assert seen == ["0"]


def test_batching_does_not_change_what_is_projected(conn, settings):
    """Every edition still lands, whatever the batch size."""
    _three_editions(conn)
    assert project_legacy_stage.run(settings, batch_size=1) == 3
    langs = {r[0] for r in conn.execute("SELECT lang FROM ch_legislation").fetchall()}
    assert langs == {"de", "fr", "it"}


# --- Finding 8: one jsonb key ---
# "Some of these rows are empty, see the log" becomes a queryable fact.
# ch_legislation is the surface external notebooks read, and empty text that
# looks like text is the failure mode this whole branch exists to correct.

def test_a_projected_row_records_its_article_count(conn, settings):
    vid = _edition(conn, "2026-01-01", "x")
    conn.execute("UPDATE ch_act_version SET article_count = 42 WHERE version_id = %s",
                 (vid,))
    project_legacy_stage.run(settings)
    meta = conn.execute("SELECT metadata_json FROM ch_legislation").fetchone()[0]
    assert meta["article_count"] == 42


def test_a_body_less_edition_is_findable_by_query_not_only_by_log(conn, settings):
    vid = _edition(conn, "2026-01-01", "")
    conn.execute("UPDATE ch_act_version SET article_count = 0 WHERE version_id = %s",
                 (vid,))
    project_legacy_stage.run(settings)
    empty = conn.execute(
        "SELECT count(*) FROM ch_legislation "
        "WHERE (metadata_json ->> 'article_count')::int = 0").fetchone()[0]
    assert empty == 1


def test_a_cantonal_act_projects_with_source_lexwork_and_its_jurisdiction(conn, settings):
    act = conn.execute(
        "INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction, title_de, enforcement_status) "
        "VALUES ('https://bgs.zg.ch/app/de/texts_of_law/111.1', '111.1', 'ZG', 'Kantonsverfassung', 0) "
        "RETURNING act_id").fetchone()[0]
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source, "
        "stage, akn_xml, full_text, article_count) "
        "VALUES (%s, 'zg/111.1/v1', 'de', '2020-01-01', 'lexwork', 'parsed', '{}', 'text', 3)", (act,))
    project_legacy_stage.run(settings)
    row = conn.execute(
        "SELECT source, metadata_json->>'jurisdiction' FROM ch_legislation "
        "WHERE eli_uri = 'https://bgs.zg.ch/app/de/texts_of_law/111.1'").fetchone()
    assert row == ("lexwork", "ZG")
    ge = conn.execute(
        "INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction, title_fr, enforcement_status) "
        "VALUES ('https://silgeneve.ch/legis/program/books/rsg/htm/rsg_a2_00.htm', 'A 2 00', 'GE', "
        "'Constitution', 0) RETURNING act_id").fetchone()[0]
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, source, "
        "stage, akn_xml, full_text, article_count) "
        "VALUES (%s, 'sil:GE/A 2 00/2024-01-01', 'fr', '2024-01-01', 'sil', 'parsed', '', 'texte', 5)", (ge,))
    project_legacy_stage.run(settings)
    assert conn.execute(
        "SELECT source, metadata_json->>'jurisdiction' FROM ch_legislation "
        "WHERE eli_uri = 'https://silgeneve.ch/legis/program/books/rsg/htm/rsg_a2_00.htm'"
    ).fetchone() == ("sil", "GE"), "a phase-2 source keeps its own name in the projection"
    federal = conn.execute(
        "SELECT source, metadata_json->>'jurisdiction' FROM ch_legislation "
        "WHERE eli_uri NOT LIKE 'https://bgs.zg.ch/%' AND eli_uri NOT LIKE 'https://silgeneve.ch/%'").fetchall()
    assert all(r == ("fedlex", "CH") for r in federal)


# --- F2 review fix: a pdf-a edition must not evict a real XML edition ---
# _LATEST_PARSED_VERSION picked DISTINCT ON (act_id, lang) purely by
# date_applicability, with no source preference. A pdf-a edition
# (source='fedlex_pdf') that post-dates every XML edition of the same act
# therefore won, and _PROJECT's ON CONFLICT overwrote ch_legislation's real
# akn_xml/article_count with NULL. The fix: prefer the latest non-pdf parsed
# row when the act+lang has one; fall back to the latest pdf row only when
# every parsed row for that act+lang is pdf-a.

def _pdf_edition(conn, date, text, lang="de"):
    """A parsed fedlex_pdf edition -- no akn_xml, no article_count (PDF-era
    prose has no e_id structure to split on), same shape
    fedlex_pdf_text_stage.complete_version() leaves behind."""
    act_id = conn.execute(
        "SELECT act_id FROM ch_act WHERE eli_work_uri = %s", (WORK,)).fetchone()[0]
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, source, stage, full_text) "
        "VALUES (%s, %s, %s, %s, 'fedlex_pdf', 'parsed', %s)",
        (act_id, f"{WORK}/{date}/pdf", lang, date, text))


def test_a_newer_pdf_edition_does_not_evict_the_xml_edition(conn, settings):
    vid = _edition(conn, "2020-01-01", "alte Fassung")
    conn.execute("UPDATE ch_act_version SET akn_xml='<akomaNtoso/>', article_count=5 "
                "WHERE version_id=%s", (vid,))
    _pdf_edition(conn, "2026-01-01", "neue pdf Fassung")

    assert project_legacy_stage.run(settings) == 1
    row = conn.execute(
        "SELECT full_text, akn_xml, (metadata_json->>'article_count')::int "
        "FROM ch_legislation WHERE lang='de'").fetchone()
    assert row == ("alte Fassung", "<akomaNtoso/>", 5)


def test_an_act_with_only_pdf_editions_projects_with_akn_xml_null(conn, settings):
    """A pure gain: this act previously projected nothing at all (no parsed
    row existed for it). akn_xml NULL here is honest, not a regression."""
    _pdf_edition(conn, "2026-01-01", "pdf only Fassung")

    assert project_legacy_stage.run(settings) == 1
    row = conn.execute(
        "SELECT full_text, akn_xml FROM ch_legislation WHERE lang='de'").fetchone()
    assert row == ("pdf only Fassung", None)
