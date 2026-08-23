import asyncio
import os
import pathlib

import psycopg
import pytest
from chpipe import akn, db
from chpipe.config import Settings
from chpipe.http import FetchError
from chpipe.stages import acts_stage, fetch_xml_stage, parse_akn_stage, versions_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_parse_akn_stage.py is 3 levels down from the repo root -- paths must
# resolve from __file__, never from the working directory a suite happens
# to be invoked from (this file is run from both the service directory and
# the repo root; see the two full-suite commands in the task brief).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
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
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _version(conn, date="2026-01-01"):
    return versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/{date}", "dateApplicability": date,
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})


def _settings(raw_dir):
    return Settings(
        dsn=os.environ.get("CHPIPE_TEST_DSN", "unused"),
        raw_dir=raw_dir, http_concurrency=2, cpu_workers=1, ocr_workers=1,
        load_ceiling=6.0, max_attempts=3)


# --- Step 2 of the brief: the five prescribed parse_akn_stage tests ---

def test_stores_every_article_of_the_fixture(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    stored = parse_akn_stage.store_articles(conn, vid, articles)
    assert stored == len(articles)
    assert conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_reparsing_replaces_rather_than_duplicating(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    parse_akn_stage.store_articles(conn, vid, articles)
    assert conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_article_count_is_written_back_onto_the_version(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    assert conn.execute(
        "SELECT article_count FROM ch_act_version WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(articles)


def test_two_versions_of_one_act_keep_separate_article_sets(conn):
    v1, v2 = _version(conn, "2020-01-01"), _version(conn, "2026-01-01")
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, v1, articles)
    parse_akn_stage.store_articles(conn, v2, articles)
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == \
        2 * len(articles)


def test_nested_e_ids_survive_the_round_trip(conn):
    vid = _version(conn)
    articles = akn.parse_articles(FIXTURE.read_bytes())
    parse_akn_stage.store_articles(conn, vid, articles)
    nested = conn.execute(
        "SELECT count(*) FROM ch_act_article WHERE version_id=%s AND e_id LIKE %s",
        (vid, "%/%")).fetchone()[0]
    assert nested >= 1


# --- Decision 1: the version queue must carry the same discipline as the
# decisions queue -- a column allowlist, a loud QueueWriteMissed, attempts
# reset on a forward move, and failed_stage recorded. ---

def test_claim_versions_returns_only_the_requested_stage(conn):
    v1 = _version(conn, "2020-01-01")
    v2 = _version(conn, "2021-01-01")
    conn.execute("UPDATE ch_act_version SET stage='fetched' WHERE version_id=%s", (v2,))
    rows = db.claim_versions(conn, "discovered", limit=10)
    assert [r["version_id"] for r in rows] == [v1]


def test_claim_versions_honours_the_limit(conn):
    for i, d in enumerate(("2020-01-01", "2020-02-01", "2020-03-01")):
        _version(conn, d)
    assert len(db.claim_versions(conn, "discovered", limit=2)) == 2


def test_claim_versions_skips_rows_that_exhausted_their_attempts(conn):
    vid = _version(conn)
    conn.execute("UPDATE ch_act_version SET attempts=3 WHERE version_id=%s", (vid,))
    assert db.claim_versions(conn, "discovered", limit=10, max_attempts=3) == []


# --- Fix round 1, finding 2: claim_versions() needs the same backoff
# predicate as claim(), now that migration 197 gives ch_act_version a
# stage_updated_at column to key it off. ---

def test_claim_versions_does_not_offer_a_row_that_just_failed(conn):
    """Spec section 8's 1/5/30-minute backoff, carried over from the
    decisions queue. Without a time predicate the same run() re-claims a
    failed row on its very next while-True iteration, so one transient
    hiccup burns the whole attempt budget within seconds."""
    vid = _version(conn)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    assert db.claim_versions(conn, "discovered", limit=10) == []


def test_claim_versions_offers_the_row_again_once_the_backoff_has_elapsed(conn):
    vid = _version(conn)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    conn.execute("UPDATE ch_act_version SET stage_updated_at = "
                "now() - interval '2 minutes' WHERE version_id=%s", (vid,))
    assert [r["version_id"] for r in db.claim_versions(conn, "discovered", limit=10)] == [vid]


def test_claim_versions_never_delays_a_row_that_has_not_failed_yet(conn):
    vid = _version(conn)
    assert [r["version_id"] for r in db.claim_versions(conn, "discovered", limit=10)] == [vid]


def test_claim_versions_claims_a_row_whose_stage_updated_at_is_null(conn):
    """Migration 197 can enrol a row with stage_updated_at still NULL (it
    has never been written back by complete_version()/fail_version()); the
    backoff predicate must not mistake NULL for 'recently failed'."""
    vid = _version(conn)
    conn.execute("UPDATE ch_act_version SET attempts=1, stage_updated_at=NULL "
                "WHERE version_id=%s", (vid,))
    assert [r["version_id"] for r in db.claim_versions(conn, "discovered", limit=10)] == [vid]


def test_complete_version_rejects_reserved_column(conn):
    vid = _version(conn)
    with pytest.raises(ValueError, match="stage"):
        db.complete_version(conn, vid, "fetched", stage="should not work")


def test_complete_version_rejects_unknown_column(conn):
    vid = _version(conn)
    with pytest.raises(ValueError, match="unknown_col"):
        db.complete_version(conn, vid, "fetched", unknown_col="should not work")


def test_complete_version_still_works_with_allowed_columns(conn):
    vid = _version(conn)
    db.complete_version(conn, vid, "fetched", akn_xml="<akomaNtoso/>")
    row = conn.execute(
        "SELECT stage, akn_xml FROM ch_act_version WHERE version_id=%s", (vid,)
    ).fetchone()
    assert row == ("fetched", "<akomaNtoso/>")


def test_complete_version_raises_when_it_updates_nothing(conn):
    """A keyed write that matches no row is a bug, not a silent success --
    the exact Critical finding from the decisions queue: claim() handed out
    rows complete()/fail() could never write back, and the loop re-claimed
    the same rows forever while counting every non-write as a success."""
    with pytest.raises(db.QueueWriteMissed, match="999999999"):
        db.complete_version(conn, 999999999, "fetched", akn_xml="<x/>")


def test_fail_version_raises_when_it_updates_nothing(conn):
    with pytest.raises(db.QueueWriteMissed, match="999999999"):
        db.fail_version(conn, 999999999, "boom", max_attempts=3)


def test_complete_version_resets_the_attempt_budget_for_the_next_stage(conn):
    """attempts is a per-stage retry budget, not a lifetime one. A row that
    survived two transient fetch retries must not arrive at parse with its
    budget already spent."""
    vid = _version(conn)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    assert conn.execute(
        "SELECT attempts FROM ch_act_version WHERE version_id=%s", (vid,)
    ).fetchone()[0] == 2

    db.complete_version(conn, vid, "fetched", akn_xml="<akomaNtoso/>")
    row = conn.execute(
        "SELECT attempts, failed_stage FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row == (0, None)


def test_fail_version_increments_attempts_and_keeps_the_stage(conn):
    vid = _version(conn)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row == ("discovered", 1, "connection reset")


def test_fail_version_records_the_stage_the_row_died_in(conn):
    vid = _version(conn)
    conn.execute("UPDATE ch_act_version SET attempts=2 WHERE version_id=%s", (vid,))
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, failed_stage, attempts FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row == ("failed", "discovered", 3)


def test_fail_version_does_not_record_an_origin_while_attempts_remain(conn):
    vid = _version(conn)
    db.fail_version(conn, vid, "connection reset", max_attempts=3)
    row = conn.execute(
        "SELECT stage, failed_stage FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row == ("discovered", None)


def test_complete_version_stamps_stage_updated_at(conn):
    """The backoff predicate in claim_versions() has nothing to key off
    unless a forward move stamps the clock too, not just a failure."""
    vid = _version(conn)
    db.complete_version(conn, vid, "fetched", akn_xml="<akomaNtoso/>")
    assert conn.execute(
        "SELECT stage_updated_at FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0] is not None


def test_fail_version_stamps_stage_updated_at(conn):
    vid = _version(conn)
    db.fail_version(conn, vid, "boom", max_attempts=3)
    assert conn.execute(
        "SELECT stage_updated_at FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0] is not None


# --- fetch_xml_stage ---

class FakeXmlFetcher:
    def __init__(self, payload: bytes):
        self._payload = payload

    async def bytes(self, url):
        return self._payload


class FetcherFailsOn:
    def __init__(self, bad_url: str):
        self._bad_url = bad_url

    async def bytes(self, url):
        if url == self._bad_url:
            raise FetchError("simulated fetch failure")
        return FIXTURE.read_bytes()


def _seed_xml_url(conn, vid, url):
    conn.execute("UPDATE ch_act_version SET xml_url=%s WHERE version_id=%s", (url, vid))


def test_xml_path_shards_by_thousand(tmp_path):
    settings = _settings(tmp_path)
    p = fetch_xml_stage.xml_path(settings, 4321)
    assert p == tmp_path / "legislation" / "0004" / "4321.xml"


def test_fetch_stores_akn_xml_on_disk_and_in_the_column(conn, tmp_path):
    vid = _version(conn)
    _seed_xml_url(conn, vid, "https://x/or.xml")
    settings = _settings(tmp_path)
    rows = db.claim_versions(conn, "discovered", limit=10)
    report = fetch_xml_stage.FetchXmlReport()
    asyncio.run(fetch_xml_stage._fetch_batch(
        FakeXmlFetcher(FIXTURE.read_bytes()), conn, rows, settings, report))

    row = conn.execute(
        "SELECT stage, akn_xml IS NOT NULL, fetched_at IS NOT NULL "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert row == ("fetched", True, True)
    assert fetch_xml_stage.xml_path(settings, vid).exists()
    assert report.fetched == 1
    assert report.bytes_written == len(FIXTURE.read_bytes())


def test_fetch_records_akn_xml_and_fetched_at_in_a_single_statement(conn, tmp_path):
    """Decision 2: no clear-then-restore dance. complete_version() must be
    called once, with fetched_at set alongside akn_xml, not cleared and
    fixed up by a second UPDATE -- the same pattern that made last_error
    inconsistent across three call sites in the decisions pipeline."""
    vid = _version(conn)
    _seed_xml_url(conn, vid, "https://x/or.xml")

    calls: list[str] = []
    real_execute = conn.execute

    def counting_execute(*args, **kwargs):
        if args:
            calls.append(args[0])
        return real_execute(*args, **kwargs)

    conn.execute = counting_execute
    try:
        settings = _settings(tmp_path)
        rows = db.claim_versions(conn, "discovered", limit=10)
        report = fetch_xml_stage.FetchXmlReport()
        asyncio.run(fetch_xml_stage._fetch_batch(
            FakeXmlFetcher(FIXTURE.read_bytes()), conn, rows, settings, report))
    finally:
        conn.execute = real_execute

    update_calls = [c for c in calls if "UPDATE ch_act_version" in c]
    assert len(update_calls) == 1, (
        "akn_xml and fetched_at must land in one UPDATE, not a write "
        f"followed by a separate restore -- saw {len(update_calls)}: {update_calls}")
    assert report.fetched == 1


def test_a_non_akn_response_is_not_stored_as_if_it_were(conn, tmp_path):
    """The 96%-CSS defect: an HTML error page must not be written to
    akn_xml or the disk audit copy treated as a success."""
    vid = _version(conn)
    _seed_xml_url(conn, vid, "https://x/error.html")
    settings = _settings(tmp_path)
    rows = db.claim_versions(conn, "discovered", limit=10)
    report = fetch_xml_stage.FetchXmlReport()
    html_error = b"<html><body>404 Not Found</body></html>"
    asyncio.run(fetch_xml_stage._fetch_batch(
        FakeXmlFetcher(html_error), conn, rows, settings, report))

    row = conn.execute(
        "SELECT stage, akn_xml, attempts, last_error "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert row[0] == "discovered"
    assert row[1] is None
    assert row[2] == 1
    assert "Akoma Ntoso" in row[3]
    assert report.failed == 1
    assert report.fetched == 0


def test_a_bad_edition_does_not_abort_the_rest_of_the_batch(conn, tmp_path, monkeypatch):
    """Decision 3's per-item guard: one edition that fails partway through
    (a disk error after a good fetch) must not cancel its siblings in the
    same asyncio.gather batch."""
    v_good = _version(conn, "2020-01-01")
    v_bad = _version(conn, "2021-01-01")
    _seed_xml_url(conn, v_good, "https://x/good.xml")
    _seed_xml_url(conn, v_bad, "https://x/bad.xml")

    real_xml_path = fetch_xml_stage.xml_path

    def flaky_xml_path(settings, version_id):
        if version_id == v_bad:
            raise OSError("simulated disk failure")
        return real_xml_path(settings, version_id)

    monkeypatch.setattr(fetch_xml_stage, "xml_path", flaky_xml_path)

    settings = _settings(tmp_path)
    rows = db.claim_versions(conn, "discovered", limit=10)
    report = fetch_xml_stage.FetchXmlReport()
    asyncio.run(fetch_xml_stage._fetch_batch(
        FakeXmlFetcher(FIXTURE.read_bytes()), conn, rows, settings, report))

    good_row = conn.execute(
        "SELECT stage FROM ch_act_version WHERE version_id=%s", (v_good,)).fetchone()
    bad_row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_act_version WHERE version_id=%s",
        (v_bad,)).fetchone()
    assert good_row[0] == "fetched"
    assert bad_row[0] == "discovered"
    assert bad_row[1] == 1
    assert "simulated disk failure" in bad_row[2]
    assert report.fetched == 1
    assert report.failed == 1


def test_a_fetch_error_for_one_row_does_not_abort_the_rest_of_the_batch(conn, tmp_path):
    v_good = _version(conn, "2020-01-01")
    v_bad = _version(conn, "2021-01-01")
    _seed_xml_url(conn, v_good, "https://x/good.xml")
    _seed_xml_url(conn, v_bad, "https://x/bad.xml")

    settings = _settings(tmp_path)
    rows = db.claim_versions(conn, "discovered", limit=10)
    report = fetch_xml_stage.FetchXmlReport()
    asyncio.run(fetch_xml_stage._fetch_batch(
        FetcherFailsOn("https://x/bad.xml"), conn, rows, settings, report))

    good_row = conn.execute(
        "SELECT stage FROM ch_act_version WHERE version_id=%s", (v_good,)).fetchone()
    bad_row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_act_version WHERE version_id=%s",
        (v_bad,)).fetchone()
    assert good_row[0] == "fetched"
    assert bad_row[0] == "discovered"
    assert bad_row[1] == 1
    assert "simulated fetch failure" in bad_row[2]
    assert report.fetched == 1
    assert report.failed == 1


# --- parse_akn_stage.run() ---

def _seed_fetched(conn, vid, akn_xml):
    conn.execute("UPDATE ch_act_version SET stage='fetched', akn_xml=%s "
                "WHERE version_id=%s", (akn_xml, vid))


def test_run_parses_a_claimed_batch_end_to_end(conn):
    vid = _version(conn)
    _seed_fetched(conn, vid, FIXTURE.read_text(encoding="utf-8"))
    settings = _settings(pathlib.Path("/tmp/chpipe-parse-akn-test"))
    report = parse_akn_stage.run(settings, limit=10)

    row = conn.execute(
        "SELECT stage, article_count, full_text IS NOT NULL "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert row[0] == "parsed"
    assert row[1] == report.articles
    assert row[2] is True
    assert report.parsed == 1
    assert report.empty == 0
    assert report.failed == 0


def test_a_bad_edition_does_not_abort_a_parse_batch_of_others(conn):
    """Decision 3's per-item guard, on the parse side: one edition with
    unparseable akn_xml must not stop the other 12,032 in the same claim
    from being parsed.

    Fix round 1 gave ch_act_version a stage_updated_at column and the same
    backoff predicate as the decisions queue, so the freshly-failed row is
    NOT reclaimed on run()'s next while-True iteration within this same
    call -- it survives as a single spent attempt, exactly like a decisions-
    pipeline row does, rather than burning its whole budget in one run."""
    good = _version(conn, "2020-01-01")
    bad = _version(conn, "2021-01-01")
    _seed_fetched(conn, good, FIXTURE.read_text(encoding="utf-8"))
    _seed_fetched(conn, bad, "<not even well-formed xml")

    settings = _settings(pathlib.Path("/tmp/chpipe-parse-akn-test"))
    report = parse_akn_stage.run(settings, limit=10)

    good_row = conn.execute(
        "SELECT stage, article_count FROM ch_act_version WHERE version_id=%s",
        (good,)).fetchone()
    bad_row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_act_version WHERE version_id=%s",
        (bad,)).fetchone()
    assert good_row[0] == "parsed"
    assert good_row[1] > 0
    assert bad_row[0] == "fetched"
    assert bad_row[1] == 1
    assert bad_row[2]
    assert report.parsed == 1
    assert report.failed == 1


def test_a_version_with_no_akn_xml_is_recorded_as_failed_not_silently_skipped(conn):
    """The backoff predicate keeps this to a single spent attempt within
    one run() call, same as the guard test above."""
    vid = _version(conn)
    conn.execute("UPDATE ch_act_version SET stage='fetched' WHERE version_id=%s", (vid,))
    settings = _settings(pathlib.Path("/tmp/chpipe-parse-akn-test"))
    report = parse_akn_stage.run(settings, limit=10)

    row = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row[0] == "fetched"
    assert row[1] == 1
    assert "no akn_xml" in row[2]
    assert report.failed == 1
    assert report.parsed == 0
