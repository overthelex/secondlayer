import asyncio
import hashlib
import os
import pathlib

import psycopg
import pytest

from chpipe import db
from chpipe.config import Settings
from chpipe.http import FetchError
from chpipe.stages import fetch_stage


def test_raw_path_shards_by_spider():
    p = fetch_stage.raw_path(pathlib.Path("/data/raw"), "ZG_Obergericht", "d1", "pdf")
    assert p == pathlib.Path("/data/raw/ZG_Obergericht/d1.pdf")


def test_raw_path_refuses_a_doc_id_that_escapes_the_directory():
    """Document ids come from a remote listing; a ../ in one must not write
    outside raw_dir."""
    with pytest.raises(ValueError, match="unsafe"):
        fetch_stage.raw_path(pathlib.Path("/data/raw"), "S", "../../etc/passwd", "pdf")


def test_raw_path_refuses_a_spider_that_is_bare_dotdot():
    """Round 1 finding: _SAFE_NAME alone accepts a bare '..' -- it only
    rejects '/' and null bytes. spider is used bare (raw_dir / spider), so
    this must be caught by construction: resolve the path and confirm it is
    still inside raw_dir, not by pattern-guessing at the string."""
    with pytest.raises(ValueError, match="unsafe"):
        fetch_stage.raw_path(pathlib.Path("/data/raw"), "..", "d1", "pdf")


def test_raw_path_refuses_a_doc_id_that_is_bare_dotdot(tmp_path):
    """Round 1 finding: for doc_id specifically, appending '.{extension}'
    happens to mask a bare '..' from ever landing as a literal path segment
    in the filename this call produces -- but raw_path is a general, exported
    helper and must not depend on that accident to stay safe."""
    with pytest.raises(ValueError, match="unsafe"):
        fetch_stage.raw_path(tmp_path, "S", "..", "pdf")


def test_raw_path_accepts_a_legitimate_swiss_document_id(tmp_path):
    p = fetch_stage.raw_path(tmp_path, "CH_BGer",
                             "CH_BGer_001_1A-1-2000_2000-05-08", "html")
    assert p == tmp_path / "CH_BGer" / "CH_BGer_001_1A-1-2000_2000-05-08.html"


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
    async def body(self, url):
        return f"body:{url}".encode(), "text/html"


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


def test_a_failure_while_recording_a_failure_does_not_abort_the_batch(
        conn, monkeypatch, tmp_path):
    """Round 1 finding: db.fail() itself is unguarded in three places inside
    one() -- including the one that records a fetch failure. If Postgres
    hiccups at exactly that moment, the exception must still not escape
    asyncio.gather and cancel the sibling tasks in the batch."""
    _seed(conn, "GOOD", html_url="https://x/GOOD.html")
    _seed(conn, "BAD", html_url="https://x/BAD.html")

    class FetcherFailsOn:
        def __init__(self, bad_url):
            self._bad_url = bad_url

        async def body(self, url):
            if url == self._bad_url:
                raise FetchError("simulated fetch failure")
            return f"body:{url}".encode(), "text/html"

    real_fail = db.fail

    def flaky_fail(conn_, doc_id, error, max_attempts):
        if doc_id == "BAD":
            raise RuntimeError("simulated connection drop while recording failure")
        return real_fail(conn_, doc_id, error, max_attempts)

    monkeypatch.setattr(db, "fail", flaky_fail)

    settings = Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=4,
                         cpu_workers=1, ocr_workers=1, load_ceiling=6.0,
                         max_attempts=3)
    rows = db.claim(conn, "indexed", limit=10)
    report = fetch_stage.FetchReport()
    fetcher = FetcherFailsOn("https://x/BAD.html")

    # Must complete without raising.
    asyncio.run(fetch_stage._fetch_batch(fetcher, conn, rows, settings, report))

    good = conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE doc_id='GOOD'").fetchone()
    assert good[0] == "fetched"
    assert report.fetched_html == 1
    assert report.failed == 1


# --- The mojibake defect, closed at the point where the charset still exists ---

def test_an_html_body_is_transcoded_to_utf8_before_it_reaches_the_disk(
        conn, tmp_path):
    """http.py returned raw bytes and fetch_stage wrote them straight to
    disk, discarding the Content-Type charset -- the only authoritative
    statement of the body's encoding, and the one thing a resumed run
    cannot recover. The extractor then had to guess, and lxml's guess for
    an undeclared document is ISO-8859-1, which is exactly the corruption
    this pipeline exists to repair.

    The body below is real ISO-8859-1 with a real charset header. What
    lands on disk must be UTF-8, so that extract -- which sees the file and
    no response at all -- reads it correctly without knowing anything."""
    _seed(conn, "LATIN", html_url="https://x/LATIN.html")

    latin_body = ("<html><body><p>Beschwerdeführer, Eidgenössisches "
                  "Versicherungsgericht</p></body></html>").encode("iso-8859-1")

    class LatinFetcher:
        async def body(self, url):
            return latin_body, "text/html; charset=iso-8859-1"

    settings = Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=1,
                        cpu_workers=1, ocr_workers=1, load_ceiling=6.0,
                        max_attempts=3)
    rows = db.claim(conn, "indexed", limit=10)
    report = fetch_stage.FetchReport()
    asyncio.run(fetch_stage._fetch_batch(LatinFetcher(), conn, rows, settings, report))

    written = (tmp_path / "ZG_Obergericht" / "LATIN.html").read_bytes()
    assert written.decode("utf-8"), "the file on disk must be valid UTF-8"

    from chpipe import text_extract
    text = text_extract.from_html(written)
    assert "Beschwerdeführer" in text
    assert "Eidgenössisches" in text
    assert "Ã" not in text
    assert report.fetched_html == 1


def test_an_undeclared_utf8_body_survives_the_round_trip(conn, tmp_path):
    """Measured 2026-08-23: entscheidsuche answers document requests with a
    bare `Content-Type: text/html` and no charset parameter, so the header
    cannot be the only source. An undeclared body must still come back
    with its accents."""
    _seed(conn, "PLAIN", html_url="https://x/PLAIN.html")
    utf8_body = ("<html><body><p>Graubünden, Grundsätze, "
                 "Beschwerdeführer</p></body></html>").encode("utf-8")

    class PlainFetcher:
        async def body(self, url):
            return utf8_body, "text/html"

    settings = Settings(dsn="unused", raw_dir=tmp_path, http_concurrency=1,
                        cpu_workers=1, ocr_workers=1, load_ceiling=6.0,
                        max_attempts=3)
    rows = db.claim(conn, "indexed", limit=10)
    asyncio.run(fetch_stage._fetch_batch(PlainFetcher(), conn, rows,
                                         settings, fetch_stage.FetchReport()))

    from chpipe import text_extract
    text = text_extract.from_html(
        (tmp_path / "ZG_Obergericht" / "PLAIN.html").read_bytes())
    assert "Graubünden" in text and "Grundsätze" in text
    assert "Ã" not in text


def test_raw_path_accepts_a_doc_id_with_a_non_ascii_letter(tmp_path):
    """CH_EDOEB's ids carry the court's own umlaut: `CH_EDÖB_999_...`. The
    first prod run refused all 1,876 of them as "unsafe path component" --
    three attempts each, 5,628 ERROR lines, every one a real file the mirror
    served with a 200. A letter is a letter; the path guard is about
    separators, NULs and '..', not about the Latin-1 range."""
    p = fetch_stage.raw_path(tmp_path, "CH_EDOEB",
                             "CH_EDÖB_999_fedpol---Information_2023-12-21", "pdf")
    assert p == tmp_path / "CH_EDOEB" / "CH_EDÖB_999_fedpol---Information_2023-12-21.pdf"


@pytest.mark.parametrize("bad", ["a/b", "a\x00b", "a\nb", "abc\n", "..", "a\tb"])
def test_raw_path_still_refuses_separators_controls_and_dotdot(tmp_path, bad):
    with pytest.raises(ValueError):
        fetch_stage.raw_path(tmp_path, "CH_BGer", bad, "pdf")
