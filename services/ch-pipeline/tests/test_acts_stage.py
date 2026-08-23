"""Discovery of Fedlex Systematic Compilation works into ch_act.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_acts_stage.py
"""
import os
import pathlib
import psycopg
import pytest
from chpipe.stages import acts_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/test_acts_stage.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "sr_number text, title text, PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        yield c


OR_ROW = {
    "work": "https://fedlex.data.admin.ch/eli/cc/27/317_321_377",
    "srNotation": "220",
    "dateDocument": "1911-03-30",
    "dateEntryForce": "1912-01-01",
    "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0",
}


def test_stores_the_real_sr_number(conn):
    """The whole point: the old table stored '1971/1069_1068_1068' here."""
    acts_stage.upsert_act(conn, OR_ROW)
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] == "220"


def test_status_zero_means_in_force(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (0, True)


def test_status_three_means_repealed(conn):
    acts_stage.upsert_act(conn, {**OR_ROW, "inForce":
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"})
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (3, False)


def test_a_work_with_no_status_is_stored_with_null_not_false(conn):
    """~4,296 works publish no status; recording them as 'not in force' would be
    an assertion Fedlex never made."""
    row = dict(OR_ROW)
    row.pop("inForce")
    acts_stage.upsert_act(conn, row)
    assert conn.execute(
        "SELECT enforcement_status, in_force FROM ch_act").fetchone() == (None, None)


def test_a_work_with_no_sr_notation_is_still_stored(conn):
    row = dict(OR_ROW)
    row.pop("srNotation")
    row["work"] = "https://fedlex.data.admin.ch/eli/cc/1/116_97_116"
    act_id = acts_stage.upsert_act(conn, row)
    assert act_id is not None
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] is None


def test_upsert_is_idempotent_and_returns_the_same_id(conn):
    first = acts_stage.upsert_act(conn, OR_ROW)
    second = acts_stage.upsert_act(conn, OR_ROW)
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 1


def test_apply_titles_writes_all_five_languages_and_the_abbreviation(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    L = "http://publications.europa.eu/resource/authority/language/"
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": L + "DEU", "title": "Bundesgesetz …",
         "titleShort": "OR"},
        {"work": OR_ROW["work"], "lang": L + "FRA", "title": "Loi fédérale …",
         "titleShort": "CO"},
        {"work": OR_ROW["work"], "lang": L + "ITA", "title": "Legge federale …"},
        {"work": OR_ROW["work"], "lang": L + "ENG", "title": "Federal Act …"},
        {"work": OR_ROW["work"], "lang": L + "ROH", "title": "Lescha federala …"},
    ])
    row = conn.execute(
        "SELECT title_de, title_fr, title_it, title_en, title_rm, abbreviation "
        "FROM ch_act").fetchone()
    assert row[0].startswith("Bundesgesetz")
    assert row[3].startswith("Federal Act")
    assert row[4].startswith("Lescha")
    assert row[5] == "OR"


def test_apply_titles_ignores_a_language_we_do_not_store(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": "http://example/unknown", "title": "x"}])
    assert conn.execute("SELECT title_de FROM ch_act").fetchone()[0] is None


def test_apply_titles_for_an_unknown_work_is_a_no_op(conn):
    assert acts_stage.apply_titles(conn, [
        {"work": "https://x/never-seen", "lang":
         "http://publications.europa.eu/resource/authority/language/DEU",
         "title": "x"}]) == 0


def test_conflicting_status_is_recorded_not_resolved(conn):
    """Twelve live works assert BOTH inForceStatus 0 and 3 for the same work
    (see fedlex_queries.ACTS's comment). Picking a winner would assert
    something Fedlex itself does not -- the honest answer is 'unknown',
    recorded loudly in metadata_json rather than silently defaulted."""
    work = "https://fedlex.data.admin.ch/eli/cc/2003/31"
    first = acts_stage.upsert_act(conn, {**OR_ROW, "work": work,
        "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"})
    second = acts_stage.upsert_act(conn, {**OR_ROW, "work": work,
        "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"})
    assert first == second

    row = conn.execute(
        "SELECT enforcement_status, in_force, metadata_json FROM ch_act "
        "WHERE eli_work_uri = %s", (work,)).fetchone()
    enforcement_status, in_force, metadata_json = row

    # 1. enforcement_status reads NULL, so the generated in_force is unknown,
    #    not silently False.
    assert enforcement_status is None
    assert in_force is None

    # 2. Both observed values are recorded in metadata_json under a clearly
    #    named key, so the row explains why it is unknown.
    assert sorted(metadata_json["status_conflict"]) == [0, 3]
