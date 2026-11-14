"""fedlex_pdf_text_stage against a mocked Fedlex host, real Postgres.

Same pattern as test_cantonal_fetch_stage.py: httpx.MockTransport stands in
for the pdf-a filestore, run() is exercised with `transport=` so no test
ever opens a real socket.
"""
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import db, text_quality
from chpipe.config import Settings
from chpipe.stages import fedlex_pdf_text_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
URL = ("https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/"
      "eli/cc/27/317_321_377/19950101/de/pdf-a/x.pdf")

# decision_zg.pdf is a real Zug court decision with a genuine German text
# layer -- the same fixture tests/test_text_extract.py uses to prove
# from_pdf()/text_quality.score() work end to end. It is reused here rather
# than a synthetic PDF because a synthetic one has no dictionary hit rate at
# all and cannot clear ACCEPT_THRESHOLD.
FIXTURE_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"
PDF_BYTES = FIXTURE_PDF.read_bytes() if FIXTURE_PDF.exists() else b""

# Minimal well-formed PDF with no text layer at all -- from_pdf() on this
# returns "", the empty_text_layer path, without needing a real scan.
EMPTY_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"xref\n0 4\n0000000000 65535 f \n"
    b"trailer<</Size 4/Root 1 0 R>>\n"
    b"startxref\n0\n%%EOF"
)

pytestmark = [
    pytestmark,
    pytest.mark.skipif(not PDF_BYTES, reason="decision_zg.pdf fixture not captured"),
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


def _row(conn, lang="de", url=URL, source="fedlex_pdf", consolidation=None):
    consolidation = consolidation or url
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, xml_url, source, stage) "
        "VALUES (1, %s, %s, '1995-01-01', %s, %s, 'discovered') "
        "RETURNING version_id",
        (consolidation, lang, url, source)).fetchone()[0]


class Host:
    def __init__(self, body=PDF_BYTES, status=200):
        self.calls = 0
        self.body = body
        self.status = status

    def __call__(self, request):
        self.calls += 1
        return httpx.Response(self.status, content=self.body)


def _run(settings, host, **kw):
    return fedlex_pdf_text_stage.run(settings, transport=httpx.MockTransport(host), **kw)


def test_a_discovered_pdf_row_is_parsed(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host())
    assert report.claimed == 1 and report.parsed == 1 and report.failed == 0
    stage, full_text, article_count, source, fetched_at = conn.execute(
        "SELECT stage, full_text, article_count, source, fetched_at "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "parsed"
    assert full_text and "Gericht" in full_text
    assert article_count is None
    assert source == "fedlex_pdf"
    assert fetched_at is not None
    assert text_quality.score(full_text, ["de"]) >= text_quality.ACCEPT_THRESHOLD


def test_bytes_downloaded_is_reported(conn, settings):
    _row(conn)
    report = _run(settings, Host())
    assert report.bytes_downloaded == len(PDF_BYTES)


def test_a_404_fails_the_row_until_max_attempts_then_retires_it(conn, settings):
    """max_attempts=1: the row's own attempt budget is exhausted, and
    stage='failed' the very first time fail_version() sees it -- the same
    shape fail_version() gives every other stage's last attempt (see
    db.fail_version's docstring). Using max_attempts=1 here rather than
    calling run() three times with the default backoff means this test does
    not depend on real wall-clock time to reach the retired state."""
    vid = _row(conn)
    host = Host(status=404, body=b"gone")
    one_shot = Settings(dsn=settings.dsn, raw_dir=settings.raw_dir,
                        http_concurrency=settings.http_concurrency,
                        cpu_workers=1, ocr_workers=1, load_ceiling=0.0,
                        max_attempts=1)

    report = _run(one_shot, host)

    assert report.failed == 1
    stage, attempts, failed_stage, last_error = conn.execute(
        "SELECT stage, attempts, failed_stage, last_error "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "failed"
    assert failed_stage == "discovered"
    assert "404" in last_error


def test_a_404_leaves_the_row_reclaimable_before_max_attempts(conn, settings):
    vid = _row(conn)
    host = Host(status=404, body=b"gone")
    report = _run(settings, host)
    assert report.failed == 1
    stage, attempts = conn.execute(
        "SELECT stage, attempts FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "discovered" and attempts == 1
    # Reclaimable: claim_versions with no backoff picks it straight back up.
    assert len(db.claim_versions(conn, "discovered", 10, backoff_minutes=(),
                                 source="fedlex_pdf")) == 1


def test_an_empty_text_layer_fails_with_its_own_reason(conn, settings):
    vid = _row(conn)
    report = _run(settings, Host(body=EMPTY_PDF))
    assert report.failed == 1 and report.empty == 1 and report.parsed == 0
    stage, last_error = conn.execute(
        "SELECT stage, last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "discovered" and last_error == "empty_text_layer"


def test_a_pdf_too_large_to_read_fails_without_being_parsed(conn, settings):
    vid = _row(conn)
    big = b"%PDF-1.4\n" + b"0" * (fedlex_pdf_text_stage.MAX_PDF_BYTES + 1)
    report = _run(settings, Host(body=big))
    assert report.failed == 1 and report.parsed == 0
    last_error = conn.execute(
        "SELECT last_error FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0]
    assert last_error == "pdf_too_large"


def test_only_fedlex_pdf_rows_are_claimed(conn, settings):
    """An xml-sourced row (source='fedlex') at stage='discovered' is a
    different queue entirely -- fetch_xml_stage's, not this one's -- and
    must never be touched by the claim filter."""
    _row(conn, source="fedlex", url="https://fedlex.data.admin.ch/x.xml",
         consolidation="fedlex/x")
    host = Host()
    report = _run(settings, host)
    assert host.calls == 0 and report.claimed == 0 and report.parsed == 0
    stage, xml_url = conn.execute(
        "SELECT stage, xml_url FROM ch_act_version").fetchone()
    assert stage == "discovered"
    assert xml_url == "https://fedlex.data.admin.ch/x.xml"


def test_limit_bounds_the_run(conn, settings):
    for i in range(3):
        _row(conn, consolidation=f"{URL}#{i}", url=URL)
    report = _run(settings, Host(), limit=2)
    assert report.claimed == 2 and report.parsed == 2


def test_limit_spans_batches_and_stops_exactly_at_the_cap(
        conn, settings, monkeypatch):
    # The nightly delta relies on the multi-batch path (cap 2000 >> BATCH_SIZE
    # is the production shape only in reverse): with BATCH_SIZE forced below
    # the cap, `remaining` must carry across claim rounds and stop the run at
    # exactly the cap, leaving the rest claimable.
    from chpipe.stages import fedlex_pdf_text_stage as mod
    monkeypatch.setattr(mod, "BATCH_SIZE", 2)
    for i in range(5):
        _row(conn, consolidation=f"{URL}#{i}", url=URL)
    report = _run(settings, Host(), limit=3)
    assert report.claimed == 3 and report.parsed == 3
    left = conn.execute(
        "SELECT count(*) FROM ch_act_version WHERE stage = 'discovered'"
    ).fetchone()[0]
    assert left == 2


def test_pdftoolmissing_aborts_the_run_loudly_instead_of_failing_the_row(
        conn, settings, monkeypatch):
    from chpipe.stages import fedlex_pdf_text_stage as mod
    from chpipe.text_extract import PdfToolMissing

    vid = _row(conn)

    def boom(path):
        raise PdfToolMissing("pdftotext not installed")

    monkeypatch.setattr(mod, "from_pdf", boom)
    with pytest.raises(PdfToolMissing):
        _run(settings, Host())

    # The row must not have been marked failed by this crash -- it is still
    # sitting at 'discovered' with zero attempts spent, exactly where a run
    # that never got a chance to judge it should leave it.
    stage, attempts = conn.execute(
        "SELECT stage, attempts FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "discovered" and attempts == 0


def test_a_low_quality_text_layer_fails_with_its_score_in_last_error(
        conn, settings, monkeypatch):
    """CQ-5: the quality-gate branch had no test of its own -- everything
    covering it went through the empty_text_layer path instead, which never
    reaches text_quality.score() at all. Ten repeats of one short token is
    non-empty (so it clears the `if not text` guard) but far too short to
    clear MIN_TOKENS, so text_quality.score() returns 0.0 regardless of
    ACCEPT_THRESHOLD's exact value -- the same shape monkeypatching from_pdf
    uses in the PdfToolMissing test above, applied to a text-quality outcome
    instead of a crash."""
    from chpipe.stages import fedlex_pdf_text_stage as mod

    vid = _row(conn)
    bad_text = "lorem " * 10
    quality = text_quality.score(bad_text, ["de"])
    assert quality < text_quality.ACCEPT_THRESHOLD

    monkeypatch.setattr(mod, "from_pdf", lambda path: bad_text)
    report = _run(settings, Host())

    assert report.failed == 1 and report.low_quality == 1 and report.parsed == 0
    stage, attempts, last_error, full_text = conn.execute(
        "SELECT stage, attempts, last_error, full_text "
        "FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert last_error == f"quality {quality:.2f}"
    assert full_text is None
    # Still claimable -- one failed attempt out of max_attempts=3, the same
    # "not yet retired" shape the 404 test asserts for a fetch failure.
    assert stage == "discovered" and attempts == 1
    assert len(db.claim_versions(conn, "discovered", 10, backoff_minutes=(),
                                 source="fedlex_pdf")) == 1


# --- CHPIPE_RESPLIT: articles from the stored full_text (phase B) ---

# The col0 pdf-a shape with a glued heading footnote ("Art. 12" = article 1
# + note 2) and a footnote block; see tests/test_fedlex_split.py for the
# splitter itself -- here only the walk, the write and the idempotency.
RESPLIT_TEXT = """\
101
Bundesgesetz
über etwas

vom 1. Januar 1950


Art. 12
Der Bund sorgt für die Sache.

Art. 2
Die Kantone vollziehen dieses Gesetz.

AS 1950 1
1   Fassung gemäss Ziff. I des BG vom 1. Jan. 1950 (AS 1950 1).
"""

STUB_TEXT = "412.1\nOrdinanza\nsulla formazione\n\nEntrata in vigore: 1° febbraio 2008\n"


def _parsed_pdf_row(conn, text, count=None, consolidation=None, lang="de"):
    vid = _row(conn, consolidation=consolidation or URL, lang=lang)
    conn.execute(
        "UPDATE ch_act_version SET stage='parsed', full_text=%s, article_count=%s "
        "WHERE version_id=%s", (text, count, vid))
    return vid


def test_resplit_gives_articles_and_moves_raw_to_akn_xml(conn, settings):
    vid = _parsed_pdf_row(conn, RESPLIT_TEXT)
    stub = _parsed_pdf_row(conn, STUB_TEXT, consolidation=URL + "#stub", lang="it")

    report = fedlex_pdf_text_stage.resplit(settings)

    assert (report.resplit, report.recovered, report.articles) == (2, 1, 2)
    assert report.empty == 1 and report.failed == 0
    full_text, count = conn.execute(
        "SELECT full_text, article_count FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert full_text != RESPLIT_TEXT and "Art. 2" in full_text   # clean text now
    assert conn.execute("SELECT akn_xml FROM ch_act_version WHERE version_id=%s",
                        (vid,)).fetchone()[0] == RESPLIT_TEXT   # raw kept
    assert report.cleaned == 2
    assert count == 2
    rows = conn.execute(
        "SELECT e_id, article_number, text FROM ch_act_article "
        "WHERE version_id=%s ORDER BY ordinal", (vid,)).fetchall()
    assert [(r[0], r[1]) for r in rows] == [("art_1", "1"), ("art_2", "2")]
    assert "sorgt für die Sache" in rows[0][2]
    assert "AS 1950 1" not in rows[0][2] and "AS 1950 1" not in rows[1][2]
    # the stub gained no articles (article_count still NULL) but is cleaned
    assert conn.execute("SELECT article_count FROM ch_act_version WHERE version_id=%s",
                        (stub,)).fetchone()[0] is None
    assert conn.execute("SELECT akn_xml FROM ch_act_version WHERE version_id=%s",
                        (stub,)).fetchone()[0] == STUB_TEXT

    # idempotent: the recovered row has left the selection, the stub (no
    # articles) is walked again and still yields nothing
    again = fedlex_pdf_text_stage.resplit(settings)
    assert (again.resplit, again.recovered, again.empty) == (1, 0, 1)


def test_resplit_walks_only_parsed_article_less_fedlex_pdf_rows(conn, settings):
    # already has articles -- not selected
    done = _parsed_pdf_row(conn, RESPLIT_TEXT, count=3, consolidation=URL + "#done")
    conn.execute("UPDATE ch_act_version SET akn_xml=full_text WHERE version_id=%s", (done,))
    # an AKN row of another source -- never selected
    akn_row = _row(conn, source="fedlex", url="https://fedlex.data.admin.ch/x.xml",
                   consolidation="fedlex/x")
    conn.execute("UPDATE ch_act_version SET stage='parsed', full_text='Art. 1  x', "
                 "article_count=0 WHERE version_id=%s", (akn_row,))
    # still queued -- not selected either
    _row(conn, consolidation=URL + "#queued")

    report = fedlex_pdf_text_stage.resplit(settings)

    assert report.resplit == 0 and report.recovered == 0
    assert conn.execute("SELECT article_count FROM ch_act_version WHERE version_id=%s",
                        (done,)).fetchone()[0] == 3


def test_resplit_honours_the_limit_across_batches(conn, settings, monkeypatch):
    from chpipe.stages import fedlex_pdf_text_stage as mod
    monkeypatch.setattr(mod, "RESPLIT_BATCH", 2)
    for i in range(5):
        _parsed_pdf_row(conn, RESPLIT_TEXT, consolidation=f"{URL}#r{i}")
    report = fedlex_pdf_text_stage.resplit(settings, limit=3)
    assert report.resplit == 3 and report.recovered == 3
    left = conn.execute(
        "SELECT count(*) FROM ch_act_version WHERE source='fedlex_pdf' "
        "AND stage='parsed' AND article_count IS NULL").fetchone()[0]
    assert left == 2


# --- Phase A: raw text in akn_xml, clean text in full_text ---

COL0 = RESPLIT_TEXT


def _insert_pdf_edition(conn, full_text, akn_xml, stage="parsed", lang="de"):
    vid = _parsed_pdf_row(conn, full_text, consolidation=f"{URL}#{abs(hash((full_text, akn_xml)))}",
                          lang=lang)
    conn.execute("UPDATE ch_act_version SET akn_xml=%s WHERE version_id=%s", (akn_xml, vid))
    return vid


def _vrow(conn, vid):
    cur = conn.execute("SELECT akn_xml, full_text, article_count FROM ch_act_version "
                       "WHERE version_id=%s", (vid,))
    a, f, n = cur.fetchone()
    return {"akn_xml": a, "full_text": f, "article_count": n}


def test_resplit_moves_raw_to_akn_xml_and_cleans_full_text(conn, settings):
    vid = _insert_pdf_edition(conn, full_text=COL0, akn_xml=None)
    fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _vrow(conn, vid)
    assert row["akn_xml"] == COL0
    # the publication line is furniture; the footnote is kept (2026-11 fix)
    assert "\nAS 1950 1\n" not in row["full_text"] and row["article_count"] == 2
    assert row["full_text"].endswith(
        "\n\n1 Fassung gemäss Ziff. I des BG vom 1. Jan. 1950 (AS 1950 1).")


def test_resplit_is_idempotent_reads_akn_xml(conn, settings):
    vid = _insert_pdf_edition(conn, full_text="already clean", akn_xml=COL0)
    fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _vrow(conn, vid)
    assert row["akn_xml"] == COL0 and "Art. 2" in row["full_text"] \
        and row["full_text"] != "already clean"


def test_resplit_articleless_edition_still_cleaned(conn, settings):
    vid = _insert_pdf_edition(conn, full_text="Titel\n8\nText ohne Artikel\n", akn_xml=None)
    report = fedlex_pdf_text_stage.resplit(settings, everything=True)
    row = _vrow(conn, vid)
    assert row["akn_xml"].startswith("Titel") and "\n8\n" not in row["full_text"]
    assert (row["article_count"] or 0) == 0 and report.cleaned == 1


def test_resplit_one_converts_rows_with_articles_but_no_akn_xml(conn, settings):
    vid = _insert_pdf_edition(conn, full_text=COL0, akn_xml=None)
    conn.execute("UPDATE ch_act_version SET article_count=2 WHERE version_id=%s", (vid,))
    fedlex_pdf_text_stage.resplit(settings)
    assert _vrow(conn, vid)["akn_xml"] == COL0


def test_resplit_writes_are_one_transaction(conn, settings, monkeypatch):
    vid = _insert_pdf_edition(conn, full_text=COL0, akn_xml=None)
    from chpipe.stages import fedlex_pdf_text_stage as mod
    # the store_articles write must roll back with a failing text write
    orig_store = mod.parse_akn_stage.store_articles
    def store_then_fail(c, v, arts):
        orig_store(c, v, arts)
        raise RuntimeError("crash")
    monkeypatch.setattr(mod.parse_akn_stage, "store_articles", store_then_fail)
    report = fedlex_pdf_text_stage.resplit(settings, everything=True)
    assert report.failed == 1
    row = _vrow(conn, vid)
    assert row["full_text"] == COL0 and row["akn_xml"] is None
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s",
                        (vid,)).fetchone()[0] == 0


def test_new_edition_stores_raw_in_akn_xml_and_clean_in_full_text(conn, settings, monkeypatch):
    from chpipe import fedlex_split
    from chpipe.stages import fedlex_pdf_text_stage as mod
    raw = "101\nBundesgesetz\n\nvom 1. Januar 1950\n\n\nArt. 12\nDer Bund sorgt.\n\nArt. 2\nDie Kantone vollziehen.\n\nAS 1950 1\n1   Fassung gemäss AS 1950 1.\n"
    monkeypatch.setattr(mod, "from_pdf", lambda path: raw)
    monkeypatch.setattr(text_quality, "score", lambda *a, **k: 1.0)
    vid = _row(conn)
    _run(settings, Host())
    arts, clean = fedlex_split.split_fedlex_text(raw, "de")
    row = _vrow(conn, vid)
    assert row["akn_xml"] == raw
    assert row["full_text"] == clean and row["full_text"] != row["akn_xml"]
    assert row["article_count"] == len(arts) == 2
    got = conn.execute("SELECT e_id FROM ch_act_article WHERE version_id=%s ORDER BY ordinal",
                       (vid,)).fetchall()
    assert [g[0] for g in got] == [a.e_id for a in arts]


def test_new_edition_write_is_one_transaction(conn, settings, monkeypatch):
    from chpipe.stages import fedlex_pdf_text_stage as mod
    monkeypatch.setattr(mod, "from_pdf", lambda path: RESPLIT_TEXT)
    monkeypatch.setattr(text_quality, "score", lambda *a, **k: 1.0)
    orig = mod.parse_akn_stage.store_articles
    def store_then_fail(c, v, arts):
        orig(c, v, arts)
        raise RuntimeError("crash")
    monkeypatch.setattr(mod.parse_akn_stage, "store_articles", store_then_fail)
    vid = _row(conn)
    report = _run(settings, Host())
    assert report.failed == 1
    row = _vrow(conn, vid)
    assert row["full_text"] is None and row["akn_xml"] is None
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s",
                        (vid,)).fetchone()[0] == 0


def test_resplit_skips_degenerate_clean_text(conn, settings, monkeypatch):
    from chpipe import fedlex_split
    from chpipe.stages import fedlex_pdf_text_stage as mod
    monkeypatch.setattr(fedlex_split, "split_fedlex_text", lambda raw, lang=None: ([], ""))
    vid = _insert_pdf_edition(conn, full_text=COL0, akn_xml=None)
    report = mod.resplit(settings, everything=True)
    assert report.degenerate == 1 and report.cleaned == 0
    row = _vrow(conn, vid)
    assert row["full_text"] == COL0 and row["akn_xml"] is None


def test_new_edition_degenerate_clean_text_stores_raw(conn, settings, monkeypatch):
    from chpipe import fedlex_split
    from chpipe.stages import fedlex_pdf_text_stage as mod
    raw = "Titel\nText ohne Artikel\n" * 10
    monkeypatch.setattr(mod, "from_pdf", lambda path: raw)
    monkeypatch.setattr(text_quality, "score", lambda *a, **k: 1.0)
    monkeypatch.setattr(fedlex_split, "split_fedlex_text", lambda r, lang=None: ([], "x"))
    vid = _row(conn)
    report = _run(settings, Host())
    assert report.degenerate == 1 and report.parsed == 1 and report.cleaned == 0
    row = _vrow(conn, vid)
    assert row["akn_xml"] == raw and row["full_text"] == raw
