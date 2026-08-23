import os
import pathlib
import httpx
import psycopg
import pytest
from chpipe import reports_leg
from chpipe.sparql import SparqlClient
from chpipe.stages import acts_stage, versions_stage

# Derive repo root from this file's location -- see test_project_legacy_stage.py
# for why (must resolve identically whether pytest runs from services/ch-pipeline
# or from the repo root).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        yield c


def test_gate_e_reports_a_control_act_that_is_missing(conn):
    rows = reports_leg.gate_e(conn, ["220"])
    assert rows[0]["sr_number"] == "220"
    assert rows[0]["found"] is False


def test_gate_e_counts_editions_articles_and_changes(conn):
    act_id = acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    for date in ("2020-01-01", "2026-01-01"):
        vid = versions_stage.upsert_version(conn, {
            "work": WORK, "consolidation": f"{WORK}/{date}",
            "dateApplicability": date, "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
        conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=3 "
                     "WHERE version_id=%s", (vid,))
        for i in range(3):
            conn.execute("INSERT INTO ch_act_article (version_id, e_id, "
                         "article_number, text, ordinal) VALUES (%s,%s,%s,'t',%s)",
                         (vid, f"art_{i}", str(i), i))
        conn.execute("INSERT INTO ch_act_change (act_id, to_version_id, e_id, "
                     "change_type, date_applicability) VALUES (%s,%s,'art_1',"
                     "'modified',%s)", (act_id, vid, date))
    row = reports_leg.gate_e(conn, ["220"])[0]
    assert row["found"] is True
    assert row["editions_de"] == 2
    assert row["articles_latest"] == 3
    assert row["changes"] == 2


# A missing control act on a partially-seeded scratch database is a routine
# outcome, not a corpus finding -- the note must say so plainly rather than
# reading like "this act is missing from the corpus".
def test_gate_e_missing_reads_as_not_loaded_not_missing_from_corpus(conn):
    rows = reports_leg.gate_e(conn, ["220"])
    assert "not loaded" in rows[0]["note"].lower()


def test_gate_e_defaults_to_the_three_control_acts(conn):
    rows = reports_leg.gate_e(conn)
    assert [r["sr_number"] for r in rows] == reports_leg.CONTROL_ACTS


def test_control_acts_are_the_three_named_codes():
    assert reports_leg.CONTROL_ACTS == ["220", "210", "311.0"]


def test_corpus_summary_counts_each_table(conn):
    acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    summary = reports_leg.corpus_summary(conn)
    assert summary["acts"] == 1
    assert summary["with_sr"] == 1
    assert summary["in_force"] == 0
    assert summary["versions"] == 0
    assert summary["parsed"] == 0
    assert summary["articles"] == 0
    assert summary["changes"] == 0


# --- The network half of Gate E (fix round 1's finding): landed as a named
# query in fedlex_queries.py plus these two companion functions, rather than
# living only as prose in a report and a scratch script. Mocked here with
# httpx.MockTransport, same pattern as test_fedlex_queries.py's dual-status
# test -- no live network call belongs in the unit suite. The live numbers
# these functions actually produced against Fedlex (14/14, 11/11, 19-vs-20)
# are reported in the task report, not asserted here: this endpoint is a
# live government dataset, and pinning today's counts into the suite would
# make ordinary drift a test failure.

def _fedlex_rows_fixture(count: int):
    return {
        "head": {"vars": ["c"]},
        "results": {"bindings": [
            {"c": {"type": "uri",
                   "value": f"https://fedlex.data.admin.ch/eli/cc/x/{i}"}}
            for i in range(count)
        ]},
    }


def test_fedlex_edition_count_counts_rows_not_a_sparql_aggregate():
    """EDITIONS_BY_SR is SELECT DISTINCT ?c, not COUNT(DISTINCT ?c) -- see
    fedlex_queries.py's own warning that COUNT(DISTINCT ...) is unreliable
    on this endpoint. fedlex_edition_count() must count the rows itself."""
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=_fedlex_rows_fixture(14)))
    client = SparqlClient("https://fake/sparql", transport=transport)
    assert reports_leg.fedlex_edition_count(client, "220") == 14


def test_cross_check_fedlex_annotates_only_found_rows(conn):
    acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026-01-01",
        "dateApplicability": "2026-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed' WHERE version_id=%s", (vid,))

    rows = reports_leg.gate_e(conn, ["220", "999"])   # 220 found, 999 not loaded
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=_fedlex_rows_fixture(1)))
    client = SparqlClient("https://fake/sparql", transport=transport)

    annotated = reports_leg.cross_check_fedlex(rows, client)
    found, missing = annotated
    assert found["sr_number"] == "220" and found["fedlex_editions"] == 1
    assert missing["sr_number"] == "999" and "fedlex_editions" not in missing
