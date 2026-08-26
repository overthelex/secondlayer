"""sil_fetch_stage against mocked SIL hosts, real Postgres."""
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import sil_fetch_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GE_PAGE = (FIXTURES / "sil_ge_rsg_i2_09.htm").read_bytes()
NE_PAGE = (FIXTURES / "sil_ne_916_510_1.htm").read_bytes()
GE_URL = "https://silgeneve.ch/legis/program/books/rsg/htm/rsg_i2_09.htm"
NE_URL = "https://rsn.ne.ch/DATA/program/books/rsne/htm/916.510.1.htm"


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) VALUES "
                  "(1, %s, 'GE', 'I 2 09'), (2, %s, 'NE', '916.510.1')", (GE_URL, NE_URL))
        yield c


def _row(conn, act_id=1, url=GE_URL, source="sil", uri=None):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source) VALUES (%s, %s, 'fr', '2026-02-27', %s, %s) RETURNING version_id",
        (act_id, uri or f"sil:{act_id}/{url}", url, source)).fetchone()[0]


class Host:
    def __init__(self, status=200, body=None):
        self.calls = 0
        self.status, self.body = status, body

    def __call__(self, request):
        self.calls += 1
        body = self.body if self.body is not None else (
            GE_PAGE if request.url.host == "silgeneve.ch" else NE_PAGE)
        return httpx.Response(self.status, content=body)


def _run(settings, host, **kw):
    return sil_fetch_stage.run(settings, transport=httpx.MockTransport(host), pace=0.0, **kw)


def test_fetches_decodes_and_stores_both_hosts(conn, settings):
    ge = _row(conn)
    ne = _row(conn, act_id=2, url=NE_URL)
    report = _run(settings, Host())
    assert report.fetched == 2 and report.failed == 0 and report.gone == 0
    for vid, needle in ((ge, "Loi sur le commerce d’objets usagés"), (ne, "déchets animaux")):
        stage, stored, fetched_at = conn.execute(
            "SELECT stage, akn_xml, fetched_at FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
        assert stage == "fetched" and fetched_at is not None
        assert needle in stored, "stored decoded from windows-1252, not as mojibake"
        assert sil_fetch_stage.payload_path(settings, vid).read_bytes() in (GE_PAGE, NE_PAGE)


def test_a_404_retires_the_row_at_once_with_the_url(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(status=404, body=b"not found"))
    assert report.gone == 1 and report.failed == 0
    stage, error, failed_stage = conn.execute(
        "SELECT stage, last_error, failed_stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "failed" and failed_stage == "discovered"
    assert error.startswith("404: act page gone (") and GE_URL in error


def test_a_page_without_a_body_fails_the_row_and_retries(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(body=b"<html><head></head></html>"))
    assert report.failed == 1
    stage, error, attempts = conn.execute(
        "SELECT stage, last_error, attempts FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "discovered" and attempts == 1 and "not a SIL act page" in error


def test_only_sil_rows_and_one_canton_at_a_time(conn, settings):
    _row(conn, source="lexwork", uri="lw/1")
    _row(conn, act_id=2, url=NE_URL)
    host = Host()
    report = _run(settings, host, canton_code="GE")
    assert host.calls == 0 and report.fetched == 0
    report = _run(settings, host, canton_code="NE")
    assert host.calls == 1 and report.fetched == 1
    assert conn.execute("SELECT stage FROM ch_act_version WHERE source='lexwork'").fetchone()[0] == "discovered"
    with pytest.raises(ValueError):
        sil_fetch_stage.url_prefix("GE,NE")
    assert sil_fetch_stage.url_prefix(None) is None


def test_limit_bounds_the_run(conn, settings):
    for i in range(3):
        _row(conn, uri=f"sil:GE/x/{i}")
    report = _run(settings, Host(), limit=2)
    assert report.fetched == 2
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='discovered'").fetchone()[0] == 1
