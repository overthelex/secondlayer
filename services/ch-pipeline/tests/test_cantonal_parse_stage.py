"""cantonal_parse_stage on the real (trimmed) BE constitution payload,
real Postgres."""
import datetime
import json
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import cantonal_parse_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "lexwork_be_101_1_v3020.json"
PAYLOAD = FIXTURE.read_text()


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        c.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                  "VALUES (1, 'https://www.belex.sites.be.ch/app/de/texts_of_law/101.1', 'BE', '101.1')")
        # Two of the change documents the fixture's history map points at
        # (2001 and 2089), and one it does not (9999).
        for source_id, number in ((2001, "02-33"), (2089, "06-1"), (9999, "99-9")):
            c.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number) "
                      "VALUES (1, 'BE', %s, %s)", (source_id, number))
        yield c


def _fetched(conn, lang="de", payload=PAYLOAD, version_id=None):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source, stage, akn_xml) VALUES (1, %s, %s, '2024-03-03', 'https://x', "
        "'lexwork', 'fetched', %s) RETURNING version_id",
        (f"be/101.1/3020/{lang}/{version_id or ''}", lang, payload)).fetchone()[0]


def test_parses_articles_full_text_and_provenance(conn, settings):
    vid = _fetched(conn)
    report = cantonal_parse_stage.run(settings)
    assert report.parsed == 1 and report.failed == 0 and report.articles == 8
    assert report.acts == {(1, "de")}
    stage, text, count = conn.execute(
        "SELECT stage, full_text, article_count FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "parsed" and count == 8
    assert "Der Kanton Bern ist ein freiheitlicher" in text
    articles = conn.execute(
        "SELECT e_id, article_number, marginal_note, ordinal, parent_e_id FROM ch_act_article "
        "WHERE version_id=%s ORDER BY ordinal", (vid,)).fetchall()
    assert articles[5] == ("t-0--t-1--a-6", "6", "Sprachen", 5, "t-0--t-1")
    prov = conn.execute(
        "SELECT count(*), count(change_document_id), "
        "count(*) FILTER (WHERE anchor_level='container'), "
        "count(*) FILTER (WHERE anchor_level='article') "
        "FROM ch_article_provenance WHERE version_id=%s", (vid,)).fetchone()
    assert prov[0] == 83 == report.provenance_rows
    assert prov[1] == report.provenance_linked
    assert 0 < prov[1] < 47, "only the change documents that exist in the table are linked"
    assert prov[3] > 0, "Art. 1 to 8 rows anchor to the edition's own articles"
    linked_numbers = {r[0] for r in conn.execute(
        "SELECT d.number FROM ch_article_provenance p JOIN ch_act_change_document d "
        "USING (change_document_id) WHERE p.version_id=%s", (vid,)).fetchall()}
    assert linked_numbers <= {"02-33", "06-1"}


def test_a_language_missing_from_the_payload_fails_visibly(conn, settings):
    vid = _fetched(conn, lang="it")
    report = cantonal_parse_stage.run(settings)
    assert report.failed == 1 and report.lang_not_in_payload == 1 and report.parsed == 0
    stage, error, attempts = conn.execute(
        "SELECT stage, last_error, attempts FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "fetched" and attempts == 1 and "not in payload" in error


def test_both_languages_of_one_payload_parse_independently(conn, settings):
    de = _fetched(conn, "de")
    fr = _fetched(conn, "fr")
    report = cantonal_parse_stage.run(settings)
    assert report.parsed == 2 and report.acts == {(1, "de"), (1, "fr")}
    marginal = {lang: conn.execute(
        "SELECT marginal_note FROM ch_act_article WHERE version_id=%s AND article_number='6'",
        (vid,)).fetchone()[0] for lang, vid in (("de", de), ("fr", fr))}
    assert marginal == {"de": "Sprachen", "fr": "Langues"}


def test_reparse_replaces_articles_and_provenance(conn, settings):
    vid = _fetched(conn)
    cantonal_parse_stage.run(settings)
    conn.execute("UPDATE ch_act_version SET stage='fetched' WHERE version_id=%s", (vid,))
    cantonal_parse_stage.run(settings)
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)).fetchone()[0] == 8
    assert conn.execute("SELECT count(*) FROM ch_article_provenance WHERE version_id=%s",
                        (vid,)).fetchone()[0] == 83


def test_a_broken_payload_fails_the_row_and_leaves_no_rows(conn, settings):
    vid = _fetched(conn, payload='{"text_of_law": {"selected_version": {"available_languages": []}}}')
    report = cantonal_parse_stage.run(settings)
    assert report.failed == 1
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)).fetchone()[0] == 0


def test_a_broken_provenance_write_rolls_back_the_articles(conn, settings, monkeypatch):
    vid = _fetched(conn)
    monkeypatch.setattr(cantonal_parse_stage, "_INSERT_PROVENANCE", "INSERT INTO nowhere VALUES (1)")
    report = cantonal_parse_stage.run(settings)
    assert report.failed == 1
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s", (vid,)).fetchone()[0] == 0
    assert conn.execute("SELECT stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()[0] == "fetched"


def test_fedlex_rows_are_not_claimed(conn, settings):
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "source, stage, akn_xml) VALUES (1, 'fedlex/x', 'de', '2024-03-03', 'fedlex', 'fetched', "
                 "'<akomaNtoso/>')")
    report = cantonal_parse_stage.run(settings)
    assert report.parsed == 0 and report.failed == 0


def _bl_payload(conn):
    """The BE fixture re-hosted as a BL act: the history map emptied, the
    modification table replaced by three real BL rows (prod raw_note
    strings, 2026-08-26), and the act's documents numbered the way
    bl.clex.ch numbers them."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                 "VALUES (2, 'https://bl.clex.ch/app/de/texts_of_law/100', 'BL', '100')")
    for source_id, number, pub in ((501, "2017.026", "2017-05-30"), (502, "2018.040", "2018-06-12"),
                                   (503, "2018.041", "2018-06-12")):
        conn.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number, "
                     "date_publication) VALUES (2, 'BL', %s, %s, %s)", (source_id, number, pub))
    payload = json.loads(PAYLOAD)
    sv = payload["text_of_law"]["selected_version"]
    sv["history_information_map"] = {}
    sv["json_content"]["modification_table"] = [{"html_content": {"de": (
        "<table><tr><th>Beschluss</th><th>Inkraft seit</th><th>Element</th><th>Wirkung</th>"
        "<th>Publiziert mit</th></tr>"
        "<tr><td>21.03.2017</td><td>01.07.2017</td><td>Art. 2</td><td>geändert</td><td>GS 2017.026</td></tr>"
        "<tr><td>05.06.2018</td><td>01.01.2019</td><td>Art. 3</td><td>eingefügt</td><td>GS 2018.040</td></tr>"
        "<tr><td>18.05.2000</td><td>01.01.2001</td><td>Art. 4</td><td>geändert</td><td>GS 33.1335</td></tr>"
        "</table>")}}]
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "xml_url, source, stage, akn_xml) VALUES (2, 'bl/100/1/de', 'de', '2019-01-01', "
        "'https://bl.clex.ch/api/de/texts_of_law/100/versions/1/show_as_json', 'lexwork', "
        "'fetched', %s) RETURNING version_id", (json.dumps(payload),)).fetchone()[0]


def test_an_empty_history_map_links_through_the_reference_and_fills_date_decision(conn, settings):
    vid = _bl_payload(conn)
    report = cantonal_parse_stage.run(settings, canton_code="BL")
    assert report.parsed == 1 and report.provenance_rows == 3
    assert report.provenance_linked == 2 == report.provenance_matched
    linked = conn.execute(
        "SELECT p.raw_note, d.number FROM ch_article_provenance p "
        "LEFT JOIN ch_act_change_document d USING (change_document_id) "
        "WHERE p.version_id=%s ORDER BY p.provenance_id", (vid,)).fetchall()
    assert [n for _, n in linked] == ["2017.026", "2018.040", None]
    # the two documents got the decision date of the row that cites them;
    # the third (never cited) stays NULL
    dates = dict(conn.execute(
        "SELECT number, date_decision FROM ch_act_change_document WHERE act_id=2").fetchall())
    assert dates == {"2017.026": datetime.date(2017, 3, 21), "2018.040": datetime.date(2018, 6, 5),
                     "2018.041": None}
    assert report.decision_dates_filled == 2

EMPTY_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "lexwork_empty_bs_unstructured.json"


def test_an_edition_without_provisions_is_parsed_with_zero_articles(conn, settings):
    """BS 251.700 (a Regierungsratsbeschluss whose whole text sits in the
    header/footer, no article node): parsed, article_count 0, the text kept
    as full_text, the reason counted -- and a requeue re-parses it to the
    same state, which is what the LEXAI-2019 runbook relies on."""
    vid = _fetched(conn, payload=EMPTY_FIXTURE.read_text())
    report = cantonal_parse_stage.run(settings)
    assert report.parsed == 1 and report.failed == 0 and report.articles == 0
    assert report.empty == 1
    assert report.empty_by_reason == {"unstructured_text": 1}
    stage, text, count = conn.execute(
        "SELECT stage, full_text, article_count FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()
    assert stage == "parsed" and count == 0
    assert "Antragsberechtigte Behörden und Stellen" in text
    assert conn.execute("SELECT count(*) FROM ch_act_article WHERE version_id=%s",
                        (vid,)).fetchone()[0] == 0
    conn.execute("UPDATE ch_act_version SET stage='fetched', attempts=0 WHERE version_id=%s", (vid,))
    again = cantonal_parse_stage.run(settings)
    assert again.parsed == 1 and again.empty_by_reason == {"unstructured_text": 1}
    assert conn.execute(
        "SELECT stage, full_text, article_count FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone() == (stage, text, count)
