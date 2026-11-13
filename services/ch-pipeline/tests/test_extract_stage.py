import logging
import os
import pathlib
import shutil

import psycopg
from psycopg.rows import dict_row
import pytest
from chpipe import raw_text_archive, text_clean, text_damage, text_quality
from chpipe.config import Settings
from chpipe.stages import clean_text_stage, extract_stage

from conftest import apply_migration_200, apply_migration_260


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
    text, quality, nxt, _ = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert "Bundesgericht" in text
    # The accented characters are the point. "Bundesgericht" alone is pure
    # ASCII, so it is equally present in the mojibake this branch exists to
    # repair ("BeschwerdefÃ¼hrers"): the old assertion passed against a
    # corrupted extraction, and so did the quality gate (measured 0.9850 for
    # mojibake versus 0.9820 for the same document clean).
    assert "Beschwerdeführers" in text
    assert "Ã" not in text and "Â" not in text
    assert quality > text_quality.ACCEPT_THRESHOLD
    assert nxt == "extracted"


def test_a_pdf_with_no_text_layer_is_queued_for_ocr(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4 scan")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")
    text, quality, nxt, _ = extract_stage.extract_one(
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
    _, quality, nxt, _ = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert quality < text_quality.ACCEPT_THRESHOLD
    assert nxt == "ocr_pending"


def test_html_that_extracts_to_junk_is_not_sent_to_ocr(tmp_path):
    """There is no scan behind an HTML page, so OCR cannot help; it fails instead."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text("<html><body>...</body></html>")
    _, _, nxt, _ = extract_stage.extract_one(
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
# db.complete() re-queues a row in ch_citation_state (migration 200) on the
# 'extracted' branch -- every test here that reaches that branch needs that
# table applied, same as test_citations_stage.py.


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
        apply_migration_260(c)
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


def test_a_terminal_html_failure_keeps_its_diagnosis_and_its_origin(
        conn, tmp_path):
    """extract_stage used db.complete(..., "failed"), which clears
    last_error as part of its own SET list -- so the quality score that
    condemned the document, and the fact that it died in extraction at all,
    both vanished. Bad-quality HTML is one of the two most diagnostically
    interesting failure classes in the pipeline and it was landing in the
    README triage query as an anonymous NULL bucket."""
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "junk.html").write_text("<html><body>...</body></html>")
    _seed_fetched(conn, "junk", spider, "html")

    settings = Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                        http_concurrency=1, cpu_workers=1, ocr_workers=1,
                        load_ceiling=99.0, max_attempts=3,
                        retry_backoff_minutes=())
    report = extract_stage.run(settings, spider=spider, limit=1)

    row = conn.execute(
        "SELECT stage, failed_stage, last_error, text_quality, attempts "
        "FROM ch_court_decisions WHERE doc_id='junk'").fetchone()
    assert row["stage"] == "failed"
    assert row["failed_stage"] == "fetched"
    assert row["last_error"] and "quality" in row["last_error"]
    assert row["text_quality"] is not None
    assert row["attempts"] == 0, "a terminal verdict is not a spent retry"
    assert report.failed == 1


# --- Spec section 8: the PDF is deleted after a successful extraction ---

def _pdf_row(conn, doc_id, spider="S"):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "languages) VALUES (%s,%s,%s,'fetched','pdf',%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, ["de"]))


def _pdf_settings(tmp_path, keep=False):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=99.0, max_attempts=3,
                    retry_backoff_minutes=(), keep_raw_pdf=keep)


GOOD_DE_TEXT = ("Das Bundesgericht hat die Beschwerde des Beschwerdeführers "
                "gegen das Urteil des Obergerichts abgewiesen, soweit darauf "
                "einzutreten ist. ") * 8


def test_a_successfully_extracted_pdf_is_deleted(conn, tmp_path, monkeypatch):
    """Spec section 8's disk rule, which was never implemented anywhere."""
    (tmp_path / "S").mkdir()
    pdf = tmp_path / "S" / "d.pdf"
    pdf.write_bytes(b"%PDF-1.4 scan")
    _pdf_row(conn, "d")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: GOOD_DE_TEXT)

    report = extract_stage.run(_pdf_settings(tmp_path), spider="S", limit=1)

    assert report.extracted == 1
    assert not pdf.exists()


def test_a_pdf_sent_to_ocr_is_kept(conn, tmp_path, monkeypatch):
    """"except when text_quality is below the threshold or OCR was involved"
    -- the whole point of ocr_pending is that the file gets read again."""
    (tmp_path / "S").mkdir()
    pdf = tmp_path / "S" / "d.pdf"
    pdf.write_bytes(b"%PDF-1.4 scan")
    _pdf_row(conn, "d")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")

    report = extract_stage.run(_pdf_settings(tmp_path), spider="S", limit=1)

    assert report.queued_for_ocr == 1
    assert pdf.exists(), "a document still to be OCR'd must keep its PDF"


def test_an_html_body_is_never_deleted(conn, tmp_path):
    """HTML is small, and it is the input to the one extraction path with no
    second chance -- bad-quality HTML is terminal."""
    (tmp_path / "S").mkdir()
    html = tmp_path / "S" / "d.html"
    html.write_text(GOOD_DE_HTML)
    _seed_fetched(conn, "d", "S", "html")

    extract_stage.run(_pdf_settings(tmp_path), spider="S", limit=1)
    assert html.exists()


def test_keep_raw_pdf_switches_the_deletion_off(conn, tmp_path, monkeypatch):
    """What Gate A needs: the sample's PDFs must survive for inspection."""
    (tmp_path / "S").mkdir()
    pdf = tmp_path / "S" / "d.pdf"
    pdf.write_bytes(b"%PDF-1.4 scan")
    _pdf_row(conn, "d")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: GOOD_DE_TEXT)

    extract_stage.run(_pdf_settings(tmp_path, keep=True), spider="S", limit=1)
    assert pdf.exists()


def test_a_failed_write_never_costs_the_source_file(conn, tmp_path, monkeypatch):
    """Deletion happens after the database write, never before: a row that
    is going to be retried must still have something to retry from."""
    (tmp_path / "S").mkdir()
    pdf = tmp_path / "S" / "d.pdf"
    pdf.write_bytes(b"%PDF-1.4 scan")
    _pdf_row(conn, "d")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: GOOD_DE_TEXT)
    monkeypatch.setattr(extract_stage.db, "complete",
                        lambda *a, **k: (_ for _ in ()).throw(
                            RuntimeError("simulated write failure")))

    extract_stage.run(_pdf_settings(tmp_path), spider="S", limit=1)
    assert pdf.exists()


# --- An HTML card with a PDF behind it is a re-queue, not a failure ---
# GE_TAPI's HTML is a 3 KB card (docket, descriptors, `var pdfUrl = ...`) and
# AG_Gerichte's is a Weblaw "AGVE - Archiv" shell; the decision is the PDF.
# choose_body() prefers HTML, so on the first prod run 506 documents with a
# pdf_url in the table were retired as "no scan behind an HTML page".

def _seed_fetched_html_card(conn, doc_id, spider, pdf_url):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "html_url, pdf_url) VALUES (%s,%s,%s,'fetched','html',%s,%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id,
         f"https://x/{doc_id}.html", pdf_url))


def _card_settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, retry_backoff_minutes=())


def test_a_bad_html_body_with_a_pdf_behind_it_is_requeued_for_the_pdf(conn, tmp_path):
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "card.html").write_text(
        "<html><body><script>var pdfUrl = '/apps/decis/x.pdf'</script></body></html>")
    _seed_fetched_html_card(conn, "card", spider, "https://x/card.pdf")

    report = extract_stage.run(_card_settings(tmp_path), spider=spider, limit=1)

    row = conn.execute(
        "SELECT stage, html_url, text_source, last_error, attempts, failed_stage "
        "FROM ch_court_decisions WHERE doc_id='card'").fetchone()
    assert row["stage"] == "indexed", "back to the front of the queue"
    assert row["html_url"] == "https://x/card.html", \
        "kept: a re-index would restore it anyway; the preference lives elsewhere"
    assert row["text_source"] == "pdf", "the body this document wants"
    assert row["last_error"] and "re-queued for the PDF" in row["last_error"]
    assert row["attempts"] == 0, "nothing was retried; the body was wrong"
    assert row["failed_stage"] is None
    assert report.requeued_for_pdf == 1
    assert report.failed == 0


def test_a_bad_html_body_without_a_pdf_is_still_terminal(conn, tmp_path):
    spider = "S"
    (tmp_path / spider).mkdir()
    (tmp_path / spider / "card.html").write_text("<html><body>...</body></html>")
    _seed_fetched_html_card(conn, "card", spider, None)

    report = extract_stage.run(_card_settings(tmp_path), spider=spider, limit=1)

    row = conn.execute(
        "SELECT stage, failed_stage FROM ch_court_decisions WHERE doc_id='card'").fetchone()
    assert row["stage"] == "failed"
    assert row["failed_stage"] == "fetched"
    assert report.requeued_for_pdf == 0
    assert report.failed == 1


def test_requeue_for_pdf_refuses_a_row_with_no_pdf_and_leaves_it_untouched(conn):
    """The refusal rests on the UPDATE's WHERE matching zero rows; a future
    change that wrote fields before checking rowcount would still raise --
    so the row itself is asserted, not just the exception."""
    from chpipe import db
    _seed_fetched_html_card(conn, "nopdf", "S", None)
    with pytest.raises(db.QueueWriteMissed):
        db.requeue_for_pdf(conn, "nopdf", "x")
    row = conn.execute("SELECT stage, html_url, text_source, last_error "
                       "FROM ch_court_decisions WHERE doc_id='nopdf'").fetchone()
    assert row["stage"] == "fetched"
    assert row["html_url"] == "https://x/nopdf.html"
    assert row["text_source"] == "html"
    assert row["last_error"] is None


# --- Task 7: new PDF decisions are stored cleaned, raw archived, state stamped ---

# The raw-text archive lives at <raw_dir.parent>/raw-text, and pytest's
# tmp_path.parent is shared by every test in a session: give each test a
# raw_dir of its own one level down so archives cannot leak between tests.
@pytest.fixture
def raw_dir(tmp_path):
    d = tmp_path / "raw"
    d.mkdir()
    return d


# The same real PDF the clean-text tests use: it has hyphen line-wraps.
ZG_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"


def _put_zg_pdf(raw_dir, spider, doc_id):
    (raw_dir / spider).mkdir(exist_ok=True)
    shutil.copy(ZG_PDF, raw_dir / spider / f"{doc_id}.pdf")


def _seed_zg_row(conn, doc_id, spider="CH_ZG"):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "languages) VALUES (%s,%s,%s,'fetched','pdf',%s)",
        (f"ECLI:CH:{spider}:{doc_id}", spider, doc_id, ["de"]))


def _state(conn, doc_id):
    return conn.execute("SELECT * FROM ch_text_clean_state WHERE doc_id=%s",
                        (doc_id,)).fetchone()


def _full_text(conn, doc_id):
    return conn.execute("SELECT full_text, stage FROM ch_court_decisions "
                        "WHERE doc_id=%s", (doc_id,)).fetchone()


def test_a_new_pdf_is_stored_cleaned_archived_and_stamped(conn, raw_dir):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")
    assert text_damage.markers(raw)["hyphen_breaks"] > 0   # the fixture is damaged

    report = extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)

    assert report.extracted == 1
    row = _full_text(conn, "z1")
    assert row["stage"] == "extracted"
    assert text_damage.markers(row["full_text"])["hyphen_breaks"] == 0
    assert row["full_text"] == text_clean.clean_pdf_text(raw, ["de"])
    arch = raw_text_archive.path_for(raw_dir, "CH_ZG", "z1")
    assert arch.exists()
    assert raw_text_archive.load(raw_dir, "CH_ZG", "z1") == raw
    st = _state(conn, "z1")
    assert st["cleaned_at"] is not None
    assert st["raw_sha256"] == raw_text_archive.sha256_of(raw)
    assert st["cleaner_version"] == text_clean.CLEANER_VERSION


def test_text_quality_is_scored_on_the_cleaned_text(conn, raw_dir, monkeypatch):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    seen = []
    real = extract_stage.text_quality.score_with_relabel
    monkeypatch.setattr(extract_stage.text_quality, "score_with_relabel",
                        lambda t, l: seen.append(t) or real(t, l))
    extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)
    assert seen and all(text_damage.markers(t)["hyphen_breaks"] == 0 for t in seen)


@pytest.mark.parametrize("spider", ["CH_WEKO_RPW", "CH_WEKO"])
def test_own_reflow_spiders_are_left_untouched(conn, raw_dir, monkeypatch, spider):
    (raw_dir / spider).mkdir()
    (raw_dir / spider / "d.pdf").write_bytes(b"%PDF-1.4")
    _seed_zg_row(conn, "d", spider)
    raw = GOOD_DE_TEXT + "\nhyphen-\nated line\n"
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: raw)
    extract_stage.run(_pdf_settings(raw_dir), spider=spider, limit=1)
    assert _full_text(conn, "d")["full_text"] == raw
    assert not raw_text_archive.path_for(raw_dir, spider, "d").exists()
    assert _state(conn, "d") is None


def test_an_html_row_is_not_archived_cleaned_or_stamped(conn, raw_dir):
    (raw_dir / "CH_ZG").mkdir()
    (raw_dir / "CH_ZG" / "h.html").write_text(GOOD_DE_HTML)
    _seed_fetched(conn, "h", "CH_ZG", "html")
    extract_stage.run(_pdf_settings(raw_dir), spider="CH_ZG", limit=1)
    assert _full_text(conn, "h")["stage"] == "extracted"
    assert not raw_text_archive.path_for(raw_dir, "CH_ZG", "h").exists()
    assert _state(conn, "h") is None


def test_an_empty_pdf_text_gets_no_archive_and_no_state(conn, raw_dir, monkeypatch):
    (raw_dir / "CH_ZG").mkdir()
    (raw_dir / "CH_ZG" / "e.pdf").write_bytes(b"%PDF-1.4")
    _seed_zg_row(conn, "e")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")
    report = extract_stage.run(_pdf_settings(raw_dir), spider="CH_ZG", limit=1)
    assert report.queued_for_ocr == 1
    assert not raw_text_archive.path_for(raw_dir, "CH_ZG", "e").exists()
    assert _state(conn, "e") is None


def test_a_pdf_queued_for_ocr_is_not_archived(conn, raw_dir, monkeypatch):
    """Junk text is not stored, so it must not occupy the archive slot the
    OCR text will need later."""
    (raw_dir / "CH_ZG").mkdir()
    (raw_dir / "CH_ZG" / "j.pdf").write_bytes(b"%PDF-1.4")
    _seed_zg_row(conn, "j")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: "B u n d e s g e r i c h t " * 40)
    report = extract_stage.run(_pdf_settings(raw_dir), spider="CH_ZG", limit=1)
    assert report.queued_for_ocr == 1
    assert not raw_text_archive.path_for(raw_dir, "CH_ZG", "j").exists()
    assert _state(conn, "j") is None


def test_re_extraction_with_different_raw_stores_raw_uncleaned_and_does_not_stamp(
        conn, raw_dir, monkeypatch, caplog):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    old_raw = "old archived raw text that differs entirely. " * 20
    raw_text_archive.save(raw_dir, "CH_ZG", "z1", old_raw)
    new_raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")
    arch = raw_text_archive.path_for(raw_dir, "CH_ZG", "z1")
    before = arch.read_bytes()

    with caplog.at_level(logging.WARNING):
        report = extract_stage.run(_pdf_settings(raw_dir, keep=True),
                                   spider="CH_ZG", limit=1)

    assert report.extracted == 1
    assert report.archive_conflict == 1
    assert _full_text(conn, "z1")["full_text"] == new_raw   # raw, uncleaned
    assert arch.read_bytes() == before                       # never overwritten
    assert _state(conn, "z1")["cleaned_at"] is None   # not stamped
    assert any("archive" in r.message for r in caplog.records)


def test_an_unreadable_existing_archive_stores_raw_uncleaned_and_counts_it(
        conn, raw_dir):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    arch = raw_text_archive.path_for(raw_dir, "CH_ZG", "z1")
    arch.parent.mkdir(parents=True, exist_ok=True)
    arch.write_bytes(b"not gzip at all")
    new_raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")

    report = extract_stage.run(_pdf_settings(raw_dir, keep=True),
                               spider="CH_ZG", limit=1)

    assert report.extracted == 1
    assert report.archive_conflict == 1
    assert _full_text(conn, "z1")["full_text"] == new_raw
    assert arch.read_bytes() == b"not gzip at all"
    assert _state(conn, "z1")["cleaned_at"] is None   # not stamped


def test_the_text_write_and_the_stamp_are_one_transaction(conn, raw_dir, monkeypatch):
    """A failure stamping must roll back the full_text write (and vice versa)."""
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")

    def boom(*a, **k):
        raise RuntimeError("simulated stamp failure")
    monkeypatch.setattr(extract_stage.db, "ensure_clean_state_stamped", boom)

    report = extract_stage.run(_pdf_settings(raw_dir, keep=True),
                               spider="CH_ZG", limit=1)

    row = conn.execute("SELECT stage, full_text, attempts FROM ch_court_decisions "
                       "WHERE doc_id='z1'").fetchone()
    assert row["stage"] == "fetched"
    assert row["full_text"] is None
    assert row["attempts"] == 1
    assert report.failed == 1
    assert _state(conn, "z1") is None


def test_claim_carries_the_sprache_the_cleaner_needs(conn):
    from chpipe import db
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, text_source, "
        "languages, metadata_json) VALUES ('e','CH_ZG','s1','fetched','pdf','{de}', "
        "'{\"Sprache\": \"Français\"}')")
    rows = db.claim(conn, "fetched", limit=5, spider="CH_ZG")
    assert rows[0]["sprache"] == "Français"


# --- archive conflict un-stamps the old state row (data-loss guard) ---

def _stamp_old(conn, doc_id, old_raw):
    conn.execute(
        "INSERT INTO ch_text_clean_state (doc_id, spider, raw_sha256, cleaner_version, "
        "cleaned_at, attempts) VALUES (%s,'CH_ZG',%s,1,now(),1)",
        (doc_id, raw_text_archive.sha256_of(old_raw)))


def _conflict_then_backfill(conn, raw_dir, archive_setup, unreadable=False):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    old_raw = "old archived raw text that differs entirely. " * 20
    archive_setup(old_raw)
    _stamp_old(conn, "z1", old_raw)
    new_raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")
    arch = raw_text_archive.path_for(raw_dir, "CH_ZG", "z1")
    before = arch.read_bytes()
    report = extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)
    assert report.archive_conflict == 1
    assert _full_text(conn, "z1")["full_text"] == new_raw
    st = _state(conn, "z1")
    assert st["cleaned_at"] is None and st["raw_sha256"] is None
    assert st["last_error"].startswith("archive conflict")
    assert st["attempts"] == 1
    # The backfill (after a cleaner-version requeue it would see exactly this).
    conn.execute("UPDATE ch_court_decisions SET stage='loaded' WHERE doc_id='z1'")
    r = clean_text_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG")
    # A readable differing archive is parked as an archive conflict; an
    # unreadable one is the stage's hard failure. Either way: not cleaned,
    # nothing overwritten, one attempt spent.
    if unreadable:
        assert r.failed == 1 and r.archive_conflict == 0 and r.cleaned == 0
    else:
        assert r.archive_conflict == 1 and r.failed == 0 and r.cleaned == 0
    assert _full_text(conn, "z1")["full_text"] == new_raw
    assert arch.read_bytes() == before
    return st


def test_conflict_unstamps_the_old_state_and_backfill_leaves_new_raw_alone(conn, raw_dir):
    st = _conflict_then_backfill(
        conn, raw_dir, lambda old: raw_text_archive.save(raw_dir, "CH_ZG", "z1", old))
    assert "sha=" in st["last_error"]


def test_unreadable_archive_unstamps_the_old_state_too(conn, raw_dir):
    def bad(_old):
        a = raw_text_archive.path_for(raw_dir, "CH_ZG", "z1")
        a.parent.mkdir(parents=True, exist_ok=True)
        a.write_bytes(b"not gzip at all")
    _conflict_then_backfill(conn, raw_dir, bad, unreadable=True)


# --- fix round 1 ---

def test_missing_state_table_disables_cleaning_for_the_run(conn, raw_dir, caplog):
    """Deploy order: code is rsynced before migration 260 runs. The stage must
    behave exactly as before this task: raw text, no archive, no state write."""
    conn.execute("DROP TABLE ch_text_clean_state")
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")
    with caplog.at_level(logging.ERROR):
        report = extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)
    assert report.extracted == 1 and report.failed == 0
    assert report.cleaning_disabled is True
    assert _full_text(conn, "z1")["full_text"] == raw
    assert not raw_text_archive.path_for(raw_dir, "CH_ZG", "z1").exists()
    assert sum("ch_text_clean_state" in r.message and r.levelno == logging.ERROR
               for r in caplog.records) == 1


def test_a_new_archive_that_cannot_be_written_is_reported_as_a_write_failure(
        conn, raw_dir, monkeypatch, caplog):
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    raw = extract_stage.text_extract.from_pdf(raw_dir / "CH_ZG" / "z1.pdf")

    def enospc(*a, **k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(clean_text_stage.raw_text_archive, "save", enospc)
    with caplog.at_level(logging.ERROR):
        report = extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)
    assert report.extracted == 1 and report.archive_conflict == 1
    assert _full_text(conn, "z1")["full_text"] == raw
    st = _state(conn, "z1")
    assert st["cleaned_at"] is None and st["raw_sha256"] is None
    assert st["last_error"].startswith("archive write failed")
    assert any("archive write failed" in r.message and r.levelno == logging.ERROR
               for r in caplog.records)


def test_a_conflict_that_sends_the_row_to_ocr_leaves_the_old_state_alone(
        conn, raw_dir, monkeypatch):
    """full_text is not written for ocr_pending, so the old stamp stays true
    and the conflict is neither recorded nor counted."""
    (raw_dir / "CH_ZG").mkdir()
    (raw_dir / "CH_ZG" / "q.pdf").write_bytes(b"%PDF-1.4")
    _seed_zg_row(conn, "q")
    old_raw = "old archived raw text that differs entirely. " * 20
    raw_text_archive.save(raw_dir, "CH_ZG", "q", old_raw)
    _stamp_old(conn, "q", old_raw)
    # Clean text is good (accepted), the raw it was cleaned from is not.
    raw = "x"
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: raw)
    monkeypatch.setattr(clean_text_stage.text_clean, "clean_pdf_text",
                        lambda r, l: GOOD_DE_TEXT)
    scores = iter([(0.99, None), (0.1, None)])
    monkeypatch.setattr(extract_stage.text_quality, "score_with_relabel",
                        lambda t, l: next(scores))
    monkeypatch.setattr(clean_text_stage.text_quality, "score_with_relabel",
                        lambda t, l: next(scores))
    report = extract_stage.run(_pdf_settings(raw_dir), spider="CH_ZG", limit=1)
    assert report.queued_for_ocr == 1 and report.archive_conflict == 0
    st = _state(conn, "q")
    assert st["cleaned_at"] is not None and st["raw_sha256"] == raw_text_archive.sha256_of(old_raw)
    assert st["last_error"] is None


def test_stamping_clears_a_previous_last_error(conn, raw_dir):
    conn.execute("INSERT INTO ch_text_clean_state (doc_id, spider, last_error) "
                 "VALUES ('z1','CH_ZG','archive conflict: old')")
    _put_zg_pdf(raw_dir, "CH_ZG", "z1")
    _seed_zg_row(conn, "z1")
    extract_stage.run(_pdf_settings(raw_dir, keep=True), spider="CH_ZG", limit=1)
    st = _state(conn, "z1")
    assert st["cleaned_at"] is not None and st["last_error"] is None
