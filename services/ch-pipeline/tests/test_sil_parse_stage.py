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


def test_short_pages_and_pages_without_articles_are_retired_with_a_reason(conn, settings):
    short = _fetched(conn, page="<html><head><title>x</title></head><body><p>Texte en vigueur</p></body></html>",
                     date="2020-01-01")
    prose = _fetched(conn, page="<html><head><title>x</title></head><body>"
                     + "".join(f"<p class=Texte>Paragraphe {i} sans article, du texte suivi.</p>" for i in range(20))
                     + "</body></html>", date="2020-01-02")
    report = sil_parse_stage.run(settings)
    assert report.failed == 2 and report.short_text == 1 and report.no_articles == 1 and report.parsed == 0
    reasons = dict(conn.execute("SELECT version_id, last_error FROM ch_act_version").fetchall())
    assert reasons[short].startswith("short_text: ") and reasons[prose].startswith("no_articles: ")
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='failed' AND failed_stage='fetched'"
                        ).fetchone()[0] == 2


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
