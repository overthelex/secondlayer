"""sil_acts_stage against the real GE and NE TOC excerpts, mocked hosts,
real Postgres (migration 201 + 203 shape)."""
import datetime
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import sil_acts_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GE_TOC = (FIXTURES / "sil_ge_content_excerpt.htm").read_bytes()
NE_TOC = (FIXTURES / "sil_ne_content_excerpt.htm").read_bytes()


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=2, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


def _registry(conn, tol_id, canton, sysnr, active, versions):
    conn.execute(
        "INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, is_active, "
        "versions_json, version_count) VALUES (%s, %s, %s, %s, %s, %s)",
        (tol_id, canton, sysnr, active, json.dumps(versions), len(versions)))


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        # GE A 1 01: two versions, the active one dated 01.06.2013 (LexFind's
        # shape); GE A 1 02: registry row without an active version; NE 101:
        # active 01.01.2024, plus an INACTIVE duplicate of the same number
        _registry(c, 1, "GE", "A 1 01", True, [
            {"id": 11, "is_active": False, "version_active_since": "19.05.1815"},
            {"id": 12, "is_active": True, "version_active_since": "01.06.2013"}])
        _registry(c, 2, "GE", "A 1 02", True, [{"id": 21, "is_active": False,
                                                "version_active_since": "01.01.1900"}])
        _registry(c, 3, "NE", "101", False, [{"id": 31, "is_active": False,
                                              "version_active_since": "01.01.2000"}])
        _registry(c, 4, "NE", "101", True, [{"id": 41, "is_active": True,
                                             "version_active_since": "01.01.2024"}])
        yield c


class Hosts:
    def __init__(self, ge=GE_TOC, ne=NE_TOC, status=200):
        self.calls = []
        self.ge, self.ne, self.status = ge, ne, status

    def __call__(self, request):
        self.calls.append(str(request.url))
        if request.url.host == "silgeneve.ch":
            return httpx.Response(self.status, content=self.ge)
        if request.url.host == "rsn.ne.ch":
            return httpx.Response(self.status, content=self.ne)
        return httpx.Response(500)


def _run(settings, hosts, **kw):
    return sil_acts_stage.run(settings, transport=httpx.MockTransport(hosts), **kw)


def test_one_act_and_one_open_version_per_toc_entry(conn, settings):
    hosts = Hosts()
    report = _run(settings, hosts)
    assert hosts.calls == ["https://silgeneve.ch/legis/program/books/rsg/content.htm",
                           "https://rsn.ne.ch/DATA/program/books/rsne/content.htm"]
    assert report.cantons == ["GE", "NE"]
    assert report.toc_entries == 30 + 38 == report.acts == report.versions_new
    assert report.by_canton == {"GE": 30, "NE": 38} and report.errors == 0
    assert conn.execute("SELECT count(*) FROM ch_act WHERE jurisdiction='GE' AND in_force").fetchone()[0] == 30
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE source='sil' AND lang='fr' "
                        "AND stage='discovered' AND date_end_applicability IS NULL").fetchone()[0] == 68
    work, sr, title, meta = conn.execute(
        "SELECT eli_work_uri, sr_number, title_fr, metadata_json FROM ch_act "
        "WHERE jurisdiction='GE' AND sr_number='A 1 01'").fetchone()
    assert work == "https://silgeneve.ch/legis/program/books/rsg/htm/rsg_a1_01.htm"
    assert title.startswith("Acte d'union de la République de Genève")
    assert meta["platform"] == "sil" and meta["host"] == "silgeneve.ch" and meta["lexfind_tol_id"] == 1
    uri, date, xml_url = conn.execute(
        "SELECT v.eli_consolidation_uri, v.date_applicability, v.xml_url FROM ch_act_version v "
        "JOIN ch_act a USING (act_id) WHERE a.sr_number='A 1 01'").fetchone()
    assert date == datetime.date(2013, 6, 1) and uri == "sil:GE/A 1 01/2013-06-01" and xml_url == work


def test_the_date_comes_from_lexfind_when_it_can_and_says_so(conn, settings):
    report = _run(settings, Hosts())
    assert report.date_from_lexfind == 2, "GE A 1 01 and NE 101"
    assert report.date_from_run == 66
    assert report.not_in_registry == 65 and len(report.not_in_registry_samples) == 12
    sources = dict(conn.execute(
        "SELECT sr_number, metadata_json ->> 'sil_date_source' FROM ch_act "
        "WHERE sr_number IN ('A 1 01', 'A 1 02', '101')").fetchall())
    assert sources == {"A 1 01": "lexfind", "A 1 02": "run", "101": "lexfind"}
    ne = conn.execute("SELECT v.date_applicability, a.metadata_json ->> 'lexfind_tol_id' "
                      "FROM ch_act_version v JOIN ch_act a USING (act_id) "
                      "WHERE a.jurisdiction='NE' AND a.sr_number='101'").fetchone()
    assert ne == (datetime.date(2024, 1, 1), "4"), "the active registry row wins over the inactive twin"
    run_dated = conn.execute("SELECT date_applicability FROM ch_act_version v JOIN ch_act a "
                             "USING (act_id) WHERE a.sr_number='A 1 02'").fetchone()[0]
    assert run_dated == datetime.date.today()


def test_a_rerun_keeps_the_open_version_and_adds_nothing(conn, settings):
    _run(settings, Hosts())
    conn.execute("UPDATE ch_act_version SET stage='parsed'")
    report = _run(settings, Hosts())
    assert report.versions_new == 0 and report.versions_kept == 68 and report.acts == 68
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 68
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='parsed'").fetchone()[0] == 68


def test_one_canton_at_a_time(conn, settings):
    hosts = Hosts()
    report = _run(settings, hosts, canton_code="ne")
    assert report.cantons == ["NE"] and len(hosts.calls) == 1
    assert conn.execute("SELECT count(*) FROM ch_act WHERE jurisdiction='GE'").fetchone()[0] == 0
    with pytest.raises(ValueError):
        _run(settings, hosts, canton_code="BE")


def test_a_host_that_does_not_answer_is_reported_not_fatal(conn, settings):
    class Half(Hosts):
        def __call__(self, request):
            if request.url.host == "silgeneve.ch":
                return httpx.Response(503)
            return super().__call__(request)
    report = _run(settings, Half())
    assert report.hosts_failed == ["GE"] and report.by_canton == {"NE": 38}


def test_a_toc_that_parses_to_nothing_touches_no_table(conn, settings):
    report = _run(settings, Hosts(ge=b"<html><body>maintenance</body></html>"), canton_code="GE")
    assert report.hosts_failed == ["GE"] and report.acts == 0
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 0
