"""fedlex_pdf_ocr_stage against a mocked Fedlex host and a monkeypatched
tesseract, real Postgres.

Same harness as test_fedlex_pdf_text_stage.py (httpx.MockTransport for the
filestore, CHPIPE_TEST_DSN for the queue); ocr.ocr_pdf itself is
monkeypatched at the stage's import site -- these tests exercise the queue
walk, the claim filter and the retire/rescue writes, not tesseract. The text
a "successful" OCR returns is the REAL text layer of the decision_zg.pdf
fixture (via text_extract.from_pdf), so the quality gate is the real one,
scored on real German -- not a gate stubbed to pass.
"""
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import text_quality, text_extract
from chpipe.config import Settings
from chpipe.stages import fedlex_pdf_ocr_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
URL = ("https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/"
       "eli/cc/27/317_321_377/19950101/de/pdf-a/x.pdf")

FIXTURE_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"
GOOD_TEXT = text_extract.from_pdf(FIXTURE_PDF) if FIXTURE_PDF.exists() else ""

pytestmark = [
    pytestmark,
    pytest.mark.skipif(not GOOD_TEXT, reason="decision_zg.pdf fixture not captured"),
]


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
                  "VALUES (1, %s, 'CH', '220')", (WORK,))
        yield c


def _failed_row(conn, last_error="quality 0.15", lang="de", url=URL,
                source="fedlex_pdf", consolidation=None):
    """A row exactly as fedlex_pdf_text_stage's quality gate leaves it:
    retired to 'failed' with the budget spent and failed_stage recording
    where it died."""
    consolidation = consolidation or url
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, xml_url, source, stage, last_error, attempts, "
        "failed_stage) "
        "VALUES (1, %s, %s, '1995-01-01', %s, %s, 'failed', %s, 3, 'discovered') "
        "RETURNING version_id",
        (consolidation, lang, url, source, last_error)).fetchone()[0]


class Host:
    def __init__(self, body=b"%PDF-fake", status=200):
        self.calls = 0
        self.body = body
        self.status = status

    def __call__(self, request):
        self.calls += 1
        return httpx.Response(self.status, content=self.body)


def _run(settings, host, monkeypatch, ocr_text=None, ocr_exc=None, **kw):
    def fake_ocr(path, languages, tmp_root=None):
        if ocr_exc is not None:
            raise ocr_exc
        return ocr_text if ocr_text is not None else GOOD_TEXT
    monkeypatch.setattr(fedlex_pdf_ocr_stage.ocr, "ocr_pdf", fake_ocr)
    return fedlex_pdf_ocr_stage.run(
        settings, transport=httpx.MockTransport(host), **kw)


def test_a_readable_scan_is_rescued_to_parsed(conn, settings, monkeypatch):
    vid = _failed_row(conn)
    report = _run(settings, Host(), monkeypatch)
    assert report.claimed == 1 and report.recovered == 1 and report.still_bad == 0
    row = conn.execute(
        "SELECT stage, full_text, article_count, attempts, failed_stage, "
        "last_error, fetched_at FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert row[0] == "parsed"
    assert row[1] == GOOD_TEXT
    assert row[2] is None                  # no article split from OCR text
    assert row[3] == 0 and row[4] is None and row[5] is None
    assert row[6] is not None


def test_empty_text_layer_rows_are_claimed_too(conn, settings, monkeypatch):
    vid = _failed_row(conn, last_error="empty_text_layer")
    report = _run(settings, Host(), monkeypatch)
    assert report.recovered == 1
    assert conn.execute("SELECT stage FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0] == "parsed"


def test_an_unreadable_scan_is_retired_out_of_the_claim_filter(conn, settings,
                                                               monkeypatch):
    vid = _failed_row(conn)
    report = _run(settings, Host(), monkeypatch, ocr_text="zzz qqq")
    assert report.still_bad == 1 and report.recovered == 0
    stage, last_error = conn.execute(
        "SELECT stage, last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "failed"
    assert last_error.startswith("ocr quality ")
    # Retired means retired: a second run must find nothing to claim.
    second = _run(settings, Host(), monkeypatch, ocr_text="zzz qqq")
    assert second.claimed == 0


def test_a_fetch_error_leaves_the_row_untouched_for_the_next_run(conn, settings,
                                                                 monkeypatch):
    vid = _failed_row(conn)
    report = _run(settings, Host(status=503, body=b"busy"), monkeypatch)
    assert report.fetch_failed == 1 and report.claimed == 1
    assert report.recovered == 0 and report.still_bad == 0
    stage, last_error = conn.execute(
        "SELECT stage, last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "failed"
    assert last_error == "quality 0.15"    # unchanged -- still claimable
    # And the next run (fetch recovered) rescues it.
    second = _run(settings, Host(), monkeypatch)
    assert second.claimed == 1 and second.recovered == 1


def test_only_document_verdict_failures_are_claimed(conn, settings, monkeypatch):
    """Fetch errors, oversized PDFs, missing URLs, other sources, and rows
    that are not failed at all -- none of them are OCR's to touch."""
    _failed_row(conn, last_error="HTTP 404", consolidation="https://x/c1")
    _failed_row(conn, last_error="pdf_too_large", consolidation="https://x/c2")
    _failed_row(conn, last_error="no xml_url", consolidation="https://x/c3")
    _failed_row(conn, last_error="quality 0.15", source="lexwork_pdf",
                consolidation="https://x/c4")
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, xml_url, source, stage) "
        "VALUES (1, 'https://x/c5', 'de', '1995-01-01', %s, 'fedlex_pdf', "
        "'discovered')", (URL,))
    report = _run(settings, Host(), monkeypatch)
    assert report.claimed == 0


def test_an_unexpected_error_retires_the_row_with_the_reason(conn, settings,
                                                             monkeypatch):
    vid = _failed_row(conn)
    report = _run(settings, Host(), monkeypatch, ocr_exc=ValueError("boom"))
    assert report.still_bad == 1
    last_error = conn.execute(
        "SELECT last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0]
    assert last_error.startswith("ocr error: ValueError: boom")
    second = _run(settings, Host(), monkeypatch)
    assert second.claimed == 0


def test_a_missing_tesseract_escapes_instead_of_retiring_the_queue(conn, settings,
                                                                   monkeypatch):
    from chpipe import ocr as ocr_module
    _failed_row(conn)
    with pytest.raises(ocr_module.OcrToolMissing):
        _run(settings, Host(), monkeypatch,
             ocr_exc=ocr_module.OcrToolMissing("no tesseract"))
    # The row is untouched: a deployment problem must not spend its OCR shot.
    assert conn.execute(
        "SELECT last_error FROM ch_act_version WHERE stage='failed'"
    ).fetchone()[0] == "quality 0.15"


def test_limit_bounds_the_walk(conn, settings, monkeypatch):
    for i in range(3):
        _failed_row(conn, consolidation=f"https://x/lim{i}")
    report = _run(settings, Host(), monkeypatch, limit=2)
    assert report.claimed == 2
