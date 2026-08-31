"""zh_fetch_stage and zh_parse_stage on the trimmed 131.1/004 Domino page,
real Postgres."""
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import zhlex
from chpipe.config import Settings
from chpipe.stages import zh_fetch_stage, zh_parse_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

PAYLOAD = (pathlib.Path(__file__).parent / "fixtures" / "zhlex_webrt_131_1_004.html").read_bytes()
HTML_URL = zhlex.WEBRT_PREFIX + "C1256C610039641BC12564AB00288B10"
PDF_URL = zhlex.PDF_PREFIX + "?Open&docid=X&file=131.1_004.pdf"


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=2, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, retry_backoff_minutes=(), cantonal_per_host=2)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                  "VALUES (1, 'http://www.zhlex.zh.ch/Erlass.html?Open&Ordnr=131.1', 'ZH', '131.1')")
        yield c


def _row(conn, uri, url, source="zhlex", stage="discovered", payload=None):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source, stage, akn_xml) VALUES (1, %s, 'de', '1926-06-22', %s, %s, %s, %s) "
        "RETURNING version_id", (uri, url, source, stage, payload)).fetchone()[0]


class Site:
    def __init__(self, body=PAYLOAD, status=200):
        self.calls = 0
        self.body, self.status = body, status

    def __call__(self, request):
        self.calls += 1
        return httpx.Response(self.status, content=self.body,
                              headers={"content-type": "text/html; charset=ISO-8859-1"})


def _fetch(settings, site, **kw):
    return zh_fetch_stage.run(settings, transport=httpx.MockTransport(site), rate=0, **kw)


def test_fetch_stores_the_decoded_page_and_skips_pdf_and_lexwork_rows(conn, settings):
    html_id = _row(conn, "zhlex:131.1/004", HTML_URL)
    _row(conn, "zhlex:131.1/095", PDF_URL)
    _row(conn, "https://bl.clex.ch/app/de/texts_of_law/1/versions/1", "https://bl.clex.ch/api/x", source="lexwork")
    site = Site()
    report = _fetch(settings, site)
    assert site.calls == 1 and report.fetched == 1 and report.failed == 0
    stage, stored, fetched_at = conn.execute(
        "SELECT stage, akn_xml, fetched_at FROM ch_act_version WHERE version_id=%s", (html_id,)).fetchone()
    assert stage == "fetched" and fetched_at is not None
    assert "§ 1. Die Gemeinden werden eingeteilt" in stored and "Zürich" in stored, "decoded from ISO-8859-1"
    assert zh_fetch_stage.payload_path(settings, html_id).read_text(encoding="utf-8") == stored
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='discovered'").fetchone()[0] == 2


def test_a_page_without_provisions_is_retired_at_once(conn, settings):
    vid = _row(conn, "zhlex:131.1/004", HTML_URL)
    report = _fetch(settings, Site(body=b"<html><body><p>Kein Dokument</p></body></html>"))
    assert report.no_provisions == 1 and report.fetched == 0
    stage, error, attempts = conn.execute(
        "SELECT stage, last_error, attempts FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "failed" and error.startswith("no_provisions") and attempts == 1


def test_a_server_error_is_a_retryable_attempt(conn, settings):
    """With the real backoff schedule the row is not re-claimed in the same
    run; it keeps its stage and one spent attempt."""
    vid = _row(conn, "zhlex:131.1/004", HTML_URL)
    settings = Settings(**{**settings.__dict__, "retry_backoff_minutes": (1, 5, 30)})
    report = _fetch(settings, Site(status=503))
    assert report.failed == 1
    assert conn.execute("SELECT stage, attempts FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone() == ("discovered", 1)


def test_parse_writes_articles_and_full_text_for_fetched_html_rows_only(conn, settings):
    text = PAYLOAD.decode("iso-8859-1")
    vid = _row(conn, "zhlex:131.1/004", HTML_URL, stage="fetched", payload=text)
    _row(conn, "zhlex:131.1/095", PDF_URL, stage="fetched", payload="%PDF-1.4")
    report = zh_parse_stage.run(settings)
    assert report.parsed == 1 and report.failed == 0 and report.articles == 4
    assert report.acts == {(1, "de")}
    stage, full, count = conn.execute(
        "SELECT stage, full_text, article_count FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "parsed" and count == 4 and full.startswith("Gesetz\nüber das Gemeindewesen")
    rows = conn.execute("SELECT e_id, article_number, ordinal, marginal_note, notes FROM ch_act_article "
                        "WHERE version_id=%s ORDER BY ordinal", (vid,)).fetchall()
    assert [r[0] for r in rows] == ["par_1", "par_2", "par_3", "par_4"]
    assert rows[1][3] == "B. Veränderungen in der Gemeindeeinteilung I. Grenzveränderungen"
    assert any("FN1 OS 33, 339" in n for n in rows[3][4])
    assert conn.execute("SELECT stage FROM ch_act_version WHERE xml_url=%s", (PDF_URL,)).fetchone() == ("fetched",)
