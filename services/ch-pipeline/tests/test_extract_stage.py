import os
import pathlib

import psycopg
from psycopg.rows import dict_row
import pytest
from chpipe import text_quality
from chpipe.config import Settings
from chpipe.stages import extract_stage


def _settings(tmp_path) -> Settings:
    return Settings(dsn="postgresql://unused@127.0.0.1:1/unused", raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=99.0, max_attempts=3)


GOOD_DE_HTML = ("<html><body>" + "<p>Das Bundesgericht hat die Beschwerde des "
                "Beschwerdeführers gegen das Urteil des Obergerichts abgewiesen, "
                "soweit darauf einzutreten ist.</p>" * 8 + "</body></html>")


def test_html_body_extracts_and_goes_straight_to_extracted(tmp_path):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text(GOOD_DE_HTML)
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert "Bundesgericht" in text
    assert quality > text_quality.ACCEPT_THRESHOLD
    assert nxt == "extracted"


def test_a_pdf_with_no_text_layer_is_queued_for_ocr(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4 scan")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert text == ""
    assert quality == 0.0
    assert nxt == "ocr_pending"


def test_a_pdf_whose_text_layer_is_junk_is_queued_for_ocr(tmp_path, monkeypatch):
    """Presence is not quality. This is the case that silently poisons corpora."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: "B u n d e s g e r i c h t " * 40)
    _, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert quality < text_quality.ACCEPT_THRESHOLD
    assert nxt == "ocr_pending"


def test_html_that_extracts_to_junk_is_not_sent_to_ocr(tmp_path):
    """There is no scan behind an HTML page, so OCR cannot help; it fails instead."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text("<html><body>...</body></html>")
    _, _, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert nxt == "failed"


def test_a_missing_raw_file_raises_so_the_row_can_be_refetched(tmp_path):
    s = _settings(tmp_path)
    with pytest.raises(FileNotFoundError):
        extract_stage.extract_one(
            s, {"doc_id": "gone", "spider": "S", "text_source": "pdf", "languages": []})


# --- Round 1 finding: a db.complete() failure for one row must not abort the batch ---
#
# Derive repo root from this file's location: services/ch-pipeline/tests/test_extract_stage.py
# is 3 levels down from the repo root.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"


@pytest.fixture
def conn():
    if not os.environ.get("CHPIPE_TEST_DSN"):
        pytest.skip("CHPIPE_TEST_DSN not set")
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
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


def _seed_fetched(conn, doc_id, spider, text_source):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source) "
        "VALUES (%s,%s,%s,'fetched',%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, text_source))


def test_a_db_complete_failure_for_one_row_does_not_abort_the_rest_of_the_batch(
        conn, tmp_path, monkeypatch):
    """Round 1 finding: db.complete() sat OUTSIDE the try/except around
    future.result(), so a write failure for one row -- e.g. Postgres
    rejecting a NUL byte the extractor did not strip -- would escape the
    as_completed loop and kill the whole batch, the same defect class
    already fixed in index_stage and fetch_stage. The other rows in the same
    batch must still be extracted and completed, and the failing one must be
    counted and marked (attempts incremented, last_error set) rather than
    silently dropped, with run() itself completing without raising."""
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "good1.html").write_text(GOOD_DE_HTML)
    (tmp_path / spider / "bad.html").write_text(GOOD_DE_HTML)
    (tmp_path / spider / "good2.html").write_text(GOOD_DE_HTML)

    _seed_fetched(conn, "good1", spider, "html")
    _seed_fetched(conn, "bad", spider, "html")
    _seed_fetched(conn, "good2", spider, "html")

    real_complete = extract_stage.db.complete

    def flaky_complete(conn_, doc_id, next_stage, **fields):
        if doc_id == "bad":
            raise RuntimeError("simulated DataError: NUL byte in text")
        return real_complete(conn_, doc_id, next_stage, **fields)

    monkeypatch.setattr(extract_stage.db, "complete", flaky_complete)

    settings = Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                        http_concurrency=1, cpu_workers=2, ocr_workers=1,
                        load_ceiling=99.0, max_attempts=3)

    # limit=3 caps run() to a single batch: the three seeded rows. Without
    # a limit, run()'s outer while-loop would re-claim "bad" on its next
    # iteration -- it stays at stage 'fetched' after one failed write -- and
    # burn through its whole retry budget inside this one run() call, which
    # would mask the very assertion this test exists to make.
    report = extract_stage.run(settings, spider=spider, limit=3)   # must not raise

    rows = {r["doc_id"]: r for r in conn.execute(
        "SELECT doc_id, stage, attempts, last_error FROM ch_court_decisions"
        " WHERE spider = %s", (spider,)).fetchall()}

    assert rows["good1"]["stage"] == "extracted"
    assert rows["good2"]["stage"] == "extracted"
    assert rows["bad"]["stage"] == "fetched", \
        "one failed write must not exhaust the retry budget"
    assert rows["bad"]["attempts"] == 1
    assert "simulated DataError" in rows["bad"]["last_error"]

    assert report.extracted == 2
    assert report.failed == 1
