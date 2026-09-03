"""portals_discover_stage against mocked portals, real Postgres: the rows it
writes into ch_court_decisions are the ones fetch_stage claims and downloads
-- proven here by running fetch_stage itself over the discovered rows with
the same mock serving the PDFs."""
import asyncio
import json
import os
import pathlib

import httpx
import psycopg
import pytest

from chpipe import db
from chpipe.config import Settings
from chpipe.http import Fetcher
from chpipe.stages import fetch_stage, portals_discover_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
FIX = pathlib.Path(__file__).parent / "fixtures" / "portals"
PDF_BYTES = (pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf").read_bytes()


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION_196.read_text())
        yield c


class Site:
    def __init__(self):
        self.routes = {
            "eschk.admin.ch/de/beschluesse-2024": (FIX / "eschk_2024.html").read_text(),
            "elcom.admin.ch/de/verfuegungen": (FIX / "elcom.html").read_text(),
            "api/search/getresult": json.loads((FIX / "finma_enf_api.json").read_text()),
        }
        self.calls: list[str] = []

    def __call__(self, request):
        url = str(request.url)
        self.calls.append(url)
        for key, body in self.routes.items():
            if key in url:
                return httpx.Response(200, json=body) if isinstance(body, dict) else httpx.Response(200, text=body)
        if url.lower().endswith(".pdf"):
            return httpx.Response(200, content=PDF_BYTES, headers={"content-type": "application/pdf"})
        if "kasuistik/" in url:
            return httpx.Response(200, text="<html><body><table><tr><th>Zusammenfassung</th><td>Text</td></tr></table></body></html>",
                                  headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404, text=url)


def _discover(settings, site, spider):
    return portals_discover_stage.run(settings, spider=spider, transport=httpx.MockTransport(site), delay=0.0)


def _rows(conn, spider):
    return {r[0]: r for r in conn.execute(
        "SELECT doc_id, ecli, canton, court_code, court_name, decision_type, decision_date::text, docket_number, "
        "       abstract, languages, html_url, pdf_url, text_source, stage, attempts, metadata_json "
        "  FROM ch_court_decisions WHERE spider = %s ORDER BY doc_id", (spider,)).fetchall()}


def test_discovery_writes_rows_at_stage_indexed_in_the_queue_shape(settings, conn):
    site = Site()
    report = _discover(settings, site, "CH_ESCHK")
    assert report.spiders == ["CH_ESCHK"]
    assert (report.discovered, report.upserted, report.inserted, report.requeued, report.errors) == (2, 2, 2, 0, 0)
    rows = _rows(conn, "CH_ESCHK")
    assert set(rows) == {"2024_gtk-dfi-2024", "2024_gt-4i-2024-dfi"}
    r = rows["2024_gtk-dfi-2024"]
    assert r[1] == "ECLI:CH:CH_ESCHK:2024_gtk-dfi-2024"
    assert (r[2], r[3], r[5]) == ("CH", "CH_ESCHK", "Beschluss")
    assert r[4].startswith("Eidgenössische Schiedskommission")
    assert r[6] == "2024-01-23" and r[7] == "gtk-dfi-2024"
    assert r[8] == "GT K (Beschluss vom 23. Januar 2024)"          # the title is the abstract the search ranks on
    assert r[9] == ["de"] and r[10] is None and r[11].endswith("gtk-dfi-2024.pdf")
    assert (r[12], r[13], r[14]) == ("pdf", "indexed", 0)
    assert r[15]["Sprache"] == "de" and r[15]["portal"]["year"] == 2024


def test_a_second_walk_is_idempotent_and_a_new_url_requeues(settings, conn):
    site = Site()
    _discover(settings, site, "CH_ESCHK")
    conn.execute("UPDATE ch_court_decisions SET stage = 'failed', failed_stage = 'fetched', last_error = 'boom', "
                 "full_text = 'x', attempts = 3 WHERE doc_id = '2024_gtk-dfi-2024'")
    report = _discover(settings, site, "CH_ESCHK")
    assert (report.inserted, report.requeued, report.stale) == (0, 0, 0)
    assert _rows(conn, "CH_ESCHK")["2024_gtk-dfi-2024"][13] == "failed"
    site.routes["eschk.admin.ch/de/beschluesse-2024"] = site.routes["eschk.admin.ch/de/beschluesse-2024"].replace(
        "WczDveCpZFab/gtk-dfi-2024.pdf", "NEWHASH/gtk-dfi-2024.pdf")
    report = _discover(settings, site, "CH_ESCHK")
    assert report.requeued == 1
    r = _rows(conn, "CH_ESCHK")["2024_gtk-dfi-2024"]
    assert r[13] == "indexed" and r[14] == 0 and "NEWHASH" in r[11]
    # the old failure's diagnosis went with it
    assert conn.execute("SELECT last_error, failed_stage FROM ch_court_decisions WHERE doc_id = '2024_gtk-dfi-2024'").fetchone() == (None, None)


def test_an_html_portal_row_carries_html_url_not_pdf_url(settings, conn):
    site = Site()
    report = _discover(settings, site, "CH_FINMA")
    assert report.upserted == 4
    r = _rows(conn, "CH_FINMA")["FINMA_2025-35"]
    assert r[10] == "https://www.finma.ch/de/dokumentation/enforcementberichterstattung/kasuistik/2025-35/"
    assert r[11] is None and r[12] == "html" and r[7] == "2025-35"


def test_fetch_stage_picks_the_rows_up_unchanged(settings, conn):
    """The whole point: nothing downstream knows about portals."""
    site = Site()
    _discover(settings, site, "CH_ESCHK")
    _discover(settings, site, "CH_FINMA")

    async def fetch(spider):
        rows = db.claim(conn, "indexed", limit=50, spider=spider)
        report = fetch_stage.FetchReport()
        async with Fetcher(concurrency=1, transport=httpx.MockTransport(site)) as fetcher:
            await fetch_stage._fetch_batch(fetcher, conn, rows, settings, report)
        return len(rows), report

    claimed, report = asyncio.run(fetch("CH_ESCHK"))
    assert claimed == 2 and report.fetched_pdf == 2 and report.failed == 0
    assert all(r[13] == "fetched" and r[12] == "pdf" for r in _rows(conn, "CH_ESCHK").values())
    assert (settings.raw_dir / "CH_ESCHK" / "2024_gtk-dfi-2024.pdf").read_bytes() == PDF_BYTES
    claimed, report = asyncio.run(fetch("CH_FINMA"))
    assert claimed == 4 and report.fetched_html == 4
    assert all(r[12] == "html" and r[13] == "fetched" for r in _rows(conn, "CH_FINMA").values())


def test_all_portals_and_an_unknown_spider(settings, conn):
    site = Site()
    with pytest.raises(ValueError):
        _discover(settings, site, "CH_NOPE")
    # every portal against a site that 404s everything but ESchK/ElCom/FINMA: no crash; a portal whose
    # listing came back empty is an error (the outage cron must see), EMARK's incremental walk is not
    report = _discover(settings, site, None)
    assert set(report.spiders) == set(portals_discover_stage.PORTALS)
    assert report.errors == len(portals_discover_stage.PORTALS) - 3 - 1 and report.doc_errors == 0
    assert "CH_EMARK" not in report.by_spider or report.by_spider["CH_EMARK"] == 0
    assert report.by_spider["CH_ESCHK"] == 2 and report.by_spider["CH_ELCOM"] > 0 and report.by_spider["CH_FINMA"] == 4
    assert db.unkeyed_count(conn, "indexed") == 0


def test_a_refused_row_is_a_doc_error_but_a_dead_connection_propagates(settings, conn, monkeypatch):
    site = Site()
    real = portals_discover_stage.upsert
    calls = {"n": 0}

    def refuse_first(c, portal, doc):
        calls["n"] += 1
        if calls["n"] == 1:
            raise psycopg.DataError("value too long")
        return real(c, portal, doc)
    monkeypatch.setattr(portals_discover_stage, "upsert", refuse_first)
    report = _discover(settings, site, "CH_ESCHK")
    assert (report.discovered, report.upserted, report.doc_errors, report.errors) == (2, 1, 1, 0)

    def refuse_all(c, portal, doc):
        raise psycopg.IntegrityError("duplicate")
    monkeypatch.setattr(portals_discover_stage, "upsert", refuse_all)
    report = _discover(settings, site, "CH_ESCHK")
    assert (report.upserted, report.doc_errors, report.errors) == (0, 2, 1)

    def dead(c, portal, doc):
        raise psycopg.OperationalError("server closed the connection")
    monkeypatch.setattr(portals_discover_stage, "upsert", dead)
    with pytest.raises(psycopg.OperationalError):
        _discover(settings, site, "CH_ESCHK")
