import asyncio
import datetime
import json
import os
import pathlib
import psycopg
import pytest
from chpipe import es_document
from chpipe.stages import index_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/test_index_stage.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"
FIX = pathlib.Path(__file__).parent / "fixtures"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set"
)


@pytest.fixture
def conn():
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


def _fields():
    data = json.loads((FIX / "doc_zg_og_001.json").read_text())
    return es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", data)


def test_inserts_a_new_document_at_stage_indexed(conn):
    assert index_stage.upsert(conn, _fields(), {"json", "pdf"}) == "inserted"
    row = conn.execute(
        "SELECT doc_id, stage, decision_date, canton FROM ch_court_decisions"
    ).fetchone()
    assert row[0] == "ZG_OG_001_Z1-2020-5_2022-02-18"
    assert row[1] == "indexed"
    assert row[2] == datetime.date(2022, 2, 18)
    assert row[3] == "ZG"


def test_fills_the_date_on_a_row_that_predates_the_pipeline(conn):
    """The 678,165 legacy rows are keyed by ecli and have no doc_id and no date."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, stage) VALUES (%s,%s,'indexed')",
        (f.ecli, f.spider),
    )
    assert index_stage.upsert(conn, f, {"json", "pdf"}) == "updated"
    row = conn.execute(
        "SELECT count(*), max(decision_date), max(doc_id) FROM ch_court_decisions"
    ).fetchone()
    assert row[0] == 1, "must update the legacy row, not create a duplicate"
    assert row[1] == datetime.date(2022, 2, 18)
    assert row[2] == "ZG_OG_001_Z1-2020-5_2022-02-18"


def test_never_overwrites_text_that_is_already_there(conn):
    """CH_BGer already has 165,363 good texts; re-indexing must not blank them."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text, stage) "
        "VALUES (%s,%s,%s,'loaded')", (f.ecli, f.spider, "existing text " * 50),
    )
    index_stage.upsert(conn, f, {"json", "pdf"})
    row = conn.execute(
        "SELECT full_text, stage FROM ch_court_decisions").fetchone()
    assert row[0].startswith("existing text")
    assert row[1] == "loaded", "a finished row must not be sent back through the queue"


def test_records_which_formats_are_available(conn):
    index_stage.upsert(conn, _fields(), {"json", "html"})
    row = conn.execute(
        "SELECT html_url, pdf_url FROM ch_court_decisions").fetchone()
    assert row[0].endswith("/ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.html")


def test_a_document_with_neither_html_nor_pdf_is_marked_failed(conn):
    f = _fields()
    index_stage.upsert(conn, f, {"json"})
    row = conn.execute("SELECT stage, last_error FROM ch_court_decisions").fetchone()
    assert row[0] == "failed"
    assert "no body" in row[1]


def test_upsert_is_idempotent(conn):
    index_stage.upsert(conn, _fields(), {"json", "pdf"})
    index_stage.upsert(conn, _fields(), {"json", "pdf"})
    assert conn.execute("SELECT count(*) FROM ch_court_decisions").fetchone()[0] == 1


def test_a_loaded_row_reindexed_with_no_body_keeps_stage_and_clears_no_error(conn):
    """Finding 1a: a finished row must not be stamped with a failure message
    that describes a stage it never actually entered."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, full_text, stage) "
        "VALUES (%s,%s,%s,'loaded')", (f.ecli, f.spider, "existing text " * 50),
    )
    assert index_stage.upsert(conn, f, set()) == "updated"
    row = conn.execute(
        "SELECT stage, last_error FROM ch_court_decisions").fetchone()
    assert row[0] == "loaded"
    assert row[1] is None


def test_a_failed_row_recovering_a_body_clears_its_stale_error(conn):
    """Finding 1b: a row coming back from 'failed' must not keep carrying the
    error message that put it there."""
    f = _fields()
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, stage, last_error) "
        "VALUES (%s,%s,'failed','no body: listing offers neither html nor pdf')",
        (f.ecli, f.spider),
    )
    assert index_stage.upsert(conn, f, {"json", "pdf"}) == "updated"
    row = conn.execute(
        "SELECT stage, last_error FROM ch_court_decisions").fetchone()
    assert row[0] == "indexed"
    assert row[1] is None


def test_html_url_survives_a_reindex_where_the_listing_transiently_drops_html(conn):
    """Finding 2: html_url is the one optional column that was not protected
    by COALESCE — a transient listing gap must not null out a working URL."""
    f = _fields()
    index_stage.upsert(conn, f, {"json", "html"})
    before = conn.execute(
        "SELECT html_url FROM ch_court_decisions").fetchone()[0]
    assert before.endswith("/ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.html")

    index_stage.upsert(conn, f, {"json", "pdf"})
    row = conn.execute(
        "SELECT html_url, pdf_url FROM ch_court_decisions").fetchone()
    assert row[0] == before, "html_url must not be nulled by a body-bearing re-index"
    assert row[1].endswith("/ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.pdf")


def test_one_bad_document_does_not_abort_the_rest_of_the_batch(conn, monkeypatch):
    """Finding 3: a raise from parse() or upsert() for one document must not
    cancel the sibling tasks in the same asyncio.gather slice."""
    listing_html = (
        '<a href="ZG_OG_001_Z1-2020-5_2022-02-18.json">a</a>'
        '<a href="ZG_OG_001_Z1-2020-5_2022-02-18.pdf">a</a>'
        '<a href="BAD_DOC.json">b</a>'
        '<a href="BAD_DOC.pdf">b</a>'
    )
    good_data = json.loads((FIX / "doc_zg_og_001.json").read_text())

    class FakeFetcher:
        async def text(self, url):
            return listing_html

        async def json(self, url):
            return good_data

    real_upsert = index_stage.upsert

    def flaky_upsert(conn, fields, available):
        if fields.doc_id == "BAD_DOC":
            raise RuntimeError("simulated write failure")
        return real_upsert(conn, fields, available)

    monkeypatch.setattr(index_stage, "upsert", flaky_upsert)

    report = index_stage.IndexReport()
    asyncio.run(
        index_stage._index_spider(FakeFetcher(), conn, "ZG_Obergericht", report))

    doc_ids = {
        row[0] for row in
        conn.execute("SELECT doc_id FROM ch_court_decisions").fetchall()
    }
    assert "ZG_OG_001_Z1-2020-5_2022-02-18" in doc_ids, \
        "the good document in the same slice must still be written"
    assert "BAD_DOC" not in doc_ids
    assert report.failed == 1
