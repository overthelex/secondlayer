import os
import pathlib
import psycopg
import pytest
from chpipe.config import Settings
from chpipe.stages import acts_stage, diff_stage, versions_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_diff_stage.py is 3 levels down from the repo root -- paths must
# resolve from __file__, never from the working directory a suite happens to
# be invoked from (this file is run from both the service directory and the
# repo root; see the two full-suite commands in the task brief).
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
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _edition(conn, date, articles):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    for ordinal, (e_id, text) in enumerate(articles, start=1):
        conn.execute(
            "INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
            "ordinal) VALUES (%s,%s,%s,%s,%s)",
            (vid, e_id, e_id.split("_")[-1], text, ordinal))
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=%s "
                 "WHERE version_id=%s", (len(articles), vid))
    return vid


def test_the_first_edition_produces_no_changes(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "x")])
    report = diff_stage.run(settings)
    assert report.changes == 0, "there is nothing before the first edition"


def test_a_modified_article_is_recorded_against_the_later_edition(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "Der Vertrag ist gültig.")])
    v2 = _edition(conn, "2022-01-01", [("art_1", "Der Vertrag ist nichtig.")])
    diff_stage.run(settings)
    row = conn.execute(
        "SELECT e_id, change_type, to_version_id, date_applicability "
        "FROM ch_act_change").fetchone()
    assert row[0] == "art_1"
    assert row[1] == "modified"
    assert row[2] == v2
    assert str(row[3]) == "2022-01-01"


def test_three_editions_produce_two_comparisons(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "a")])
    _edition(conn, "2022-01-01", [("art_1", "b")])
    _edition(conn, "2024-01-01", [("art_1", "c")])
    assert diff_stage.run(settings).changes == 2


def test_editions_are_compared_in_date_order_not_insertion_order(conn, settings):
    _edition(conn, "2024-01-01", [("art_1", "late")])
    _edition(conn, "2020-01-01", [("art_1", "early")])
    diff_stage.run(settings)
    row = conn.execute(
        "SELECT date_applicability FROM ch_act_change").fetchone()
    assert str(row[0]) == "2024-01-01", "the change belongs to the later edition"


def test_rerunning_does_not_duplicate_changes(conn, settings):
    _edition(conn, "2020-01-01", [("art_1", "a")])
    _edition(conn, "2022-01-01", [("art_1", "b")])
    diff_stage.run(settings)
    diff_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_act_change").fetchone()[0] == 1


def test_languages_are_diffed_separately(conn, settings):
    """A German wording change must not be reported against the French edition."""
    v_de = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2020", "dateApplicability": "2020-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/de.xml"})
    v_fr = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2020", "dateApplicability": "2020-01-01",
        "lang": L + "FRA", "fileUrl": "https://x/fr.xml"})
    for vid, text in ((v_de, "deutsch"), (v_fr, "francais")):
        conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, "
                     "text, ordinal) VALUES (%s,'art_1','1',%s,1)", (vid, text))
        conn.execute("UPDATE ch_act_version SET stage='parsed' WHERE version_id=%s",
                     (vid,))
    assert diff_stage.run(settings, lang="de").changes == 0


def test_a_rerun_against_a_corrected_baseline_overwrites_the_existing_record(
        conn, settings):
    """Migration 197's ux_ch_act_change key is (to_version_id, e_id), not
    (to_version_id, e_id, change_type): an article cannot be both added and
    repealed in the same edition, and a re-diff against a corrected input
    (a fixed article_number mapping, a corrected date_applicability) must
    overwrite the existing row in place, not leave it stale beside a second,
    contradictory one."""
    v1 = _edition(conn, "2020-01-01", [("art_1", "Der Text.")])
    v2 = _edition(conn, "2022-01-01", [("art_1", "Aufgehoben")])
    diff_stage.run(settings)
    row = conn.execute(
        "SELECT change_type, article_number, date_applicability, from_version_id "
        "FROM ch_act_change").fetchone()
    assert row[0] == "repealed"

    # Simulate an upstream correction: the eId->number mapping for this
    # article gets fixed, and so does the edition's own date_applicability.
    conn.execute("UPDATE ch_act_article SET article_number = '1bis' "
                "WHERE e_id = 'art_1' AND version_id = %s", (v2,))
    conn.execute("UPDATE ch_act_version SET date_applicability = '2022-06-01' "
                "WHERE version_id = %s", (v2,))
    diff_stage.run(settings)

    rows = conn.execute(
        "SELECT change_type, article_number, date_applicability, from_version_id "
        "FROM ch_act_change").fetchall()
    assert len(rows) == 1, "the corrected re-diff replaces the row, not adds one"
    assert rows[0][0] == "repealed"
    assert rows[0][1] == "1bis"
    assert str(rows[0][2]) == "2022-06-01"
    assert rows[0][3] == v1


def test_one_bad_act_does_not_abort_the_walk_over_the_rest(conn, settings, monkeypatch):
    """Same defect class as every other stage on this branch: one act with
    malformed articles raising out of _articles()/diff() must not kill a run
    over thousands of other acts. Guard the per-act body, count the failure,
    move on."""
    _edition(conn, "2020-01-01", [("art_1", "a")])
    _edition(conn, "2022-01-01", [("art_1", "b")])

    bad_act_id = acts_stage.upsert_act(conn, {"work": WORK + "/bad", "srNotation": "999"})
    bad_v1 = versions_stage.upsert_version(conn, {
        "work": WORK + "/bad", "consolidation": WORK + "/bad/2020",
        "dateApplicability": "2020-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/bad1.xml"})
    bad_v2 = versions_stage.upsert_version(conn, {
        "work": WORK + "/bad", "consolidation": WORK + "/bad/2022",
        "dateApplicability": "2022-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/bad2.xml"})
    for vid in (bad_v1, bad_v2):
        conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, "
                     "text, ordinal) VALUES (%s,'art_1','1','x',1)", (vid,))
        conn.execute("UPDATE ch_act_version SET stage='parsed' WHERE version_id=%s",
                     (vid,))

    real_articles = diff_stage._articles

    def flaky_articles(conn, version_id):
        if version_id == bad_v2:
            raise ValueError("malformed article payload")
        return real_articles(conn, version_id)

    monkeypatch.setattr(diff_stage, "_articles", flaky_articles)

    report = diff_stage.run(settings)

    assert report.errors == 1
    # The good act (WORK) still produced its change: the exception inside
    # the bad act's body did not unwind the loop over the rest of ch_act.
    rows = conn.execute(
        "SELECT act_id FROM ch_act_change c JOIN ch_act a USING (act_id) "
        "WHERE a.eli_work_uri = %s", (WORK,)).fetchall()
    assert len(rows) == 1
    # The bad act produced nothing -- its exception was caught before any
    # change for it was written.
    bad_rows = conn.execute(
        "SELECT change_id FROM ch_act_change WHERE act_id = %s", (bad_act_id,)).fetchall()
    assert bad_rows == []
