import os
import pathlib
import urllib.parse
import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema
from chpipe import fedlex_queries as fq
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
        reset_legislation_schema(c)
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
    assert row["editions"] == 2
    assert row["articles_latest"] == 3
    assert row["changes"] == 2


# --- CQ-8 (fedlex-pdf-text task, folded in from Task 1's review): a parsed
# fedlex_pdf row must not inflate gate_e's `editions` count.
#
# `editions` is compared against fedlex_editions -- Fedlex's own count of the
# act's XML manifestations (cross_check_fedlex/coverage_line) -- so it has to
# stay an XML-source count on this side too. Once fedlex_pdf_text_stage
# starts moving pdf-a rows to stage='parsed', an unfiltered count would grow
# past what Fedlex's XML side could ever match, and gate_e would report a
# false mismatch on every control act with pre-XML editions (which is most
# of them -- see versions_stage's module docstring).
def test_gate_e_editions_excludes_parsed_pdf_rows(conn):
    acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026-01-01",
        "dateApplicability": "2026-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=3 "
                 "WHERE version_id=%s", (vid,))
    before = reports_leg.gate_e(conn, ["220"])[0]["editions"]

    status = versions_stage.upsert_pdf_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/1995-01-01",
        "dateApplicability": "1995-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/1995.pdf"})
    assert status == "upserted"
    conn.execute("UPDATE ch_act_version SET stage='parsed', "
                 "full_text='some pdf-a text' "
                 "WHERE eli_consolidation_uri=%s", (f"{WORK}/1995-01-01",))

    after = reports_leg.gate_e(conn, ["220"])[0]
    assert after["editions"] == before == 1


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


def _query_of(request) -> str:
    """The SPARQL text out of a form-encoded POST body. SparqlClient posts
    `data={"query": ...}`, so the raw body is percent-encoded and matching
    an IRI against it directly silently never matches."""
    return urllib.parse.parse_qs(request.content.decode())["query"][0]


def _capture_queries(sent: list, count: int = 1):
    """A transport that records every query it is asked to run."""
    def handler(request):
        sent.append(_query_of(request))
        return httpx.Response(200, json=_fedlex_rows_fixture(count))
    return httpx.MockTransport(handler)


# --- Finding 3: the language split inside one comparison ---
# fedlex_edition_count() took Fedlex's "DEU" while gate_e() hardcoded 'de'.
# Passing the ISO code the rest of the package uses built
# .../authority/language/de -- a well-formed IRI binding nothing -- and the
# call returned 0 in silence. Reproduced live on 2026-08-23:
# fedlex_edition_count(c, "220") = 14, the same call with lang="de" = 0.

def test_fedlex_edition_count_takes_the_iso_code_the_rest_of_the_package_uses():
    """'de' must reach the endpoint as the authority code DEU, not as 'de'."""
    sent: list = []
    client = SparqlClient("https://fake/sparql", transport=_capture_queries(sent, 14))
    assert reports_leg.fedlex_edition_count(client, "220", lang="de") == 14
    assert "language/DEU" in sent[0]
    assert "language/de>" not in sent[0], (
        "an unmapped code builds a well-formed IRI that binds nothing and "
        "silently answers 0 -- the exact defect this signature closes")


def test_an_unknown_language_raises_instead_of_counting_zero():
    """In a gate, 0 does not read as a broken call -- it reads as a finding."""
    client = SparqlClient("https://fake/sparql", transport=_capture_queries([], 14))
    with pytest.raises(fq.UnknownLanguage):
        reports_leg.fedlex_edition_count(client, "220", lang="xx")


def test_fedlexs_own_authority_code_is_rejected_too():
    """One vocabulary at the boundary. Accepting both is how the two halves
    of one comparison came to be configured in two of them."""
    client = SparqlClient("https://fake/sparql", transport=_capture_queries([], 14))
    with pytest.raises(fq.UnknownLanguage):
        reports_leg.fedlex_edition_count(client, "220", lang="DEU")


def test_gate_e_echoes_the_language_it_counted_with(conn):
    """cross_check_fedlex() drives its query from this, so the local and
    network halves cannot be configured separately."""
    assert reports_leg.gate_e(conn, ["220"])[0]["lang"] == "de"


def test_gate_e_counts_the_language_it_was_asked_for(conn):
    """The local half used to hardcode 'de' regardless of the caller."""
    act_id = acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    for lang in ("DEU", "FRA"):
        vid = versions_stage.upsert_version(conn, {
            "work": WORK, "consolidation": f"{WORK}/2026-01-01/{lang}",
            "dateApplicability": "2026-01-01", "lang": L + lang,
            "fileUrl": "https://x/x.xml"})
        conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=%s "
                     "WHERE version_id=%s", (7 if lang == "FRA" else 3, vid))
    assert act_id
    assert reports_leg.gate_e(conn, ["220"], lang="fr")[0]["articles_latest"] == 7


# --- Finding 1: the gate could not show its own ceiling ---
# Both sides of the fedlex_editions comparison are constrained to XML, so it
# can only confirm we fetched what we chose to look for. Measured live on
# 2026-08-24: SR 220 is 14 of 14 XML editions and 14 of 100 consolidations.

def test_cross_check_reports_the_ceiling_not_only_the_xml_subset(conn):
    _seed_one_parsed_edition(conn)
    rows = reports_leg.gate_e(conn, ["220"])
    sent: list = []
    # The XML query answers 1 row, the ceiling query 5 -- distinguished by
    # the userFormat clause only the first one carries.
    def handler(request):
        body = _query_of(request)
        sent.append(body)
        n = 1 if "user-format/xml" in body else 5
        return httpx.Response(200, json=_fedlex_rows_fixture(n))

    client = SparqlClient("https://fake/sparql",
                          transport=httpx.MockTransport(handler))
    row = reports_leg.cross_check_fedlex(rows, client)[0]
    assert row["fedlex_editions"] == 1
    assert row["fedlex_consolidations"] == 5
    assert any("user-format/xml" not in q for q in sent), (
        "the ceiling query must not carry the very filter it exists to lift")


def test_cross_check_renders_both_pairs_in_one_line(conn):
    _seed_one_parsed_edition(conn)
    rows = reports_leg.gate_e(conn, ["220"])
    client = SparqlClient(
        "https://fake/sparql",
        transport=httpx.MockTransport(lambda request: httpx.Response(
            200, json=_fedlex_rows_fixture(
                1 if "user-format/xml" in _query_of(request) else 5))))
    row = reports_leg.cross_check_fedlex(rows, client)[0]
    assert row["coverage"] == "220: 1 of 5 (XML: 1 of 1)"


def _seed_one_parsed_edition(conn):
    acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026-01-01",
        "dateApplicability": "2026-01-01", "lang": L + "DEU",
        "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed' WHERE version_id=%s", (vid,))
    return vid


def test_cross_check_fedlex_annotates_only_found_rows(conn):
    _seed_one_parsed_edition(conn)

    rows = reports_leg.gate_e(conn, ["220", "999"])   # 220 found, 999 not loaded
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=_fedlex_rows_fixture(1)))
    client = SparqlClient("https://fake/sparql", transport=transport)

    annotated = reports_leg.cross_check_fedlex(rows, client)
    found, missing = annotated
    assert found["sr_number"] == "220" and found["fedlex_editions"] == 1
    assert missing["sr_number"] == "999" and "fedlex_editions" not in missing
    assert "fedlex_consolidations" not in missing and "coverage" not in missing


# --- Gate E's change count must be scoped like its siblings ---
#
# `editions` and `articles_latest` filter on lang; `changes` did not, so a
# German gate on a corpus loaded in de/fr/it reported roughly three times the
# changes its own edition count could account for -- and changes-per-edition
# is the ratio a reader takes from this gate.

def test_gate_e_counts_only_this_languages_changes(conn):
    act_id = acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026", "dateApplicability": "2026-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=1 "
                 "WHERE version_id=%s", (vid,))
    vfr = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026", "dateApplicability": "2026-01-01",
        "lang": L + "FRA", "fileUrl": "https://x/x-fr.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=1 "
                 "WHERE version_id=%s", (vfr,))
    for version_id, lang in ((vid, "de"), (vfr, "fr")):
        conn.execute("INSERT INTO ch_act_change (act_id, lang, to_version_id, "
                     "e_id, change_type, date_applicability) "
                     "VALUES (%s,%s,%s,'art_1','modified','2026-01-01')",
                     (act_id, lang, version_id))

    assert reports_leg.gate_e(conn, ["220"], lang="de")[0]["changes"] == 1
    assert reports_leg.gate_e(conn, ["220"], lang="fr")[0]["changes"] == 1


def test_gate_e_editions_and_changes_stay_countable_against_each_other(conn):
    """The invariant the missing filter broke: a gate reporting N editions in
    a language cannot report changes from editions it did not count."""
    act_id = acts_stage.upsert_act(conn, {"work": WORK, "srNotation": "220"})
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026", "dateApplicability": "2026-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', article_count=1 "
                 "WHERE version_id=%s", (vid,))
    for lang in ("fr", "it"):
        conn.execute("INSERT INTO ch_act_change (act_id, lang, e_id, "
                     "change_type, date_applicability) "
                     "VALUES (%s,%s,'art_1','modified','2026-01-01')", (act_id, lang))

    row = reports_leg.gate_e(conn, ["220"], lang="de")[0]
    assert row["editions"] == 1
    assert row["changes"] == 0, \
        "changes from editions this gate did not count must not appear"
