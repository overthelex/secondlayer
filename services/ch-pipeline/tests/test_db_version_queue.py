"""Recovery for the ch_act_version queue: retry_failed_versions() and
failed_by_stage_versions().

Finding 2 of the whole-branch review. The legislation half had no recovery
path at all while three comments promised one -- fail_version()'s docstring
("failed_stage lets db.retry_failed()'s sibling send the row back to where
it actually died"), migration 197's COMMENT ON ch_act_version.failed_stage,
and README.md, which told the operator to run db.retry_failed(). There is no
sibling: retry_failed() touches ch_court_decisions only, so against a
legislation backlog it returns 0 and does nothing -- which reads exactly like
"there was nothing to retry". These tests pin down the sibling.

Written against the real scratch Postgres and migration 197's real DDL, not
a mock: the whole behaviour under test is what an UPDATE's WHERE clause
matches, which a mocked connection cannot tell you anything about.
"""
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema
from chpipe import db
from chpipe.stages import acts_stage, versions_stage

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
OTHER_WORK = "https://fedlex.data.admin.ch/eli/cc/24/233_245_233"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        reset_legislation_schema(c)
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        acts_stage.upsert_act(c, {"work": OTHER_WORK, "srNotation": "210"})
        yield c


def _version(conn, date="2026-01-01", work=WORK, stage="discovered"):
    vid = versions_stage.upsert_version(conn, {
        "work": work, "consolidation": f"{work}/{date}", "dateApplicability": date,
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage=%s WHERE version_id=%s",
                 (stage, vid))
    return vid


def _retire(conn, version_id, error="boom"):
    """Spend the whole attempts budget, which is what moves a row to
    'failed' and stamps failed_stage -- via the real fail_version(), not by
    writing the terminal state by hand."""
    for _ in range(3):
        db.fail_version(conn, version_id, error, max_attempts=3)


def _row(conn, version_id):
    return conn.execute(
        "SELECT stage, attempts, failed_stage, last_error FROM ch_act_version "
        "WHERE version_id=%s", (version_id,)).fetchone()


def test_a_failed_edition_goes_back_to_the_stage_it_died_in(conn):
    """Not to the front of the queue: a row that died in 'fetched' has
    already been downloaded, and re-fetching it throws that away."""
    vid = _version(conn, stage="fetched")
    _retire(conn, vid)
    assert _row(conn, vid)[0] == "failed"

    assert db.retry_failed_versions(conn) == 1

    stage, attempts, failed_stage, _ = _row(conn, vid)
    assert stage == "fetched"
    assert attempts == 0
    assert failed_stage is None


def test_the_attempts_budget_is_cleared_so_the_row_is_claimable_again(conn):
    vid = _version(conn, stage="discovered")
    _retire(conn, vid)
    db.retry_failed_versions(conn)
    assert len(db.claim_versions(conn, "discovered", limit=10)) == 1


def test_last_error_survives_a_retry(conn):
    """It is the evidence the decision to retry was based on. Only a real
    success (complete_version()) clears it."""
    vid = _version(conn, stage="fetched")
    _retire(conn, vid, error="response is not Akoma Ntoso XML (412 bytes)")
    db.retry_failed_versions(conn)
    assert "not Akoma Ntoso" in _row(conn, vid)[3]


def test_an_explicit_stage_overrides_the_recorded_one(conn):
    """For the case where the operator genuinely means to re-fetch."""
    vid = _version(conn, stage="fetched")
    _retire(conn, vid)
    assert db.retry_failed_versions(conn, stage="discovered") == 1
    assert _row(conn, vid)[0] == "discovered"


def test_a_row_with_no_recorded_stage_is_left_alone(conn):
    """There is nothing to return it to, and re-queueing it just burns
    another budget. Same decision as retry_failed()."""
    vid = _version(conn, stage="failed")
    conn.execute("UPDATE ch_act_version SET failed_stage=NULL, attempts=3 "
                 "WHERE version_id=%s", (vid,))
    assert db.retry_failed_versions(conn) == 0
    assert _row(conn, vid)[0] == "failed"


def test_an_explicit_stage_does_reach_a_row_with_no_recorded_stage(conn):
    vid = _version(conn, stage="failed")
    conn.execute("UPDATE ch_act_version SET failed_stage=NULL, attempts=3 "
                 "WHERE version_id=%s", (vid,))
    assert db.retry_failed_versions(conn, stage="discovered") == 1
    assert _row(conn, vid)[0] == "discovered"


def test_rows_that_have_not_failed_are_untouched(conn):
    healthy = _version(conn, "2020-01-01", stage="fetched")
    broken = _version(conn, "2021-01-01", stage="discovered")
    _retire(conn, broken)
    assert db.retry_failed_versions(conn) == 1
    assert _row(conn, healthy)[0] == "fetched"


def test_the_retry_can_be_narrowed_to_one_act(conn):
    """The twin of retry_failed()'s spider filter: a diagnosis about one
    act's editions must be actionable without re-queueing the corpus."""
    mine = _version(conn, "2020-01-01", work=WORK, stage="fetched")
    theirs = _version(conn, "2020-01-01", work=OTHER_WORK, stage="fetched")
    _retire(conn, mine)
    _retire(conn, theirs)
    act_id = conn.execute("SELECT act_id FROM ch_act_version WHERE version_id=%s",
                          (mine,)).fetchone()[0]

    assert db.retry_failed_versions(conn, act_id=act_id) == 1
    assert _row(conn, mine)[0] == "fetched"
    assert _row(conn, theirs)[0] == "failed"


def test_failed_by_stage_versions_is_the_triage_query(conn):
    """Without it there is no way to see WHERE a growing failed population
    died, only that it exists."""
    for date in ("2020-01-01", "2021-01-01"):
        _retire(conn, _version(conn, date, stage="fetched"))
    _retire(conn, _version(conn, "2022-01-01", stage="discovered"))

    assert db.failed_by_stage_versions(conn) == [("fetched", 2), ("discovered", 1)]


def test_failed_by_stage_versions_ignores_rows_that_have_not_failed(conn):
    _version(conn, "2020-01-01", stage="fetched")
    assert db.failed_by_stage_versions(conn) == []


def test_the_recovery_pair_reads_the_version_table_not_the_decisions_table(conn):
    """The defect itself: db.retry_failed() returns 0 against a legislation
    backlog because it names ch_court_decisions, and 0 reads as 'nothing to
    retry' rather than as 'wrong table'."""
    vid = _version(conn, stage="fetched")
    _retire(conn, vid)
    assert db.retry_failed_versions(conn) == 1
    assert _row(conn, vid)[0] == "fetched"


def test_claim_is_filtered_by_source_and_url_prefix(conn):
    """Migration 201: the AKN parser and the Lexwork parser share this queue
    and must never see each other's payloads."""
    act = conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('be/101.1', 'BE') "
                       "RETURNING act_id").fetchone()[0]
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "source, xml_url) VALUES (%s, 'be/101.1/v1', 'de', '2020-01-01', 'lexwork', "
                 "'https://www.belex.sites.be.ch/api/de/texts_of_law/101.1/versions/1/show_as_json')", (act,))
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "source, xml_url) VALUES (%s, 'zg/101.1/v1', 'de', '2020-01-01', 'lexwork', "
                 "'https://bgs.zg.ch/api/de/texts_of_law/101.1/versions/1/show_as_json')", (act,))
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability) "
                 "VALUES (%s, 'fedlex/x', 'de', '2020-01-01')", (act,))
    fedlex = db.claim_versions(conn, "discovered", 10, backoff_minutes=())
    assert [r["source"] for r in fedlex] == ["fedlex"]
    assert fedlex[0]["eli_consolidation_uri"] == "fedlex/x"
    lexwork = db.claim_versions(conn, "discovered", 10, backoff_minutes=(), source="lexwork")
    assert sorted(r["eli_consolidation_uri"] for r in lexwork) == ["be/101.1/v1", "zg/101.1/v1"]
    one_host = db.claim_versions(conn, "discovered", 10, backoff_minutes=(), source="lexwork",
                                 url_prefix="https://bgs.zg.ch/")
    assert [r["eli_consolidation_uri"] for r in one_host] == ["zg/101.1/v1"]
