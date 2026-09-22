"""rpw_stage against a mocked weko.admin.ch and a real Postgres: rows land
at 'extracted' in the shape load_stage promotes, a second run changes
nothing, and a changed issue file rewrites only what changed."""
import os
import pathlib

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import rpw
from chpipe.config import Settings
from chpipe.stages import load_stage, rpw_stage

from conftest import apply_migration_200
from test_rpw import INDEX_HTML, PAGES

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
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
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        c.execute("INSERT INTO ch_court_decisions (ecli, spider, doc_id, docket_number, decision_date, stage) "
                  "VALUES ('ECLI:CH:CH_WEKO:CH_WBK_001_Post', 'CH_WEKO', 'CH_WBK_001_Post', "
                  "'Zusammenschlussvorhaben Post CH AG / Quickmail Holding AG', '2024-01-15', 'loaded')")
        yield c


class Weko:
    def __init__(self):
        self.pdf = b"%PDF-1.7 issue one"
        self.calls: list[str] = []

    def __call__(self, request):
        url = str(request.url)
        self.calls.append(url)
        if url.endswith("recht-und-politik-des-wettbewerbs-rpw"):
            return httpx.Response(200, text=INDEX_HTML)
        if url.endswith(".pdf"):
            return httpx.Response(200, content=self.pdf, headers={"content-type": "application/pdf"})
        return httpx.Response(404)


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(rpw_stage, "REQUEST_DELAY", 0.0)
    # pdftotext is not what is under test: every "issue" reads as the 2024/2 pages.
    monkeypatch.setattr(rpw_stage, "pdf_pages", lambda path: PAGES)


def _run(settings, site, **kw):
    return rpw_stage.run(settings, years={2024}, transport=httpx.MockTransport(site), **kw)


def _rows(conn):
    return {r["doc_id"]: r for r in conn.execute(
        "SELECT * FROM ch_court_decisions WHERE spider = 'CH_WEKO_RPW' ORDER BY doc_id").fetchall()}


def test_rows_arrive_extracted_and_load_promotes_them(settings, conn):
    site = Weko()
    report = _run(settings, site)
    assert (report.issues_listed, report.issues_downloaded, report.issues_failed) == (1, 1, 0)
    assert (report.documents, report.inserted) == (2, 2)
    assert not any("1999" in c for c in site.calls)            # the years filter held
    rows = _rows(conn)
    assert set(rows) == {"RPW_2024-2_B2.3.1", "RPW_2024-2_B2.3.2"}
    r = rows["RPW_2024-2_B2.3.1"]
    assert r["ecli"] == "ECLI:CH:CH_WEKO_RPW:RPW_2024-2_B2.3.1"
    assert (r["court_code"], r["canton"], r["stage"], r["text_source"]) == ("CH_WBK_RPW", "CH", "extracted", "pdf")
    assert r["decision_type"] == "Unternehmenszusammenschlüsse"
    assert r["chamber"] == "Wettbewerbskommission"
    assert r["docket_number"] == "RPW 2024/2, S. 375"
    assert r["abstract"] == "TX/H. Locher Consulting & Marketing"
    assert str(r["decision_date"]) == "2024-04-25"
    assert r["languages"] == ["de"] and r["text_quality"] >= 0.55
    assert r["pdf_url"] == "https://www.weko.admin.ch/dam/de/sd-web/AAAA/rpw_dpc_2024_2.pdf#page=3"
    assert r["metadata_json"]["rpw"]["issue"] == "2024/2"
    # the entscheidsuche copy of the same decision is named, not duplicated away
    assert rows["RPW_2024-2_B2.3.2"]["metadata_json"]["rpw"]["same_as"] == "ECLI:CH:CH_WEKO:CH_WBK_001_Post"
    # queued for citations like any freshly extracted decision
    queued = {x["ecli"] for x in conn.execute("SELECT ecli FROM ch_citation_state").fetchall()}
    assert {r["ecli"] for r in rows.values()} <= queued

    load = load_stage.run(settings, spider="CH_WEKO_RPW")
    assert load.loaded == 2
    assert {r["stage"] for r in _rows(conn).values()} == {"loaded"}


def test_a_second_run_skips_the_issue_and_touches_nothing(settings, conn):
    site = Weko()
    _run(settings, site)
    before = {k: r["updated_at"] for k, r in _rows(conn).items()}
    report = _run(settings, site)
    assert (report.issues_skipped, report.issues_downloaded, report.documents) == (1, 0, 0)
    assert {k: r["updated_at"] for k, r in _rows(conn).items()} == before


def test_force_recut_rewrites_nothing_whose_text_is_unchanged(settings, conn):
    site = Weko()
    _run(settings, site)
    report = _run(settings, site, force=True)
    assert (report.documents, report.unchanged, report.inserted, report.updated) == (2, 2, 0, 0)


def test_a_replaced_issue_file_rewrites_its_rows(settings, conn, tmp_path):
    site = Weko()
    _run(settings, site)
    (settings.raw_dir / rpw.SPIDER / "issues" / "RPW_2024-2.pdf").write_bytes(b"%PDF-1.7 issue two")
    report = _run(settings, site)
    assert (report.issues_skipped, report.updated) == (0, 2)


def test_a_page_that_is_not_a_pdf_fails_the_issue(settings, conn):
    site = Weko()
    site.pdf = b"<html>maintenance</html>"
    report = _run(settings, site)
    assert (report.issues_failed, report.documents) == (1, 0)
    assert not (settings.raw_dir / rpw.SPIDER / "issues" / "RPW_2024-2.pdf").exists()
