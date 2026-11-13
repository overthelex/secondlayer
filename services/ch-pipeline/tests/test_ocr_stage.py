import os
import pathlib

import psycopg
from psycopg.rows import dict_row
import pytest
from chpipe.config import Settings
from chpipe.stages import ocr_stage

from conftest import apply_migration_200, apply_migration_259


def test_pauses_at_or_above_the_ceiling():
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=6.0) is True
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=7.5) is True


def test_runs_below_the_ceiling():
    assert ocr_stage.should_pause(load_ceiling=6.0, load1=5.9) is False


def test_a_zero_ceiling_disables_the_guard():
    """Explicit opt-out for a maintenance window, not the default."""
    assert ocr_stage.should_pause(load_ceiling=0.0, load1=99.0) is False


# --- Guard: one document's exception must not abort the batch ---
#
# Every earlier stage in this pipeline (index, fetch, extract) had the same
# defect found in review: an exception escaping future.result() -- or a
# failure in the db.complete()/db.fail() write that follows it -- inside the
# as_completed loop kills the whole run. This stage claims the same pattern
# from extract_stage.run(), so it needs the same regression test.
#
# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_ocr_stage.py is 3 levels down from the repo root.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
# db.complete() re-queues a row in ch_citation_state (migration 200) on the
# 'extracted' branch, and ocr_stage reaches that branch on a recovered
# scan -- needs that table applied, same as test_citations_stage.py.


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
        # ch_act_article (migration 197's table, which 199 indexes but does
        # not create) and migrations 199 + 200 -- see tests/conftest.py.
        # 200 is what creates ch_citation_state, which db.complete() writes
        # to on every 'extracted' and 'loaded' transition.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        c.execute("DROP TABLE IF EXISTS ch_text_clean_state")
        apply_migration_259(c)
        yield c


def _seed_ocr_pending(conn, doc_id, spider):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "languages) VALUES (%s,%s,%s,'ocr_pending','pdf',%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, ["de"]))


def _settings(dsn, raw_dir) -> Settings:
    return Settings(dsn=dsn, raw_dir=raw_dir, http_concurrency=1, cpu_workers=1,
                    ocr_workers=2, load_ceiling=0.0, max_attempts=3)


def test_one_document_raising_does_not_abort_the_rest_of_the_batch(
        conn, tmp_path, monkeypatch):
    """One document that blows up inside _ocr_one (e.g. a corrupt PDF
    tesseract cannot render) must be recorded via db.fail() and counted, not
    let its exception escape the as_completed loop and kill the whole batch.
    The other rows in the same batch must still be OCR'd and completed."""
    spider = "S"
    (tmp_path / spider).mkdir()
    for doc_id in ("good1", "boom", "good2"):
        (tmp_path / spider / f"{doc_id}.pdf").write_bytes(b"%PDF-1.4 fake")
        _seed_ocr_pending(conn, doc_id, spider)

    real_ocr_one = ocr_stage._ocr_one

    def flaky_ocr_one(settings, row):
        if row["doc_id"] == "boom":
            raise RuntimeError("simulated tesseract crash")
        return "genuinely usable recovered text " * 40, 0.9, None

    monkeypatch.setattr(ocr_stage, "_ocr_one", flaky_ocr_one)

    settings = _settings(os.environ["CHPIPE_TEST_DSN"], tmp_path)

    # limit=3 caps run() to a single batch: without it, the outer while-loop
    # would re-claim "boom" on its next pass (it stays at stage
    # 'ocr_pending' after one failed attempt) and burn its whole retry
    # budget inside this one run() call, masking the assertion this test
    # exists to make.
    report = ocr_stage.run(settings, spider=spider, limit=3)   # must not raise

    rows = {r["doc_id"]: r for r in conn.execute(
        "SELECT doc_id, stage, attempts, last_error FROM ch_court_decisions"
        " WHERE spider = %s", (spider,)).fetchall()}

    assert rows["good1"]["stage"] == "extracted"
    assert rows["good2"]["stage"] == "extracted"
    assert rows["boom"]["stage"] == "ocr_pending", \
        "one failed attempt must not exhaust the retry budget"
    assert rows["boom"]["attempts"] == 1
    assert "simulated tesseract crash" in rows["boom"]["last_error"]

    assert report.recovered == 2
    assert report.failed == 1


# --- Round 1 review finding: a tool crash must not be recorded as a
# genuinely illegible document ---
#
# chpipe.ocr.ocr_pdf now raises ocr.OcrRenderFailed when pdftoppm or
# tesseract crash/time out, instead of returning "" as though OCR ran and
# found nothing. That exception must travel through the SAME per-document
# guard exercised above -- no second handler -- landing in db.fail() (retry
# budget preserved, diagnostic kept) rather than db.complete(..., "failed",
# text_quality=0.0) (retry budget burned, diagnostic erased, a fabricated
# quality score written for a document nobody actually read).
#
# This exercises the real _ocr_one, unlike the test above which replaces it
# wholesale -- only ocr.ocr_pdf itself is faked, so the guard wiring in
# run() is what is actually under test here.
def test_a_render_failure_keeps_the_document_queued_instead_of_closing_it_failed(
        conn, tmp_path, monkeypatch):
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "d.pdf").write_bytes(b"%PDF-1.4 fake")
    _seed_ocr_pending(conn, "d", spider)

    def crashing_ocr_pdf(path, languages, timeout=900, tmp_root=None):
        raise ocr_stage.ocr.OcrRenderFailed("simulated pdftoppm crash rendering d.pdf")

    monkeypatch.setattr(ocr_stage.ocr, "ocr_pdf", crashing_ocr_pdf)

    settings = _settings(os.environ["CHPIPE_TEST_DSN"], tmp_path)
    report = ocr_stage.run(settings, spider=spider, limit=1)   # must not raise

    row = conn.execute(
        "SELECT stage, attempts, last_error, text_quality FROM ch_court_decisions"
        " WHERE doc_id = %s", ("d",)).fetchone()

    assert row["stage"] == "ocr_pending", \
        "a tool crash must not close the row as 'failed'"
    assert row["attempts"] == 1
    assert "simulated pdftoppm crash" in row["last_error"]
    assert row["text_quality"] is None, \
        "a tool crash must not fabricate a quality score for a document nobody read"

    assert report.failed == 1
    assert report.still_bad == 0
    assert report.recovered == 0


def test_an_unreadable_scan_keeps_its_diagnosis_and_its_origin(
        conn, tmp_path, monkeypatch):
    """The other call site that used db.complete(..., "failed") and so lost
    last_error: a document OCR read and still could not make sense of."""
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "d.pdf").write_bytes(b"%PDF-1.4 fake")
    _seed_ocr_pending(conn, "d", spider)

    monkeypatch.setattr(ocr_stage, "_ocr_one", lambda s, r: ("noise", 0.11, None))

    report = ocr_stage.run(_settings(os.environ["CHPIPE_TEST_DSN"], tmp_path),
                           spider=spider, limit=1)

    row = conn.execute(
        "SELECT stage, failed_stage, last_error, text_quality, text_source "
        "FROM ch_court_decisions WHERE doc_id='d'").fetchone()
    assert row["stage"] == "failed"
    assert row["failed_stage"] == "ocr_pending"
    assert row["last_error"] and "quality" in row["last_error"]
    assert row["text_source"] == "ocr"
    assert report.still_bad == 1


# --- Task 7: recovered OCR text is stored cleaned, archived and stamped ---

# The raw-text archive lives at <raw_dir.parent>/raw-text, and pytest's
# tmp_path.parent is shared by every test in a session: give each test a
# raw_dir of its own one level down so archives cannot leak between tests.
@pytest.fixture
def raw_dir(tmp_path):
    d = tmp_path / "raw"
    d.mkdir()
    return d



from chpipe import raw_text_archive, text_clean

OCR_RAW = ("Das Bundesgericht hat die Beschwerde des Beschwerdefüh-\n"
           "rers gegen das Urteil des Obergerichts abgewiesen, soweit darauf "
           "einzutreten ist.\n") * 12


def _state(conn, doc_id):
    return conn.execute("SELECT * FROM ch_text_clean_state WHERE doc_id=%s",
                        (doc_id,)).fetchone()


def _run_ocr(conn, raw_dir, monkeypatch, spider, raw=OCR_RAW):
    (raw_dir / spider).mkdir(exist_ok=True)
    (raw_dir / spider / "d.pdf").write_bytes(b"%PDF-1.4 fake")
    _seed_ocr_pending(conn, "d", spider)
    monkeypatch.setattr(ocr_stage.ocr, "ocr_pdf", lambda *a, **k: raw)
    return ocr_stage.run(_settings(os.environ["CHPIPE_TEST_DSN"], raw_dir),
                         spider=spider, limit=1)


def test_ocr_text_is_stored_cleaned_archived_and_stamped(conn, raw_dir, monkeypatch):
    report = _run_ocr(conn, raw_dir, monkeypatch, "CH_ZG")
    assert report.recovered == 1
    row = conn.execute("SELECT full_text, stage, text_source FROM ch_court_decisions "
                       "WHERE doc_id='d'").fetchone()
    assert row["stage"] == "extracted" and row["text_source"] == "ocr"
    assert row["full_text"] == text_clean.clean_pdf_text(OCR_RAW, ["de"])
    assert "Beschwerdeführers" in row["full_text"]
    assert raw_text_archive.load(raw_dir, "CH_ZG", "d") == OCR_RAW
    st = _state(conn, "d")
    assert st["cleaned_at"] is not None
    assert st["raw_sha256"] == raw_text_archive.sha256_of(OCR_RAW)
    assert st["cleaner_version"] == text_clean.CLEANER_VERSION


@pytest.mark.parametrize("spider", ["CH_WEKO_RPW", "CH_WEKO"])
def test_ocr_leaves_own_reflow_spiders_untouched(conn, raw_dir, monkeypatch, spider):
    report = _run_ocr(conn, raw_dir, monkeypatch, spider)
    assert report.recovered == 1
    assert conn.execute("SELECT full_text FROM ch_court_decisions WHERE doc_id='d'"
                        ).fetchone()["full_text"] == OCR_RAW
    assert not raw_text_archive.path_for(raw_dir, spider, "d").exists()
    assert _state(conn, "d") is None


def test_ocr_archive_conflict_stores_raw_uncleaned_and_does_not_stamp(
        conn, raw_dir, monkeypatch):
    raw_text_archive.save(raw_dir, "CH_ZG", "d", "some earlier raw text " * 30)
    report = _run_ocr(conn, raw_dir, monkeypatch, "CH_ZG")
    assert report.recovered == 1
    assert report.archive_conflict == 1
    assert conn.execute("SELECT full_text FROM ch_court_decisions WHERE doc_id='d'"
                        ).fetchone()["full_text"] == OCR_RAW
    assert _state(conn, "d") is None


def test_ocr_text_write_and_stamp_are_one_transaction(conn, raw_dir, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("simulated stamp failure")
    monkeypatch.setattr(ocr_stage.db, "ensure_clean_state_stamped", boom)
    report = _run_ocr(conn, raw_dir, monkeypatch, "CH_ZG")
    row = conn.execute("SELECT stage, full_text FROM ch_court_decisions "
                       "WHERE doc_id='d'").fetchone()
    assert row["stage"] == "ocr_pending" and row["full_text"] is None
    assert report.failed == 1
    assert _state(conn, "d") is None
