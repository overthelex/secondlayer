"""cantonal_fetch_stage against a mocked Lexwork host, real Postgres."""
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import db
from chpipe.config import Settings
from chpipe.stages import cantonal_fetch_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "lexwork_be_101_1_v3020.json"
PAYLOAD = FIXTURE.read_bytes()
URL = "https://www.belex.sites.be.ch/api/de/texts_of_law/101.1/versions/3020/show_as_json"


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                  "VALUES (1, 'https://www.belex.sites.be.ch/app/de/texts_of_law/101.1', 'BE', '101.1')")
        yield c


def _row(conn, lang="de", url=URL, source="lexwork", consolidation=None):
    consolidation = consolidation or url.replace("/api/de/", "/app/de/").replace("/show_as_json", "")
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source) VALUES (1, %s, %s, '2024-03-03', %s, %s) RETURNING version_id",
        (consolidation, lang, url, source)).fetchone()[0]


class Host:
    def __init__(self, body=PAYLOAD, status=200):
        self.calls = 0
        self.body = body
        self.status = status

    def __call__(self, request):
        self.calls += 1
        return httpx.Response(self.status, content=self.body)


def _run(settings, host, **kw):
    return cantonal_fetch_stage.run(settings, transport=httpx.MockTransport(host), **kw)


def test_fetches_validates_and_stores_the_payload(conn, settings):
    vid = _row(conn)
    host = Host()
    report = _run(settings, host)
    assert report.fetched == 1 and report.failed == 0
    stage, stored, fetched_at = conn.execute(
        "SELECT stage, akn_xml, fetched_at FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "fetched" and fetched_at is not None
    assert json.loads(stored)["text_of_law"]["systematic_number"] == "101.1"
    assert cantonal_fetch_stage.payload_path(settings, vid).exists()


def test_sibling_languages_share_one_download(conn, settings):
    _row(conn, "de")
    _row(conn, "fr")
    host = Host()
    report = _run(settings, host)
    assert host.calls == 1
    assert report.fetched == 2 and report.cache_hits == 1
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='fetched' "
                        "AND akn_xml IS NOT NULL").fetchone()[0] == 2


def test_a_non_json_body_fails_the_row_with_a_reason(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(body=b"<html>login</html>"))
    assert report.failed == 1 and report.fetched == 0
    stage, error = conn.execute(
        "SELECT stage, last_error FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "discovered" and "not a Lexwork show_as_json payload" in error


def test_a_pdf_only_version_is_retired_at_once_with_its_reason(conn, settings):
    vid = _row(conn)
    body = json.dumps({"text_of_law": {"selected_version": {
        "id": 780, "structured_document_id": None,
        "pdf_link_tol": "https://www.belex.sites.be.ch/api/de/versions/780/pdf_file",
        "json_content": {"document": {"header": {}, "content": None}}}}}).encode()
    report = _run(settings, Host(body=body))
    assert report.pdf_only == 1 and report.failed == 0 and report.fetched == 0
    stage, error, failed_stage = conn.execute(
        "SELECT stage, last_error, failed_stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "failed" and failed_stage == "discovered" and error.startswith("pdf_only")


def test_json_without_a_document_tree_fails_the_row(conn, settings):
    _row(conn)
    report = _run(settings, Host(body=b'{"text_of_law": {"selected_version": {}}}'))
    assert report.failed == 1


def test_a_404_fails_the_row(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(status=404, body=b"gone"))
    assert report.failed == 1
    assert "404" in conn.execute("SELECT last_error FROM ch_act_version WHERE version_id=%s",
                                 (vid,)).fetchone()[0]


def test_only_lexwork_rows_are_claimed(conn, settings):
    _row(conn, url="https://fedlex.data.admin.ch/filestore/x.xml", source="fedlex",
         consolidation="fedlex/x")
    host = Host()
    report = _run(settings, host)
    assert host.calls == 0 and report.fetched == 0
    assert conn.execute("SELECT stage FROM ch_act_version").fetchone()[0] == "discovered"


def test_one_canton_at_a_time_selects_by_host(conn, settings):
    _row(conn)
    _row(conn, url="https://bgs.zg.ch/api/de/texts_of_law/111.1/versions/5/show_as_json",
         consolidation="zg/111.1/5")
    host = Host()
    report = _run(settings, host, canton_code="ZG")
    assert report.fetched == 1
    assert conn.execute("SELECT xml_url FROM ch_act_version WHERE stage='fetched'").fetchone()[0] \
        .startswith("https://bgs.zg.ch/")
    with pytest.raises(ValueError):
        cantonal_fetch_stage.url_prefix("BE,ZG")


def test_an_unknown_host_fails_the_row_without_a_request(conn, settings):
    _row(conn, url="https://example.org/api/de/texts_of_law/1/versions/1/show_as_json",
         consolidation="x/1")
    host = Host()
    report = _run(settings, host)
    assert host.calls == 0 and report.failed == 1


def test_limit_bounds_the_run(conn, settings):
    for i in range(3):
        _row(conn, consolidation=f"be/101.1/{i}", url=URL.replace("3020", str(i)))
    report = _run(settings, Host(), limit=2)
    assert report.fetched == 2
    assert db.claim_versions(conn, "discovered", 10, backoff_minutes=(), source="lexwork")
