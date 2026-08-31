"""pdf_text_stage against a mocked host, real Postgres, real pdftotext."""
import asyncio
import os
import pathlib
import shutil

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import pdf_text_stage

pytestmark = [
    pytest.mark.skipif(not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"),
    pytest.mark.skipif(shutil.which("pdftotext") is None, reason="pdftotext not installed"),
]

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
BS_PDF = (FIXTURES / "lexwork_bs_117_440_v3152.pdf").read_bytes()
LU_PDF = (FIXTURES / "lexwork_lu_185_v2285.pdf").read_bytes()
HOST_URL = "https://www.gesetzessammlung.bs.ch/api/de/versions/3152/pdf_file"
LEXFIND_URL = "https://www.lexfind.ch/tolv/12345/de"


def tiny_pdf(lines: list[str]) -> bytes:
    """A one-page PDF with a text layer, written by hand so the test needs
    no PDF library: pdftotext reads it as `lines`, one per line."""
    content = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(
        f"({l}) Tj T*" for l in lines) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = "%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n"
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=4, cpu_workers=2, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, pdf_rps=50.0)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) VALUES "
                  "(1, 'https://www.gesetzessammlung.bs.ch/app/de/texts_of_law/117.440', 'BS', '117.440')")
        yield c


def _row(conn, url=HOST_URL, source="lexwork_pdf", lang="de", start="2021-01-01", end=None,
         consolidation=None):
    consolidation = consolidation or f"{url}#{lang}"
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "date_end_applicability, xml_url, source) VALUES (1, %s, %s, %s, %s, %s, %s) RETURNING version_id",
        (consolidation, lang, start, end, url, source)).fetchone()[0]


class Host:
    def __init__(self, bodies: dict[str, bytes] | None = None, status=200, content_type="application/pdf"):
        self.calls: list[str] = []
        self.bodies = bodies or {}
        self.status = status
        self.content_type = content_type

    def __call__(self, request):
        self.calls.append(str(request.url))
        body = self.bodies.get(str(request.url), BS_PDF)
        return httpx.Response(self.status, content=body, headers={"content-type": self.content_type})


def _run(settings, host, **kw):
    return pdf_text_stage.run(settings, transport=httpx.MockTransport(host), **kw)


def _state(conn, vid):
    return conn.execute("SELECT stage, last_error, article_count, length(full_text), "
                        "length(akn_xml), fetched_at FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()


def test_a_host_pdf_becomes_articles_text_and_raw_text(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host())
    assert report.parsed == 1 and report.failed == 0 and report.articles == 8
    stage, error, count, text_len, raw_len, fetched_at = _state(conn, vid)
    assert stage == "parsed" and error is None and count == 8 and fetched_at is not None
    assert text_len > 3000 and raw_len > text_len            # akn_xml = the raw pdftotext output
    numbers = [r[0] for r in conn.execute(
        "SELECT article_number FROM ch_act_article WHERE version_id=%s ORDER BY ordinal", (vid,))]
    assert numbers == [str(n) for n in range(1, 9)]
    assert pdf_text_stage.pdf_path(settings, vid).read_bytes() == BS_PDF


def test_lexfind_rows_are_served_by_the_same_walk(conn, settings):
    a = _row(conn)
    b = _row(conn, url=LEXFIND_URL, source="lexfind")
    host = Host({LEXFIND_URL: LU_PDF})
    report = _run(settings, host)
    assert report.parsed == 2
    assert _state(conn, a)[2] == 8 and _state(conn, b)[2] == 7
    assert sorted(host.calls) == sorted([HOST_URL, LEXFIND_URL])


def test_lexwork_and_fedlex_rows_are_never_claimed(conn, settings):
    _row(conn, url="https://www.gesetzessammlung.bs.ch/api/de/texts_of_law/117.440/versions/3152/show_as_json",
         source="lexwork")
    _row(conn, url="https://fedlex.data.admin.ch/x.xml", source="fedlex")
    host = Host()
    report = _run(settings, host)
    assert report.parsed == 0 and host.calls == []


def test_source_can_be_narrowed(conn, settings):
    _row(conn)
    b = _row(conn, url=LEXFIND_URL, source="lexfind")
    report = _run(settings, Host({LEXFIND_URL: LU_PDF}), sources=("lexfind",))
    assert report.parsed == 1 and _state(conn, b)[0] == "parsed"
    assert pdf_text_stage.sources_from_env("lexfind") == ("lexfind",)
    assert pdf_text_stage.sources_from_env("") == ("lexwork_pdf", "lexfind")
    assert pdf_text_stage.sources_from_env("zhlex") == ("zhlex",)
    assert pdf_text_stage.claim_prefix(("zhlex",), None) == pdf_text_stage.ZHLEX_PDF_PREFIX
    assert pdf_text_stage.claim_prefix(("lexfind",), None) is None
    with pytest.raises(ValueError):
        pdf_text_stage.sources_from_env("zhlex,lexfind")
    with pytest.raises(ValueError):
        pdf_text_stage.sources_from_env("lexwork")


def test_an_html_body_fails_the_row_with_the_reason(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host({HOST_URL: b"<html>login</html>"}, content_type="text/html"))
    assert report.not_pdf == 1 and report.failed == 1 and report.parsed == 0
    stage, error = _state(conn, vid)[:2]
    assert stage == "discovered" and error.startswith("not a PDF (text/html")
    assert not pdf_text_stage.pdf_path(settings, vid).exists()


def test_a_404_fails_the_row(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(status=404))
    assert report.failed == 1 and "404" in _state(conn, vid)[1]


def test_too_little_text_retires_the_row_at_once(conn, settings):
    vid = _row(conn)
    pdf = tiny_pdf(["Standeswappen", "Kanton Solothurn: geteilt von Rot und Silber."])
    report = _run(settings, Host({HOST_URL: pdf}))
    assert report.too_short == 1 and report.failed == 1
    stage, error = _state(conn, vid)[:2]
    assert stage == "failed" and error.startswith("text too short (")


def test_an_article_less_act_with_real_text_is_parsed_and_counted_empty(conn, settings):
    vid = _row(conn)
    lines = ["Beitritt des Kantons zur Interkantonalen Vereinbarung"] + [
        f"Der Grosse Rat beschliesst den Beitritt nach Massgabe von Ziffer {i}." for i in range(1, 8)]
    report = _run(settings, Host({HOST_URL: tiny_pdf(lines)}))
    assert report.parsed == 1 and report.empty == 1 and report.failed == 0
    stage, _, count, text_len, _, _ = _state(conn, vid)
    assert stage == "parsed" and count == 0 and text_len > 200


def test_shadow_editions_are_retired_not_downloaded(conn, settings):
    real = _row(conn, url=LEXFIND_URL, source="lexfind", start="2020-01-01", end=None)
    shadow = _row(conn, url=LEXFIND_URL.replace("12345", "12346"), source="lexfind",
                  start="2020-01-01", end="2019-12-31")
    closed = _row(conn, url=LEXFIND_URL.replace("12345", "12347"), source="lexfind",
                  start="2018-01-01", end="2019-12-31")
    host = Host({LEXFIND_URL: LU_PDF, LEXFIND_URL.replace("12345", "12347"): LU_PDF})
    report = _run(settings, host)
    assert report.shadows_retired == 1 and report.parsed == 2
    assert _state(conn, shadow)[:2] == ("failed", "shadow_edition")
    assert _state(conn, real)[0] == "parsed" and _state(conn, closed)[0] == "parsed"
    assert LEXFIND_URL.replace("12345", "12346") not in host.calls


def test_one_canton_at_a_time_and_limit(conn, settings):
    _row(conn)
    _row(conn, url="https://bgs.zg.ch/api/de/versions/5/pdf_file")
    report = _run(settings, Host(), canton_code="ZG")
    assert report.parsed == 1
    assert conn.execute("SELECT xml_url FROM ch_act_version WHERE stage='parsed'").fetchone()[0] \
        .startswith("https://bgs.zg.ch/")
    for i in range(3):
        _row(conn, url=f"https://bgs.zg.ch/api/de/versions/{10 + i}/pdf_file")
    assert _run(settings, Host(), limit=2).parsed == 2


def test_host_pacer_spaces_request_starts():
    pacer = pdf_text_stage.HostPacer(per_host=2, rps=20.0)
    starts: list[float] = []

    async def one():
        async with pacer.slot("h"):
            starts.append(asyncio.get_running_loop().time())

    async def main():
        await asyncio.gather(*(one() for _ in range(5)))

    asyncio.run(main())
    starts.sort()
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    assert min(gaps) >= 0.045                      # 1/20 s, minus timer slack
    with pytest.raises(ValueError):
        pdf_text_stage.HostPacer(per_host=0, rps=2.0)


def test_resplit_rewrites_article_less_rows_from_the_stored_text(conn, settings):
    zg = (FIXTURES / "pdftext_zg_centered_par.txt").read_text()
    plain = "Kantonsratsbeschluss\n\nbeschliesst:\n\n1. Der Kanton tritt bei.\n2. Der Regierungsrat vollzieht.\n"
    a = _row(conn)
    b = _row(conn, url=LEXFIND_URL, source="lexfind")
    c = _row(conn, url="https://bgs.zg.ch/api/de/versions/7/pdf_file")
    untouched = _row(conn, url="https://bgs.zg.ch/api/de/versions/8/pdf_file")
    for vid, raw, count in ((a, zg, 0), (b, plain, 0), (c, zg, 0), (untouched, zg, 4)):
        conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s, article_count=%s, "
                     "full_text='old' WHERE version_id=%s", (raw, count, vid))
    report = pdf_text_stage.resplit(settings)
    assert (report.resplit, report.recovered, report.articles) == (3, 2, 4)
    assert _state(conn, a)[2] == 2 and _state(conn, c)[2] == 2
    assert _state(conn, b)[2] == 0 and _state(conn, b)[3] == 3          # still 'old'
    assert _state(conn, untouched)[2] == 4
    assert conn.execute("SELECT full_text FROM ch_act_version WHERE version_id=%s",
                        (a,)).fetchone()[0].startswith("Kantonsratsbeschluss betreffend den Beitritt")
    numbers = [r[0] for r in conn.execute(
        "SELECT article_number FROM ch_act_article WHERE version_id=%s ORDER BY ordinal", (a,))]
    assert numbers == ["1", "2"]
    # narrowed to one canton, nothing left to recover there
    assert pdf_text_stage.resplit(settings, canton_code="ZG").recovered == 0


# --- BS annex editions ("siehe Anhang": the act's body is a PDF annex) ---

ANNEX_PAYLOAD = (FIXTURES / "lexwork_bs_annex_834_420_v2939.json").read_text()
ANNEX_PDF = (FIXTURES / "lexwork_bs_annex_834_420_v2939.pdf").read_bytes()
ANNEX_URL = "https://www.gesetzessammlung.bs.ch/api/de/versions/2939/annexes"
SHOW_URL = "https://www.gesetzessammlung.bs.ch/api/de/texts_of_law/834.420/versions/2939/show_as_json"
HEADER_TEXT = "Pflegeheimliste: RRB\nFür den Text des RRB und die Liste siehe Anhang."


def _annex_row(conn, payload=ANNEX_PAYLOAD, full_text=HEADER_TEXT, url=SHOW_URL, count=0):
    vid = _row(conn, url=url, source="lexwork")
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s, article_count=%s, "
                 "full_text=%s WHERE version_id=%s", (payload, count, full_text, vid))
    return vid


def _annex(settings, host, **kw):
    return pdf_text_stage.annex_text(settings, transport=httpx.MockTransport(host), **kw)


def test_the_annex_pdf_text_is_appended_after_the_header_text(conn, settings):
    vid = _annex_row(conn)
    host = Host({ANNEX_URL: ANNEX_PDF})
    report = _annex(settings, host)
    assert (report.annex_scanned, report.annex_no_articles, report.annex_parsed,
            report.annex_failed) == (1, 1, 0, 0)
    assert host.calls == [ANNEX_URL]
    text = conn.execute("SELECT full_text FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0]
    assert text.startswith(HEADER_TEXT)                       # the header text is kept
    assert pdf_text_stage.ANNEX_MARKER in text
    assert "Liste der Pflegeheime für den Kanton Basel-Stadt 2014" in text
    assert _state(conn, vid)[0] == "parsed" and _state(conn, vid)[2] == 0
    # audit copy of the PDF, distinct from the lexwork_pdf path's name
    assert pdf_text_stage.annex_pdf_path(settings, vid).read_bytes() == ANNEX_PDF
    # idempotent: the marker keeps the row out of the next run
    rerun = _annex(settings, Host({ANNEX_URL: ANNEX_PDF}))
    assert rerun.annex_scanned == 0
    assert conn.execute("SELECT full_text FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0] == text


def test_an_annex_that_splits_into_articles_stores_them(conn, settings):
    vid = _annex_row(conn)
    pdf = tiny_pdf(["Verordnung im Anhang", "",
                    "Art. 1  Zweck", "Diese Verordnung regelt die Aufsicht ueber die",
                    "Pflegeheime im Kanton und die Voraussetzungen der Aufnahme",
                    "in die kantonale Liste nach dem Bundesgesetz.",
                    "", "Art. 2  Geltung", "Sie gilt fuer alle Gemeinden des Kantons",
                    "sowie fuer die anerkannten privaten Traegerschaften."])
    report = _annex(settings, Host({ANNEX_URL: pdf}))
    assert (report.annex_parsed, report.annex_no_articles, report.articles) == (1, 0, 2)
    assert _state(conn, vid)[2] == 2
    numbers = [r[0] for r in conn.execute(
        "SELECT article_number FROM ch_act_article WHERE version_id=%s ORDER BY ordinal", (vid,))]
    assert numbers == ["1", "2"]
    text = conn.execute("SELECT full_text FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0]
    assert text.startswith(HEADER_TEXT) and "Zweck" in text
    # article_count > 0 keeps the row out of the next run
    assert _annex(settings, Host({ANNEX_URL: pdf})).annex_scanned == 0


def test_article_less_rows_without_annexes_are_skipped_not_fetched(conn, settings):
    payload = (FIXTURES / "lexwork_empty_bs_unstructured.json").read_text()
    _annex_row(conn, payload=payload, url=SHOW_URL.replace("834.420", "153.700"))
    host = Host({})
    report = _annex(settings, host)
    assert report.annex_scanned == 1 and report.annex_skipped == 1 and host.calls == []


def test_a_failed_annex_download_leaves_the_row_untouched(conn, settings):
    vid = _annex_row(conn)
    report = _annex(settings, Host({}, status=404))
    assert report.annex_failed == 1 and report.annex_no_articles == 0
    text = conn.execute("SELECT full_text FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0]
    assert text == HEADER_TEXT                                # no marker: still selectable
    assert _annex(settings, Host({ANNEX_URL: ANNEX_PDF})).annex_no_articles == 1
