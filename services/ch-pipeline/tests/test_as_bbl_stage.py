"""Discovery of Official Compilation (AS) and Federal Gazette (BBl) acts, and
the jolux:basicAct links from a Classified Compilation entry to the act that
established it.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_as_bbl_stage.py
"""
import os
import pathlib

import psycopg
import pytest

from chpipe import fedlex_queries as fq
from chpipe.config import Settings
from chpipe.stages import acts_stage, as_bbl_stage, basic_act_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/…
# is 3 levels down from the repo root -- same convention as test_acts_stage.py
# and test_versions_stage.py.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
M198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"

# Verified live against Fedlex on 2026-08-24: eli/cc/27/317_321_377 (SR 220,
# the Code of Obligations) carries jolux:basicAct eli/oc/27/317_321_377.
CC = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
OC = "https://fedlex.data.admin.ch/eli/oc/27/317_321_377"
FGA = "https://fedlex.data.admin.ch/eli/fga/1986/2_354_354_354"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    # load_ceiling=0.0 disables throttle.should_pause()'s guard entirely --
    # see throttle.py. A real ceiling in a fixture parks every test in this
    # file in a 60-second sleep loop whenever the box's load happens to be
    # high, turning a fast suite into a hang rather than a failure.
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        for t in ("ch_article_provenance", "ch_act_amendment_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        yield c


# --------------------------------------------------------------------------
# fedlex_queries.collection_of()
# --------------------------------------------------------------------------

def test_collection_of_reads_the_eli_segment():
    """Verified on the real graph: cc = Classified Compilation (handled by
    ACTS/acts_stage, not here), oc = Official Compilation (AS), fga =
    Federal Gazette (BBl)."""
    assert fq.collection_of(OC) == "AS"
    assert fq.collection_of(FGA) == "BBl"
    assert fq.collection_of(CC) is None


def test_collection_of_handles_none_and_empty():
    assert fq.collection_of(None) is None
    assert fq.collection_of("") is None


# --------------------------------------------------------------------------
# fedlex_queries.AS_ACTS / BASIC_ACTS: shape, not content -- the live walk is
# exercised separately below and by the module-level manual run.
# --------------------------------------------------------------------------

def test_as_acts_and_basic_acts_are_select_distinct():
    assert "SELECT DISTINCT" in fq.AS_ACTS
    assert "SELECT DISTINCT" in fq.BASIC_ACTS


def test_as_acts_and_basic_acts_walk_by_key_not_offset():
    """The regression guard from chpipe/sparql.py: SparqlClient.keyset()
    refuses any template containing OFFSET, and the brief's own
    LIMIT/OFFSET template would raise ValueError before a single request
    reached the endpoint."""
    for name, query in (("AS_ACTS", fq.AS_ACTS), ("BASIC_ACTS", fq.BASIC_ACTS)):
        assert "OFFSET" not in query.upper(), f"{name} walks by offset again"
        assert '>= "%(after)s")' in query, f"{name} is missing the keyset filter"
        assert "LIMIT %(limit)d" in query, f"{name} is missing the page limit"
        assert query.strip().startswith("PREFIX") or "PREFIX" in query


def test_as_acts_orders_by_the_key_it_pages_on():
    assert "ORDER BY ?act" in fq.AS_ACTS


def test_basic_acts_orders_by_the_key_it_pages_on():
    assert "ORDER BY ?work" in fq.BASIC_ACTS


# --------------------------------------------------------------------------
# as_bbl_stage.upsert_as_act()
# --------------------------------------------------------------------------

def test_stores_an_official_compilation_act(conn):
    as_id = as_bbl_stage.upsert_as_act(conn, {"act": OC, "dateDocument": "1911-03-30"})
    row = conn.execute("SELECT eli_uri, collection, date_document FROM ch_as_act "
                       "WHERE as_id=%s", (as_id,)).fetchone()
    assert row[0] == OC
    assert row[1] == "AS"
    assert str(row[2]) == "1911-03-30"


def test_stores_a_federal_gazette_act(conn):
    as_id = as_bbl_stage.upsert_as_act(conn, {"act": FGA})
    assert conn.execute("SELECT collection FROM ch_as_act WHERE as_id=%s",
                        (as_id,)).fetchone()[0] == "BBl"


def test_an_eli_from_neither_collection_is_skipped(conn):
    assert as_bbl_stage.upsert_as_act(conn, {"act": CC}) is None
    assert conn.execute("SELECT count(*) FROM ch_as_act").fetchone()[0] == 0


def test_upsert_is_idempotent(conn):
    first = as_bbl_stage.upsert_as_act(conn, {"act": OC})
    second = as_bbl_stage.upsert_as_act(conn, {"act": OC})
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_as_act").fetchone()[0] == 1


def test_a_later_upsert_does_not_null_out_a_field_the_new_row_left_empty(conn):
    """COALESCE on the way in: a later SPARQL page that (for whatever reason)
    returns the same act with a blank dateDocument must not erase a value
    already stored, the same discipline acts_stage.upsert_act() uses."""
    as_bbl_stage.upsert_as_act(conn, {"act": OC, "dateDocument": "1911-03-30"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    row = conn.execute("SELECT date_document FROM ch_as_act WHERE eli_uri=%s",
                       (OC,)).fetchone()
    assert str(row[0]) == "1911-03-30"


# --------------------------------------------------------------------------
# basic_act_stage.link()
# --------------------------------------------------------------------------

def test_links_a_cc_act_to_its_basic_act(conn):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    written = basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    assert written == 1
    row = conn.execute(
        "SELECT relation_type FROM ch_act_amendment_link").fetchone()
    assert row[0] == "basic_act"


def test_linking_twice_does_not_duplicate(conn):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    second = basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    assert second == 0
    assert conn.execute(
        "SELECT count(*) FROM ch_act_amendment_link").fetchone()[0] == 1


def test_a_link_whose_cc_act_is_unknown_writes_nothing(conn):
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    assert basic_act_stage.link(conn, {"work": "https://cc/never", "basicAct": OC}) == 0
    assert conn.execute(
        "SELECT count(*) FROM ch_act_amendment_link").fetchone()[0] == 0


def test_a_link_whose_as_act_is_unknown_writes_nothing(conn):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    assert basic_act_stage.link(conn, {"work": CC, "basicAct": "https://oc/never"}) == 0
    assert conn.execute(
        "SELECT count(*) FROM ch_act_amendment_link").fetchone()[0] == 0


# --------------------------------------------------------------------------
# run(): the reports both entry points return, driven through a fake
# SparqlClient the way test_versions_stage.py drives versions_stage.run() --
# never the live endpoint, so the suite stays deterministic and offline.
# --------------------------------------------------------------------------

class _FakeSparqlClient:
    """Stands in for chpipe.sparql.SparqlClient. keyset() ignores the query
    template's paging clauses entirely and just replays the rows it was
    built with -- the walk mechanics are sparql.py's own tests
    (test_sparql.py); what is under test here is what each stage's run()
    does with the rows it is handed."""

    def __init__(self, rows):
        self._rows = rows
        self.closed = False

    def keyset(self, query_template, key="work", page_size=2000):
        yield from self._rows

    def close(self):
        self.closed = True


def test_as_bbl_run_reports_discovered_and_by_collection(conn, settings, monkeypatch):
    fake = _FakeSparqlClient([
        {"act": OC, "dateDocument": "1911-03-30"},
        {"act": FGA},
        {"act": CC},  # neither AS nor BBl: skipped, not coerced
    ])
    monkeypatch.setattr(as_bbl_stage, "SparqlClient", lambda endpoint: fake)
    monkeypatch.setattr(as_bbl_stage.db, "connect", lambda s: conn)
    report = as_bbl_stage.run(settings)
    assert report.discovered == 2
    assert report.skipped == 1
    assert report.by_collection == {"AS": 1, "BBl": 1}
    assert fake.closed


def test_basic_act_run_reports_linked_missing_act_missing_as(conn, settings, monkeypatch):
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    fake = _FakeSparqlClient([
        {"work": CC, "basicAct": OC},                    # both known: linked
        {"work": "https://cc/never", "basicAct": OC},     # act missing
        {"work": CC, "basicAct": "https://oc/never"},     # as missing
    ])
    monkeypatch.setattr(basic_act_stage, "SparqlClient", lambda endpoint: fake)
    monkeypatch.setattr(basic_act_stage.db, "connect", lambda s: conn)
    report = basic_act_stage.run(settings)
    assert report.linked == 1
    assert report.missing_act == 1
    assert report.missing_as == 1
    assert fake.closed


def test_the_counters_partition_the_walk(conn, settings, monkeypatch):
    """Every row lands in exactly one counter, so the five sum to `seen`.

    A row missing on BOTH ends used to increment missing_act AND missing_as,
    so an operator adding the counters up to cross-check a run found a total
    larger than the walk -- on exactly the runs worth diagnosing, the ones
    after a partial acts_stage or as_bbl_stage. The both-missing row is the
    case the original test never seeded, which is why nothing caught it."""
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    rows = [
        {"work": CC, "basicAct": OC},                          # linked
        {"work": CC, "basicAct": OC},                          # already linked
        {"work": "https://cc/never", "basicAct": OC},          # act missing
        {"work": CC, "basicAct": "https://oc/never"},          # as missing
        {"work": "https://cc/never", "basicAct": "https://oc/never"},  # both
    ]
    fake = _FakeSparqlClient(rows)
    monkeypatch.setattr(basic_act_stage, "SparqlClient", lambda endpoint: fake)
    monkeypatch.setattr(basic_act_stage.db, "connect", lambda s: conn)
    report = basic_act_stage.run(settings)

    assert report.seen == len(rows)
    assert (report.linked + report.already_linked + report.missing_act
            + report.missing_as + report.missing_both) == report.seen
    assert report.missing_both == 1, "the both-missing row is its own answer"
    assert report.missing_act == 1 and report.missing_as == 1, \
        "and it must not also be counted as either one of them"
    assert report.linked == 1 and report.already_linked == 1


def test_basic_act_run_does_not_recount_an_already_linked_pair(conn, settings, monkeypatch):
    """The idempotent-relink case (both endpoints known, link already exists)
    must not show up as missing_act or missing_as -- neither is missing, the
    row is just already there."""
    acts_stage.upsert_act(conn, {"work": CC, "srNotation": "220"})
    as_bbl_stage.upsert_as_act(conn, {"act": OC})
    basic_act_stage.link(conn, {"work": CC, "basicAct": OC})
    fake = _FakeSparqlClient([{"work": CC, "basicAct": OC}])
    monkeypatch.setattr(basic_act_stage, "SparqlClient", lambda endpoint: fake)
    monkeypatch.setattr(basic_act_stage.db, "connect", lambda s: conn)
    report = basic_act_stage.run(settings)
    assert report.linked == 0
    assert report.missing_act == 0
    assert report.missing_as == 0
