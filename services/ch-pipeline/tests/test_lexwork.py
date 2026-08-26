"""chpipe.lexwork against a real (trimmed) BE constitution payload:
tests/fixtures/lexwork_be_101_1_v3020.json is show_as_json of version 3020
(in force 03.03.2024 to 31.12.2025) cut to the first title's first eight
articles, with the whole modification table and history map kept."""
import datetime
import json
import pathlib

import pytest

from chpipe import lexwork

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "lexwork_be_101_1_v3020.json"


@pytest.fixture
def payload():
    return json.loads(FIXTURE.read_text())


# --- version date strings -------------------------------------------------

def test_current_version_dates():
    d = lexwork.parse_version_dates(
        "Aktuelle Version in Kraft seit: 01.01.2026 (Beschlussdatum: 27.11.2023)")
    assert d == lexwork.VersionDates(datetime.date(2026, 1, 1), None,
                                     datetime.date(2023, 11, 27))


def test_old_version_dates_end_is_the_inclusive_last_day():
    d = lexwork.parse_version_dates(
        "Version in Kraft von: 03.03.2024 bis: 31.12.2025 (Beschlussdatum: 03.03.2024)")
    assert d.date_applicability == datetime.date(2024, 3, 3)
    assert d.date_end_applicability == datetime.date(2025, 12, 31)
    assert d.date_decision == datetime.date(2024, 3, 3)


def test_future_version_dates():
    d = lexwork.parse_version_dates(
        "Zukünftige Version in Kraft ab: 01.01.2027 (Beschlussdatum: 12.05.2026)")
    assert d.date_applicability == datetime.date(2027, 1, 1)
    assert d.date_end_applicability is None


def test_a_version_string_without_a_decision_date_still_parses():
    d = lexwork.parse_version_dates("Version in Kraft von: 01.01.2000 bis: 31.12.2000")
    assert d.date_decision is None


def test_unrecognised_date_string_raises_rather_than_defaulting():
    with pytest.raises(lexwork.LexworkParseError):
        lexwork.parse_version_dates("Version en vigueur du 03.03.2024")
    with pytest.raises(lexwork.LexworkParseError):
        lexwork.parse_version_dates("")


# --- the document tree ----------------------------------------------------

def test_available_languages(payload):
    assert lexwork.available_languages(payload) == ["de", "fr"]


def test_articles_carry_uid_number_marginal_and_paragraph_text(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    art6 = next(a for a in articles if a.article_number == "6")
    assert art6.e_id == "t-0--t-1--a-6"
    assert art6.marginal_note == "Sprachen"
    assert art6.parent_e_id == "t-0--t-1"
    assert art6.text.startswith("1 ")
    assert "2 Die Amtssprachen sind a das Französische in der Verwaltungsregion Berner Jura," in art6.text
    assert "*" not in art6.text


def test_french_articles_come_from_the_same_payload(payload):
    articles, _ = lexwork.parse_edition(payload, "fr")
    art6 = next(a for a in articles if a.article_number == "6")
    assert art6.marginal_note == "Langues"
    assert "Les langues officielles sont" in art6.text


def test_ordinals_follow_document_order(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    assert [a.ordinal for a in articles] == list(range(len(articles)))
    assert [a.article_number for a in articles[:3]] == ["1", "2", "3"]
    assert len(articles) == 8


def test_plain_text_has_one_block_per_line_with_preamble_and_footer(payload):
    _, text = lexwork.parse_edition(payload, "de")
    lines = text.split("\n")
    assert "In der Absicht, Freiheit und Recht zu schützen" in text
    assert "1 Allgemeine Grundsätze" in lines
    assert "Art. 1 Der Kanton Bern" in lines
    assert "1 Der Kanton Bern ist ein freiheitlicher, demokratischer und sozialer Rechtsstaat." in lines
    assert lines[0] == "101.1"
    assert "Verfassung des Kantons Bern" in lines[:3]
    assert "Bern, 10. November 1992" in lines
    assert "" not in lines
    assert "*" not in text


def test_a_missing_language_raises(payload):
    with pytest.raises(lexwork.LexworkParseError, match="not in payload"):
        lexwork.parse_edition(payload, "it")


def test_a_payload_without_a_document_raises(payload):
    with pytest.raises(lexwork.LexworkParseError):
        lexwork.parse_edition({"text_of_law": {"selected_version": {
            "available_languages": payload["text_of_law"]["selected_version"]["available_languages"]}}}, "de")


# --- HTML fragments -------------------------------------------------------

def test_strip_html_removes_amendment_markers_and_entities():
    assert lexwork.strip_html(
        "<p><span class='text_content'>Die Amtssprachen sind&nbsp;<strong>*</strong></span></p>") \
        == "Die Amtssprachen sind"
    assert lexwork.strip_html("<b>nic</b>ht") == "nicht"
    assert lexwork.strip_html("  ") == ""
    assert lexwork.strip_html(None) == ""


def test_a_real_bold_word_survives_the_marker_strip():
    assert lexwork.strip_html("<p><strong>wichtig</strong> ist</p>") == "wichtig ist"


def test_article_number_of():
    assert lexwork.article_number_of("Art.&nbsp;6") == "6"
    assert lexwork.article_number_of("Art. 12a") == "12a"
    assert lexwork.article_number_of("§ 7") == "7"
    assert lexwork.article_number_of("") is None
    assert lexwork.article_number_of(None) is None


# --- provenance -----------------------------------------------------------

def test_provenance_rows_anchor_to_the_root_when_the_article_is_absent(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    rows = lexwork.provenance(payload, "de", articles)
    assert len(rows) == 83, "the first modification table has 83 rows; the second is a re-sort"
    first = next(r for r in rows if r.raw_note.startswith("06.06.1993"))
    assert first.anchor_level == "container" and first.container_articles == 8
    assert first.action is None
    assert first.as_reference == "94-1"
    assert first.effective_date == datetime.date(1995, 1, 1)
    assert first.source_act_date == datetime.date(1993, 6, 6)
    art61 = next(r for r in rows if "Art. 61 Abs. 2" in r.raw_note)
    assert art61.action == "amended"
    assert art61.source_act_date == datetime.date(2002, 9, 22)
    assert art61.effective_date == datetime.date(2006, 6, 1)
    assert art61.as_reference == "04-9"
    assert art61.anchor_level == "container", "Art. 61 is outside the trimmed fixture"
    assert art61.e_id == "t-0"
    art101a = next(r for r in rows if "Art. 101a" in r.raw_note)
    assert art101a.action == "inserted"


def test_provenance_links_rows_to_change_documents_through_the_history_map(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    rows = lexwork.provenance(payload, "de", articles)
    linked = [r for r in rows if r.change_document_source_id is not None]
    assert len(linked) == 47, "history_information_map has 47 entries"
    assert {r.change_document_source_id for r in linked} >= {2224, 2001, 2089}


def test_provenance_anchors_to_the_article_when_the_edition_has_it(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    sv = payload["text_of_law"]["selected_version"]
    sv["json_content"]["modification_table"] = [{
        "uid": "mt-0", "type": "date",
        "html_content": {"de": (
            "<table><tr><th>Beschluss</th><th>Inkrafttreten</th><th>Element</th>"
            "<th>Änderung</th><th>BAG-Fundstelle</th></tr>"
            "<tr class='history_info_1'><td>01.01.2000</td><td>01.02.2000</td>"
            "<td>Art. 6 Abs. 2</td><td>geändert</td><td class='ags_source_publication'>00-1</td></tr>"
            "<tr class='history_info_2'><td>01.01.2001</td><td>01.02.2001</td>"
            "<td>Art. 7</td><td>aufgehoben</td><td></td></tr></table>")}}]
    sv["history_information_map"] = {"1": {"change_document_id": 77, "materials_count": 0}}
    rows = lexwork.provenance(payload, "de", articles)
    assert rows[0].e_id == "t-0--t-1--a-6" and rows[0].anchor_level == "article"
    assert rows[0].container_articles is None
    assert rows[0].change_document_source_id == 77
    assert rows[1].action == "repealed" and rows[1].as_reference is None
    assert rows[1].change_document_source_id is None


def test_provenance_reads_the_by_article_column_order_too(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    sv = payload["text_of_law"]["selected_version"]
    sv["json_content"]["modification_table"] = [{
        "uid": "mt-1", "type": "article",
        "html_content": {"de": (
            "<table><tr><th>Element</th><th>Beschluss</th><th>Inkrafttreten</th>"
            "<th>Änderung</th><th>BAG-Fundstelle</th></tr>"
            "<tr class='history_info_1'><td>Art. 2</td><td>01.01.2000</td><td>01.02.2000</td>"
            "<td>eingefügt</td><td>00-1</td></tr></table>")}}]
    rows = lexwork.provenance(payload, "de", articles)
    assert rows[0].e_id == "t-0--t-1--a-2"
    assert rows[0].source_act_date == datetime.date(2000, 1, 1)
    assert rows[0].effective_date == datetime.date(2000, 2, 1)
    assert rows[0].action == "inserted"


def test_a_french_table_uses_french_verbs(payload):
    articles, _ = lexwork.parse_edition(payload, "fr")
    sv = payload["text_of_law"]["selected_version"]
    sv["json_content"]["modification_table"] = [{
        "uid": "mt-0", "type": "date",
        "html_content": {"fr": (
            "<table><tr><th>Décision</th><th>Entrée en vigueur</th><th>Elément</th>"
            "<th>Modification</th><th>Référence ROB</th></tr>"
            "<tr class='history_info_1'><td>01.01.2000</td><td>01.02.2000</td>"
            "<td>Art. 3 al. 1</td><td>modifié</td><td>00-1</td></tr></table>")}}]
    rows = lexwork.provenance(payload, "fr", articles)
    assert rows[0].action == "amended" and rows[0].e_id == "t-0--t-1--a-3"


def test_no_modification_table_means_no_rows(payload):
    articles, _ = lexwork.parse_edition(payload, "de")
    payload["text_of_law"]["selected_version"]["json_content"]["modification_table"] = []
    assert lexwork.provenance(payload, "de", articles) == []
