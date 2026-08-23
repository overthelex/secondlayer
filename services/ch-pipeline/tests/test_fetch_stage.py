import asyncio
import hashlib
import os
import pathlib

import psycopg
import pytest

from chpipe import db
from chpipe.config import Settings
from chpipe.stages import fetch_stage


def test_raw_path_shards_by_spider():
    p = fetch_stage.raw_path(pathlib.Path("/data/raw"), "ZG_Obergericht", "d1", "pdf")
    assert p == pathlib.Path("/data/raw/ZG_Obergericht/d1.pdf")


def test_raw_path_refuses_a_doc_id_that_escapes_the_directory():
    """Document ids come from a remote listing; a ../ in one must not write
    outside raw_dir."""
    with pytest.raises(ValueError, match="unsafe"):
        fetch_stage.raw_path(pathlib.Path("/data/raw"), "S", "../../etc/passwd", "pdf")


def test_choose_body_prefers_html():
    row = {"html_url": "https://x/d.html", "pdf_url": "https://x/d.pdf"}
    assert fetch_stage.choose_body(row) == ("html", "https://x/d.html")


def test_choose_body_falls_back_to_pdf():
    row = {"html_url": None, "pdf_url": "https://x/d.pdf"}
    assert fetch_stage.choose_body(row) == ("pdf", "https://x/d.pdf")


def test_choose_body_returns_none_when_there_is_no_body():
    assert fetch_stage.choose_body({"html_url": None, "pdf_url": None}) is None


def test_write_body_creates_parents_and_returns_sha256(tmp_path):
    payload = b"%PDF-1.4 body"
    path, digest = fetch_stage.write_body(tmp_path, "ZG_Obergericht", "d1", "pdf", payload)
    assert path.read_bytes() == payload
    assert digest == hashlib.sha256(payload).hexdigest()


def test_write_body_skips_rewriting_identical_bytes(tmp_path):
    payload = b"same"
    p1, d1 = fetch_stage.write_body(tmp_path, "S", "d", "pdf", payload)
    mtime = p1.stat().st_mtime_ns
    p2, d2 = fetch_stage.write_body(tmp_path, "S", "d", "pdf", payload)
    assert d1 == d2
    assert p2.stat().st_mtime_ns == mtime, "unchanged bytes must not be rewritten"


# --- Robustness fix: a write/db failure for one row must not abort the batch ---
#
# Derive repo root from this file's location: services/ch-pipeline/tests/test_fetch_stage.py
# is 3 levels down from the repo root.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"


@pytest.fixture
def conn():
    if not os.environ.get("CHPIPE_TEST_DSN"):
        pytest.skip("CHPIPE_TEST_DSN not set")
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
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
        c.execute(MIGRATION.read_text())
        yield c


def _seed(conn, doc_id, spider="ZG_Obergericht", html_url=None, pdf_url=None):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, html_url, pdf_url) "
        "VALUES (%s,%s,%s,'indexed',%s,%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, html_url, pdf_url),
    )


class FakeFetcher:
    async def bytes(self, url):
        return f"body:{url}".encode()


def test_a_write_failure_for_one_row_does_not_abort_the_rest_of_the_batch(
        conn, monkeypatch, tmp_path):
    """The identical defect found and fixed in the index stage: write_body()
    raising inside asyncio.gather must not cancel the sibling tasks in the
    batch or unwind the whole stage run. The other rows must still be fetched
    and recorded, and the failing row must be counted as failed rather than
    silently dropped."""
    _seed(conn, "GOOD1", html_url="https://x/GOOD1.html")
    _seed(conn, "BAD", html_url="https://x/BAD.html")
    _seed(conn, "GOOD2", html_url="https://x/GOOD2.html")

    real_write_body = fetch_stage.write_body

    def flaky_write_body(raw_dir, spider, doc_id, extension, payload):
        if doc_id == "BAD":
            raise ValueError("simulated disk failure")
        return real_write_body(raw_dir, spider, doc_id, extension, payload)

    monkeypatch.setattr(fetch_stage, "write_body", flaky_write_body)

    settings = Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=4,
                         cpu_workers=1, ocr_workers=1, load_ceiling=6.0,
                         max_attempts=3)
    rows = db.claim(conn, "indexed", limit=10)
    report = fetch_stage.FetchReport()
    asyncio.run(fetch_stage._fetch_batch(FakeFetcher(), conn, rows, settings, report))

    good1 = conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='GOOD1'").fetchone()
    good2 = conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='GOOD2'").fetchone()
    bad = conn.execute(
        "SELECT stage, attempts, last_error FROM ch_court_decisions WHERE doc_id='BAD'"
    ).fetchone()

    assert good1[0] == "fetched"
    assert good2[0] == "fetched"
    assert bad[0] == "indexed", "one failed attempt must not exhaust the retry budget"
    assert bad[1] == 1
    assert "simulated disk failure" in bad[2]
    assert report.fetched_html == 2
    assert report.failed == 1
