"""sil_parse_stage on the real (trimmed) GE and NE pages, real Postgres."""
import datetime
import json
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import sil
from chpipe.config import Settings
from chpipe.stages import sil_parse_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
GE_PAGE = sil.decode((FIXTURES / "sil_ge_rsg_i2_09.htm").read_bytes())
NE_PAGE = sil.decode((FIXTURES / "sil_ne_916_510_1.htm").read_bytes())
GE_URL = "https://silgeneve.ch/legis/program/books/rsg/htm/rsg_i2_09.htm"
NE_URL = "https://rsn.ne.ch/DATA/program/books/rsne/htm/916.510.1.htm"


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number, metadata_json) VALUES "
                  "(1, %s, 'GE', 'I 2 09', %s), (2, %s, 'NE', '916.510.1', %s)",
                  (GE_URL, json.dumps({"sil_date_source": "lexfind"}),
                   NE_URL, json.dumps({"sil_date_source": "run"})))
        yield c


def _fetched(conn, act_id=1, url=GE_URL, page=GE_PAGE, date="2026-02-27"):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source, stage, akn_xml) VALUES (%s, %s, 'fr', %s, %s, 'sil', 'fetched', %s) "
        "RETURNING version_id", (act_id, f"sil:{act_id}/{url}/{date}", date, url, page)).fetchone()[0]


def test_parses_both_pages_into_articles_and_text(conn, settings):
    ge = _fetched(conn)
    ne = _fetched(conn, act_id=2, url=NE_URL, page=NE_PAGE, date="2026-08-26")
    report = sil_parse_stage.run(settings)
    assert report.parsed == 2 and report.failed == 0 and report.articles == 17 + 17
    assert report.acts == {(1, "fr"), (2, "fr")}
    for vid, count, needle in ((ge, 17, "Autorisation préalable"), (ne, 17, "déchets animaux")):
        stage, text, n = conn.execute(
            "SELECT stage, full_text, article_count FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
        assert stage == "parsed" and n == count and needle in text
    rows = conn.execute("SELECT e_id, article_number, marginal_note, ordinal, notes FROM ch_act_article "
                        "WHERE version_id=%s ORDER BY ordinal", (ge,)).fetchall()
    assert rows[3][:4] == ("art_4", "4", "Autorisation préalable", 3)
    assert rows[3][4] == ["n.t. : rectification selon 7C/1, B 2 05 (4/1) | 27.02.2026 | 27.02.2026"]
    ne_rows = conn.execute("SELECT article_number, text, notes FROM ch_act_article WHERE version_id=%s "
                           "AND article_number IN ('13', '8') ORDER BY ordinal", (ne,)).fetchall()
    assert ne_rows[0][0] == "8" and ne_rows[0][1].startswith("1 Les communes")
    assert ne_rows[1] == ("13", "", ["Abrogé par A du 14 juin 2006 (FO 2006 N° 45) avec effet rétroactif au 1er janvier 2006"])


def test_a_run_dated_version_takes_the_date_printed_on_the_page(conn, settings):
    ne = _fetched(conn, act_id=2, url=NE_URL, page=NE_PAGE, date="2026-08-26")
    ge = _fetched(conn)
    report = sil_parse_stage.run(settings)
    assert report.dates_from_page == 1
    assert conn.execute("SELECT date_applicability FROM ch_act_version WHERE version_id=%s",
                        (ne,)).fetchone()[0] == datetime.date(2013, 8, 1), "NE 'Etat au 1er août 2013'"
    assert conn.execute("SELECT metadata_json ->> 'sil_date_source' FROM ch_act WHERE act_id=2"
                        ).fetchone()[0] == "page"
    assert conn.execute("SELECT date_applicability FROM ch_act_version WHERE version_id=%s",
                        (ge,)).fetchone()[0] == datetime.date(2026, 2, 27), "a lexfind date is not touched"


def test_short_pages_retire_and_prose_pages_parse_with_zero_articles(conn, settings):
    """The F3/K9 audit (2026-08-31): 27 in-force GE/NE acts are published as
    prose without an Art. heading. Such a page keeps its text (parsed,
    article_count 0, the PDF path's rule); only a near-empty page retires."""
    short = _fetched(conn, page="<html><head><title>x</title></head><body><p>Texte en vigueur</p></body></html>",
                     date="2020-01-01")
    prose = _fetched(conn, page="<html><head><title>x</title></head><body>"
                     + "".join(f"<p class=Texte>Paragraphe {i} sans article, du texte suivi.</p>" for i in range(20))
                     + "</body></html>", date="2020-01-02")
    report = sil_parse_stage.run(settings)
    assert report.failed == 1 and report.short_text == 1 and report.no_articles == 1 and report.parsed == 1
    stage_of = dict(conn.execute("SELECT version_id, stage FROM ch_act_version").fetchall())
    assert stage_of[short] == "failed" and stage_of[prose] == "parsed"
    text, count = conn.execute("SELECT full_text, article_count FROM ch_act_version "
                               "WHERE version_id=%s", (prose,)).fetchone()
    assert "sans article" in text and count == 0


def test_reparse_replaces_articles(conn, settings):
    vid = _fetched(conn)
    sil_parse_stage.run(settings)
    conn.execute("UPDATE ch_act_version SET stage='fetched' WHERE version_id=%s", (vid,))
    sil_parse_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)).fetchone()[0] == 17


def test_only_sil_rows_are_claimed(conn, settings):
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "source, stage, akn_xml) VALUES (1, 'lw/x', 'fr', '2020-01-01', 'lexwork', 'fetched', '{}')")
    report = sil_parse_stage.run(settings)
    assert report.parsed == 0 and report.failed == 0


def test_parse_writes_amendment_provenance_and_change_documents(conn, settings):
    _fetched(conn)
    _fetched(conn, act_id=2, url=NE_URL, page=NE_PAGE, date="2026-08-26")
    report = sil_parse_stage.run(settings)
    assert report.parsed == 2
    # GE (I 2 09): 7 notes -> 7 events; 5 distinct adoption dates = 5 documents.
    ge_docs = dict(conn.execute(
        "SELECT number, date_decision FROM ch_act_change_document "
        "WHERE act_id=1 AND jurisdiction='GE'").fetchall())
    assert len(ge_docs) == 5
    assert ge_docs["03.05.2024"] == datetime.date(2024, 5, 3)
    ge_rows = conn.execute(
        "SELECT p.e_id, p.action, p.as_reference, p.effective_date, p.change_document_id "
        "FROM ch_article_provenance p JOIN ch_act_version v USING (version_id) "
        "WHERE v.act_id=1 ORDER BY p.provenance_id").fetchall()
    assert len(ge_rows) == 7 and all(r[4] is not None for r in ge_rows)
    art13 = [r for r in ge_rows if r[0] == "art_13"]
    assert [r[1] for r in art13][:1] == ["repealed"]
    # NE (916.510.1): 13 events over 12 notes, 5 FO issues.
    ne_docs = [n for (n,) in conn.execute(
        "SELECT number FROM ch_act_change_document WHERE act_id=2 ORDER BY number").fetchall()]
    assert ne_docs == ["FO 1996 N° 32", "FO 2001 N° 16", "FO 2006 N° 45",
                      "FO 2007 N° 30", "FO 2013 N° 31"]
    ne_rows = conn.execute(
        "SELECT p.e_id, p.action, p.as_reference, p.raw_note, p.change_document_id "
        "FROM ch_article_provenance p JOIN ch_act_version v USING (version_id) "
        "WHERE v.act_id=2 ORDER BY p.provenance_id").fetchall()
    assert len(ne_rows) == 13 and all(r[4] is not None for r in ne_rows)
    art8 = [r for r in ne_rows if r[0] == "art_8"]
    assert art8 and art8[0][1] == "amended" and art8[0][3].startswith("Teneur selon")
    assert report.provenance_rows == 7 + 13 and report.change_documents == 5 + 5
    assert report.provenance_linked == 20


def test_reprovenance_rebuilds_from_stored_pages_without_refetching(conn, settings):
    _fetched(conn)
    _fetched(conn, act_id=2, url=NE_URL, page=NE_PAGE, date="2026-08-26")
    sil_parse_stage.run(settings)
    conn.execute("DELETE FROM ch_article_provenance")
    conn.execute("DELETE FROM ch_act_change_document")
    report = sil_parse_stage.run_reprovenance(settings)
    assert report.parsed == 2 and report.failed == 0
    assert report.provenance_rows == 20 and report.change_documents == 10
    # one canton only, via the same CHPIPE_CANTON prefix the fetch stage uses
    conn.execute("DELETE FROM ch_article_provenance")
    conn.execute("DELETE FROM ch_act_change_document")
    ge_only = sil_parse_stage.run_reprovenance(settings, canton_code="GE")
    assert ge_only.parsed == 1 and ge_only.provenance_rows == 7
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 5
    # articles, text and dates are untouched by the rebuild
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == 34


def test_gate_f_amendment_counters_are_non_zero_for_ge_and_ne(conn, settings):
    """Deliverable K3-SIL/TI: the two SIL cantons had ZERO change documents
    and zero provenance; after one parse Gate F must say otherwise."""
    from chpipe import reports_cantonal
    _fetched(conn)
    _fetched(conn, act_id=2, url=NE_URL, page=NE_PAGE, date="2026-08-26")
    sil_parse_stage.run(settings)
    for canton, docs, rows in (("GE", 5, 7), ("NE", 5, 13)):
        row = reports_cantonal.gate_f(conn, canton)[0]
        assert row["change_documents"] == docs, canton
        assert row["provenance_rows"] == rows and row["provenance_linked"] == rows, canton
        assert row["change_documents_unlinked"] == 0, canton
