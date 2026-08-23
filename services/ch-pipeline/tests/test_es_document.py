import datetime
import json
import pathlib
import pytest
from chpipe import es_document

FIX = pathlib.Path(__file__).parent / "fixtures"
ZG = json.loads((FIX / "doc_zg_og_001.json").read_text())


def test_reads_the_date_from_the_top_level_not_from_meta():
    """The regression this whole pipeline exists to fix: Datum is top level.

    The previous importer read Meta.Datum, which does not exist, and produced
    678,165 rows with a NULL decision_date.
    """
    f = es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", ZG)
    assert f.decision_date == datetime.date(2022, 2, 18)


def test_meta_being_a_list_of_localised_strings_does_not_break_parsing():
    assert isinstance(ZG["Meta"], list)
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.decision_date is not None


def test_docket_number_comes_from_num():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.docket_number == "Z1 2020 5"


def test_canton_is_the_spider_prefix():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.canton == "ZG"


def test_federal_spiders_report_ch_as_the_canton():
    f = es_document.parse("CH_BGer", "d", {"Datum": "2020-01-01"})
    assert f.canton == "CH"


def test_pdf_path_is_the_mirror_path_not_the_court_url():
    """PDF.Datei is the file on entscheidsuche; PDF.URL points back at the court's
    own server, which rate-limits and rots. We always fetch the mirror."""
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.pdf_path == "ZG_Obergericht/ZG_OG_001_Z1-2020-5_2022-02-18.pdf"
    assert f.source_pdf_url.startswith("https://alt.entscheidsuche.ch/")


def test_languages_come_from_the_kopfzeile_entries():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert set(f.languages) >= {"de"}


def test_ecli_is_stable_with_the_existing_678k_rows():
    """Existing rows were keyed ECLI:CH:{spider}:{doc_id}; changing that would
    duplicate every row already in the table."""
    f = es_document.parse("ZG_Obergericht", "ZG_OG_001_Z1-2020-5_2022-02-18", ZG)
    assert f.ecli == "ECLI:CH:ZG_Obergericht:ZG_OG_001_Z1-2020-5_2022-02-18"


def test_a_doc_id_that_is_already_an_ecli_is_kept_as_is():
    f = es_document.parse("CH_BGer", "ECLI:CH:BGER:2020:1", {"Datum": "2020-01-01"})
    assert f.ecli == "ECLI:CH:BGER:2020:1"


@pytest.mark.parametrize("raw", ["", None, "0000-00-00", "not a date", "2022"])
def test_an_unusable_date_becomes_none_rather_than_raising(raw):
    f = es_document.parse("ZG_Obergericht", "d", {"Datum": raw})
    assert f.decision_date is None


def test_a_document_with_no_pdf_and_no_html_still_parses():
    f = es_document.parse("ZG_Obergericht", "d", {"Datum": "2022-02-18"})
    assert f.pdf_path is None and f.html_path is None


def test_metadata_json_keeps_the_untouched_payload_keys():
    f = es_document.parse("ZG_Obergericht", "d", ZG)
    assert f.metadata_json["Signatur"] == "ZG_OG_001"
    assert "Scrapedate" in f.metadata_json
