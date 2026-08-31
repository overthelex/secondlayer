"""lexwork_pdf_requeue_stage against a mocked Lexwork host, real Postgres."""
import json
import os

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import lexwork_pdf_requeue_stage as stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

HOST = "https://www.belex.sites.be.ch"


def show_url(sysnr, vid):
    return f"{HOST}/api/de/texts_of_law/{sysnr}/versions/{vid}/show_as_json"


def tol(versions):
    """A tol record in the shape the hosts return (2026-08-27: the version
    entries carry id and structured_document_id, no pdf link)."""
    current, *old = versions
    return json.dumps({"text_of_law": {
        "systematic_number": "436.811",
        "current_version": {"id": current[0], "structured_document_id": current[1]},
        "old_versions": [{"id": i, "structured_document_id": s} for i, s in old],
        "future_versions": []}}).encode()


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir="/nonexistent",
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, retry_backoff_minutes=())


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) VALUES "
                  "(1, 'https://www.belex.sites.be.ch/app/de/texts_of_law/436.811', 'BE', '436.811')")
        yield c


def _pdf_only(conn, sysnr="436.811", vid=780, lang="de", end="2015-12-31", error="pdf_only: version has no structured document, PDF only"):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "date_end_applicability, xml_url, source, stage, attempts, last_error, failed_stage) "
        "VALUES (1, %s, %s, '2004-07-01', %s, %s, 'lexwork', 'failed', 1, %s, 'discovered') RETURNING version_id",
        (f"{HOST}/app/de/texts_of_law/{sysnr}/versions/{vid}#{lang}", lang, end, show_url(sysnr, vid), error)).fetchone()[0]


class Host:
    def __init__(self, tols: dict[str, bytes]):
        self.calls = []
        self.tols = tols

    def __call__(self, request):
        self.calls.append(str(request.url))
        sysnr = str(request.url).rsplit("/", 1)[-1]
        if sysnr not in self.tols:
            return httpx.Response(404, content=b"not found")
        return httpx.Response(200, content=self.tols[sysnr])


def _state(conn, vid):
    return conn.execute("SELECT source, stage, attempts, last_error, xml_url FROM ch_act_version "
                        "WHERE version_id=%s", (vid,)).fetchone()


def _run(settings, host, **kw):
    return stage.run(settings, transport=httpx.MockTransport(host), **kw)


def test_pdf_only_versions_are_requeued_with_the_pdf_url_in_their_language(conn, settings):
    de = _pdf_only(conn, lang="de")
    fr = _pdf_only(conn, lang="fr")
    host = Host({"436.811": tol([(3274, 31418), (780, None)])})
    report = _run(settings, host)
    assert report.requeued_pdf == 2 and report.acts_fetched == 1
    assert len(host.calls) == 1                                  # one tol fetch per act
    assert _state(conn, de) == ("lexwork_pdf", "discovered", 0, None,
                                f"{HOST}/api/de/versions/780/pdf_file")
    assert _state(conn, fr) == ("lexwork_pdf", "discovered", 0, None,
                                f"{HOST}/api/fr/versions/780/pdf_file")


def test_a_version_the_host_has_since_structured_goes_back_to_the_html_path(conn, settings):
    vid = _pdf_only(conn)
    report = _run(settings, Host({"436.811": tol([(3274, 31418), (780, 99)])}))
    assert report.requeued_html == 1 and report.requeued_pdf == 0
    assert _state(conn, vid) == ("lexwork", "discovered", 0, None, show_url("436.811", 780))


def test_unlisted_versions_and_unknown_acts_stay_failed_with_a_new_reason(conn, settings):
    gone = _pdf_only(conn, vid=781)
    no_act = _pdf_only(conn, sysnr="999.9", vid=5)
    report = _run(settings, Host({"436.811": tol([(3274, 31418), (780, None)])}))
    assert report.not_listed == 1 and report.act_not_on_host == 1 and report.requeued_pdf == 0
    assert _state(conn, gone)[1:4] == ("failed", 1, "pdf_only: version not listed by host")
    assert _state(conn, no_act)[1:4] == ("failed", 1, "pdf_only: act not on host")


def test_current_only_leaves_closed_editions_alone(conn, settings):
    closed = _pdf_only(conn, vid=780, end="2015-12-31")
    current = _pdf_only(conn, vid=3274, end=None)
    host = Host({"436.811": tol([(3274, None), (780, None)])})
    report = _run(settings, host, current_only=True)
    assert report.requeued_pdf == 1
    assert _state(conn, current)[:2] == ("lexwork_pdf", "discovered")
    assert _state(conn, closed)[:2] == ("lexwork", "failed")


def test_only_pdf_only_failures_of_the_selected_canton_are_touched(conn, settings):
    other_reason = _pdf_only(conn, vid=782, error="404 for https://x")
    zg = conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source, stage, last_error) VALUES (1, 'zg/1', 'de', '2020-01-01', "
        "'https://bgs.zg.ch/api/de/texts_of_law/1.1/versions/9/show_as_json', 'lexwork', 'failed', "
        "'pdf_only: x') RETURNING version_id").fetchone()[0]
    be = _pdf_only(conn)
    host = Host({"436.811": tol([(780, None)])})
    report = _run(settings, host, canton_code="BE")
    assert report.requeued_pdf == 1
    assert _state(conn, be)[0] == "lexwork_pdf"
    assert _state(conn, zg)[:2] == ("lexwork", "failed")
    assert _state(conn, other_reason)[:2] == ("lexwork", "failed")
    assert all("belex" in c for c in host.calls)


def test_a_tol_fetch_error_changes_nothing(conn, settings):
    vid = _pdf_only(conn)

    def boom(request):
        return httpx.Response(503, content=b"busy")

    report = stage.run(settings, transport=httpx.MockTransport(boom))
    assert report.tol_failed == 1
    assert _state(conn, vid)[:2] == ("lexwork", "failed")


def test_versions_of_reads_all_three_lists():
    listed = stage.versions_of({"current_version": {"id": 3, "structured_document_id": 9},
                                "old_versions": [{"id": 2, "structured_document_id": None}],
                                "future_versions": [{"id": 4, "structured_document_id": None}]})
    assert listed == {3: 9, 2: None, 4: None}
    assert stage.pdf_url("bgs.so.ch", "de", 839) == "https://bgs.so.ch/api/de/versions/839/pdf_file"


GL_HOST = "https://gesetze.gl.ch"


def test_a_gl_sysnr_with_spaces_and_slashes_is_recognised(conn, settings):
    """All 114 leftovers of the first prod run (2026-08-31) are GL rows whose
    systematic number contains spaces and slashes ('I A/1/1'): the sysnr
    group of _VERSION_URL must span path segments."""
    vid = _pdf_only(conn, sysnr="I A/1/1", vid=516)
    conn.execute("UPDATE ch_act_version SET xml_url=%s WHERE version_id=%s",
                 (f"{GL_HOST}/api/de/texts_of_law/I A/1/1/versions/516/show_as_json", vid))
    calls = []

    def host(request):
        calls.append(str(request.url))
        # httpx encodes the space; the tol endpoint for the multi-segment sysnr
        assert str(request.url) == f"{GL_HOST}/api/de/texts_of_law/I%20A/1/1"
        return httpx.Response(200, content=json.dumps({"text_of_law": {
            "current_version": {"id": 2603, "structured_document_id": 10432},
            "old_versions": [{"id": 516, "structured_document_id": None}],
            "future_versions": []}}).encode())

    report = stage.run(settings, transport=httpx.MockTransport(host))
    assert report.requeued_pdf == 1 and report.unknown_url == 0
    assert len(calls) == 1
    assert _state(conn, vid) == ("lexwork_pdf", "discovered", 0, None,
                                 f"{GL_HOST}/api/de/versions/516/pdf_file")


def test_urls_that_still_cannot_be_resolved_get_a_precise_reason(conn, settings):
    foreign_host = _pdf_only(conn, vid=901)
    conn.execute("UPDATE ch_act_version SET xml_url=%s WHERE version_id=%s",
                 ("https://example.ch/api/de/texts_of_law/1.1/versions/9/show_as_json",
                  foreign_host))
    no_shape = _pdf_only(conn, vid=902)
    conn.execute("UPDATE ch_act_version SET xml_url=%s WHERE version_id=%s",
                 ("https://www.belex.sites.be.ch/app/de/texts_of_law/1.1", no_shape))
    report = stage.run(settings, transport=httpx.MockTransport(
        lambda request: httpx.Response(404, content=b"")))
    assert report.unknown_url == 2
    assert _state(conn, foreign_host)[3] == "pdf_only: host example.ch is not a Lexwork host"
    assert _state(conn, no_shape)[3] == "pdf_only: xml_url is not a Lexwork version URL"
