"""materials_text_stage against a mocked Fedlex filestore, real Postgres.
Same pattern as test_fedlex_pdf_text_stage.py: decision_zg.pdf (a real
German text layer) stands in for a Botschaft, the minimal EMPTY_PDF for a
scan with no text layer."""
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import apply_migration_209

from chpipe import db, text_quality
from chpipe.config import Settings
from chpipe.stages import materials_text_stage as stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURE_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"
PDF_BYTES = FIXTURE_PDF.read_bytes() if FIXTURE_PDF.exists() else b""
EMPTY_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n"
    b"trailer<</Size 4/Root 1 0 R>>\n"
    b"startxref\n0\n%%EOF"
)
pytestmark = [pytestmark, pytest.mark.skipif(not PDF_BYTES, reason="decision_zg.pdf fixture not captured")]

ELI = "https://fedlex.data.admin.ch/eli/fga/2001/318"


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=2, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        apply_migration_209(c)
        yield c


def _row(conn, lang="de", url="https://fedlex.data.admin.ch/filestore/x.pdf", eli=ELI, pub="2001-04-17"):
    return conn.execute(
        "INSERT INTO ch_material (eli_work_uri, lang, material_type, type_uri, pdf_url, publication_date) "
        "VALUES (%s, %s, 'botschaft', 't', %s, %s) RETURNING material_id",
        (eli, lang, url, pub)).fetchone()[0]


class Host:
    def __init__(self, body=PDF_BYTES, status=200):
        self.calls = 0
        self.body = body
        self.status = status

    def __call__(self, request):
        self.calls += 1
        return httpx.Response(self.status, content=self.body)


def _run(settings, host, **kw):
    return stage.run(settings, transport=httpx.MockTransport(host), **kw)


def _state(conn, material_id):
    return conn.execute(
        "SELECT stage, attempts, last_error, length(full_text), text_quality, pdf_bytes, fetched_at IS NOT NULL "
        "  FROM ch_material WHERE material_id = %s", (material_id,)).fetchone()


def test_a_good_pdf_is_parsed_with_its_quality_recorded(settings, conn):
    mid = _row(conn)
    host = Host()
    report = _run(settings, host)
    assert (report.claimed, report.parsed, report.failed) == (1, 1, 0)
    assert report.bytes_downloaded == len(PDF_BYTES) and host.calls == 1
    stage_, attempts, err, n, quality, size, fetched = _state(conn, mid)
    assert stage_ == "parsed" and attempts == 0 and err is None and fetched
    assert n > 1000 and size == len(PDF_BYTES)
    assert quality >= text_quality.ACCEPT_THRESHOLD


def test_an_empty_text_layer_fails_and_retires_after_max_attempts(settings, conn):
    mid = _row(conn)
    report = _run(settings, Host(body=EMPTY_PDF))
    assert report.failed == 1 and report.empty == 1
    assert _state(conn, mid)[:3] == ("discovered", 1, "empty_text_layer")
    # the backoff (1 min after the first failure) keeps it out of an immediate re-run ...
    assert _run(settings, Host(body=EMPTY_PDF)).claimed == 0
    # ... and once the wait has passed it is claimable again, until the budget is spent
    conn.execute("UPDATE ch_material SET stage_updated_at = now() - interval '1 day' WHERE material_id = %s", (mid,))
    report = _run(settings, Host(body=EMPTY_PDF))
    assert report.failed == 1
    assert _state(conn, mid)[:2] == ("discovered", 2)
    conn.execute("UPDATE ch_material SET stage_updated_at = now() - interval '1 day' WHERE material_id = %s", (mid,))
    report = _run(settings, Host(body=EMPTY_PDF))
    assert report.failed == 1
    assert _state(conn, mid)[:2] == ("failed", 3)
    assert _run(settings, Host(body=EMPTY_PDF)).claimed == 0
    assert db.retry_failed_materials(conn) == 1
    # back in the queue with a fresh budget, the diagnosis kept for the operator
    assert _state(conn, mid)[:3] == ("discovered", 0, "empty_text_layer")


def test_a_row_that_failed_normally_is_reclaimed_when_its_backoff_has_passed(settings, conn):
    """The re-claim guard must not mistake a legitimate retry for a lost
    write-back: monkeypatched claim returns the same failed row twice in
    one run (as a long run past the 1-minute back-off would), and the stage
    processes it both times."""
    mid = _row(conn)
    real_claim = db.claim_materials
    served = []

    def claim_twice(conn_, limit, **kw):
        rows = real_claim(conn_, limit, backoff_minutes=None, **{k: v for k, v in kw.items() if k != "backoff_minutes"})
        out = rows if len(served) < 2 else []
        served.append(len(out))
        return out

    import chpipe.stages.materials_text_stage as mod
    orig = mod.db.claim_materials
    mod.db.claim_materials = claim_twice
    try:
        report = _run(settings, Host(status=404))
    finally:
        mod.db.claim_materials = orig
    assert served == [1, 1, 0] and report.claimed == 2 and report.failed == 2
    assert _state(conn, mid)[:2] == ("discovered", 2)


def test_a_fetch_error_is_a_failed_attempt_not_a_crash(settings, conn):
    mid = _row(conn)
    report = _run(settings, Host(status=404))
    assert report.failed == 1 and report.parsed == 0
    stage_, attempts, err, *_ = _state(conn, mid)
    assert stage_ == "discovered" and attempts == 1 and "404" in err


def test_limit_bounds_the_run_and_the_queue_is_ordered_by_publication(settings, conn):
    first = _row(conn, pub="1999-01-01")
    _row(conn, lang="fr", pub="2001-01-01")
    _row(conn, lang="it", pub="2003-01-01")
    report = _run(settings, Host(), limit=2)
    assert report.claimed == 2 and report.parsed == 2
    assert _state(conn, first)[0] == "parsed"
    assert conn.execute("SELECT count(*) FROM ch_material WHERE stage = 'discovered'").fetchone()[0] == 1


def test_complete_material_refuses_an_unknown_column(conn):
    mid = _row(conn)
    with pytest.raises(ValueError):
        db.complete_material(conn, mid, stage="parsed")
    with pytest.raises(db.QueueWriteMissed):
        db.complete_material(conn, mid + 1000, full_text="x")
