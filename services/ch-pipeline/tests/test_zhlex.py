"""chpipe.zhlex on trimmed real captures from zh.ch / notes.zh.ch (2026-08-26)."""
import datetime
import json
import pathlib

import pytest

from chpipe import zhlex

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
D = datetime.date


def test_index_url_carries_the_spa_parameters():
    url = zhlex.index_url(D(2005, 1, 1), D(2005, 12, 31), page=3)
    assert url.startswith(zhlex.INDEX_URL + "?")
    assert "includeRepealedEnactments=true" in url
    assert "enactmentDate=2005-01-01_2005-12-31" in url
    assert "page=3" in url
    assert "fileNumber" not in url
    assert "fileNumber=7" in zhlex.index_url(D(2005, 1, 1), D(2005, 1, 1), file_number=7)


def test_parse_index_page_yields_one_stub_per_edition():
    page = zhlex.parse_index_page(json.loads((FIXTURES / "zhlex_index_page.json").read_text()))
    assert page.number_of_results == 77 and page.number_of_pages == 6 and page.capped is False
    assert [s.sr_number for s in page.stubs] == ["101", "101", "101", "102"]
    first = page.stubs[0]
    assert first.version_no == "129" and first.withdrawal_date is None
    assert first.enactment_date == D(2005, 2, 27)
    assert first.title == "Verfassung des Kantons Zürich"
    assert first.page_url == ("https://www.zh.ch/de/politik-staat/gesetze-beschluesse/gesetzessammlung/"
                              "zhlex-ls/erlass-101-2005_02_27-2006_01_01-129.html")
    old = page.stubs[2]
    assert old.version_no == "039" and old.withdrawal_date == D(2006, 1, 1)
    assert old.enactment_date == D(1869, 4, 18)


def test_index_rows_with_unknown_links_are_reported_not_fatal():
    page = zhlex.parse_index_page({"data": [{"link": "/de/x.html", "referenceNumber": "1"}],
                                   "numberOfResults": 1, "numberOfResultPages": 1})
    assert page.stubs == [] and page.unparsed == ["/de/x.html"]


def test_version_link_parts():
    assert zhlex.parse_version_link(
        "/x/zhlex-ls/erlass-131_1-1926_06_06-1926_06_22-095.html") == ("131.1", "1926-06-06", "1926-06-22", "095")
    assert zhlex.parse_version_link("erlass-101-1869_04_18--039.html") == ("101", "1869-04-18", "", "039")
    assert zhlex.parse_version_link("erlass-414_410_5-2020_10_28-2021_01_01-111.html")[0] == "414.410.5"
    assert zhlex.parse_version_link("erlass-631_41-1958_11_10--008b.html")[1:] == ("1958-11-10", "", "008b")
    assert sorted(["009", "008b", "008", "000"], key=zhlex.version_key) == ["000", "008", "008b", "009"]
    with pytest.raises(zhlex.ZhlexParseError):
        zhlex.parse_version_link("/de/irgendwas.html")


def test_parse_current_edition_page():
    page = zhlex.parse_act_page((FIXTURES / "zhlex_erlass_101_129.html").read_bytes())
    assert page.sr_number == "101" and page.title == "Verfassung des Kantons Zürich"
    assert page.version_no == "129"
    assert page.enactment_date == D(2005, 2, 27) and page.entry_into_force == D(2006, 1, 1)
    assert page.publication_date == D(2024, 7, 1) and page.withdrawal_date is None
    assert page.pdf_url == ("https://www.notes.zh.ch/appl/zhlex_r.nsf/OpenAttachment?Open"
                            "&docid=29614D695A87DA0DC1258C67004880D5&file=101_27.2.05_129.pdf")
    assert page.html_url is None
    assert page.act_url == "http://www.zhlex.zh.ch/Erlass.html?Open&Ordnr=101"
    # the Historie list, trimmed to 6 entries in the fixture: newest first
    assert [v.version_no for v in page.versions] == ["129", "121", "125", "012", "011", "000"]
    assert page.versions[0].in_force_until is None and page.versions[0].label == "129 (aktuell)"
    assert page.versions[1].in_force_until == D(2024, 7, 1)
    assert page.versions[-1].page_url.endswith("erlass-101-1869_04_18--000.html")


def test_parse_old_edition_page_with_html_and_pdf_and_no_publication_date():
    page = zhlex.parse_act_page((FIXTURES / "zhlex_erlass_101_039.html").read_bytes())
    assert page.version_no == "039" and page.title == "Verfassung des eidgenössischen Standes Zürich"
    assert page.enactment_date == D(1869, 4, 18) and page.entry_into_force is None
    assert page.publication_date is None and page.withdrawal_date == D(2006, 1, 1)
    assert page.html_url == "https://www.notes.zh.ch/appl/zhlex_r.nsf/WebRT/C1256C610039641BC12568DA00191153"
    assert page.pdf_url.endswith("file=101_18.4.69_39.pdf")


def test_text_url_prefers_the_html_rendering():
    page = zhlex.parse_act_page((FIXTURES / "zhlex_erlass_101_039.html").read_bytes())
    assert zhlex.text_url(page) == ("html", page.html_url)
    page = zhlex.parse_act_page((FIXTURES / "zhlex_erlass_101_129.html").read_bytes())
    assert zhlex.text_url(page) == ("pdf", page.pdf_url)


def _rec(no, pub=None, withdrawal=None, enactment=D(2005, 2, 27), entry=D(2006, 1, 1)):
    return zhlex.EditionRecord(no, pub, withdrawal, enactment, entry)


def test_edition_dates_from_publication_dates_with_the_same_day_and_current_rules():
    """101: 121 (pub 01.04.2023), 125 and 129 (both pub 01.07.2024): 125 was
    replaced the same day and is never in force; 129 is open."""
    rows = zhlex.edition_dates([_rec("129", D(2024, 7, 1)), _rec("121", D(2023, 4, 1), D(2024, 7, 1)),
                                _rec("125", D(2024, 7, 1), D(2024, 7, 1))])
    assert rows == [("121", D(2023, 4, 1), D(2024, 6, 30)),
                    ("125", D(2024, 7, 1), D(2024, 6, 30)),
                    ("129", D(2024, 7, 1), None)]


def test_edition_dates_without_publication_dates_follow_the_predecessor_end():
    """The 1869 constitution's loose-leaf editions have no Publikationsdatum;
    each Aufhebungsdatum is the last day of a quarter (000: 30.09.1995,
    011: 31.12.1995), so the successor starts the day after."""
    rows = zhlex.edition_dates([
        _rec("000", None, D(1995, 9, 30), D(1869, 4, 18), None),
        _rec("011", None, D(1995, 12, 31), D(1869, 4, 18), None),
        _rec("012", None, D(1996, 3, 31), D(1869, 4, 18), None),
        _rec("051", D(2006, 1, 1)),
    ])
    assert rows == [("000", D(1869, 4, 18), D(1995, 9, 30)),
                    ("011", D(1995, 10, 1), D(1995, 12, 31)),
                    ("012", D(1996, 1, 1), D(2005, 12, 31)),
                    ("051", D(2006, 1, 1), None)]


def test_edition_dates_of_a_withdrawn_act_close_the_last_edition():
    # new-style Aufhebungsdatum (first of a month) is the day the repeal took
    # effect; old-style (any other day) is the last day in force
    rows = zhlex.edition_dates([_rec("000", D(1991, 1, 1), D(2010, 7, 1)),
                                _rec("069", D(2010, 7, 1), D(2018, 1, 1))])
    assert rows == [("000", D(1991, 1, 1), D(2010, 6, 30)), ("069", D(2010, 7, 1), D(2017, 12, 31))]
    rows = zhlex.edition_dates([_rec("000", None, D(2007, 12, 31), D(1859, 12, 23), None)])
    assert rows == [("000", D(1859, 12, 23), D(2007, 12, 31))]
    # 631.41: a lettered Nachtrag sorts between its neighbours
    rows = zhlex.edition_dates([_rec("009", D(2001, 1, 1)), _rec("008b", D(2000, 7, 1), D(2001, 1, 1)),
                                _rec("008", D(2000, 1, 1), D(2000, 7, 1))])
    assert [r[0] for r in rows] == ["008", "008b", "009"] and rows[1][2] == D(2000, 12, 31)


def test_edition_without_any_date_is_reported_not_guessed():
    with pytest.raises(zhlex.ZhlexParseError):
        zhlex.edition_dates([_rec("000", None, None, None, None)])


def test_webrt_paragraph_articles():
    payload = (FIXTURES / "zhlex_webrt_131_1_004.html").read_bytes()
    articles, text = zhlex.parse_webrt(payload, "text/html; charset=ISO-8859-1")
    assert [a.article_number for a in articles] == ["1", "2", "3", "4"]
    assert articles[0].e_id == "par_1" and articles[0].ordinal == 0
    assert articles[0].text.startswith("§ 1. Die Gemeinden werden eingeteilt")
    assert "Zivilgemeinden und die christkatholische Kirchgemeinde Zürich." in articles[0].text
    assert articles[1].marginal_note == "B. Veränderungen in der Gemeindeeinteilung I. Grenzveränderungen"
    assert "§§ 9-13" in articles[1].text
    assert "FN" not in " ".join(a.text for a in articles), "footnote markers are stripped"
    assert text.startswith("Gesetz\nüber das Gemeindewesen\n(Gemeindegesetz)\n(vom 6.Juni 1926)\nErster Titel")
    assert "OS 33, 339" in text, "the footnotes stay in the full text"
    assert "OS 33, 339" not in articles[-1].text


def test_webrt_art_numbering_and_interleaved_footnotes():
    payload = (FIXTURES / "zhlex_webrt_101_000.html").read_bytes()
    articles, text = zhlex.parse_webrt(payload, "text/html; charset=ISO-8859-1")
    assert [a.article_number for a in articles] == ["1", "2", "3", "4", "5"]
    assert articles[0].e_id == "art_1"
    assert articles[0].marginal_note == "I. Staatsbürgerliche Grundsätze", "the nearest heading only"
    assert articles[2].text.endswith("so ist der Angeklagte freizusprechen.")
    assert any("Gewährleistet durch BB vom 22. Juli 1869" in n for n in articles[4].notes)
    assert "Todesstrafe" in articles[4].text and "OS 14, 549" not in articles[4].text
    assert text.startswith("Verfassung\ndes eidgenössischen Standes Zürich\n(vom 18.April 1869)\nDas Volk")


def test_webrt_strips_a_marker_glued_to_a_heading():
    payload = ('<html><body><font color="#0000FF">Gesundheitsdirektion FN17</font><br>'
               '<font size="4">§ 8. In den Geschäftskreis FN18 fallen:</font></body></html>').encode("utf-8")
    articles, _ = zhlex.parse_webrt(payload, "text/html; charset=utf-8")
    assert articles[0].marginal_note == "Gesundheitsdirektion"
    assert articles[0].text == "§ 8. In den Geschäftskreis fallen:"


def test_webrt_rejects_a_page_without_law_text():
    with pytest.raises(zhlex.ZhlexParseError):
        zhlex.parse_webrt(b"<html><body><p>Login</p></body></html>", "text/html")
