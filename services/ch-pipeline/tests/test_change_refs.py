"""change_refs: the per-host reference grammar and the matcher, on the
strings prod actually holds (ch_article_provenance.raw_note and
ch_act_change_document.number, sampled 2026-08-26)."""
import datetime

import pytest

from chpipe import change_refs
from chpipe.change_refs import Candidate, match_change_document, number_key, parse_reference

D = datetime.date


def cand(i, number, pub=None):
    return Candidate(i, number, D.fromisoformat(pub) if pub else None)


# --- references_of: which fields of a raw_note are the source cell -------

def test_references_are_the_fields_after_the_change_cell():
    assert change_refs.references_of(
        "09.03.2009 | 01.01.2010 | § 226 Abs. 3 | eingefügt | G 2009 321") == ["G 2009 321"]
    # LU writes two references in one cell, pipe-separated
    assert change_refs.references_of(
        "09.12.2013 | 01.07.2014 | Erlass | Erstfassung | K 2013 3767 | G 2014 53") == \
        ["K 2013 3767", "G 2014 53"]


def test_a_four_field_note_has_no_reference():
    assert change_refs.references_of("16.08.2011 | 01.08.2011 | § 66 Abs. 2, 1. | geändert") == []
    assert change_refs.references_of("") == []


# --- per-host reference grammar -------------------------------------------

@pytest.mark.parametrize("canton, text, kind, key", [
    ("BL", "GS 2017.026", "number", ("2017", "26")),
    ("BL", "wg. GS 2014.024", "number", ("2014", "24")),
    ("BL", "GS 33.1335", "legacy", None),          # volume.page, pre-2014: no document on the host
    ("LU", "G 2017-022", "number", ("2017", "22")),
    ("LU", "G 2020-051k", "number", ("2020", "51k")),
    ("LU", "K 2025 2817", "number", ("K", "2025", "2817")),
    ("LU", "G 2009 321", "legacy", None),          # year + page of the Gesetzessammlung
    ("LU", "G XVI 123", "legacy", None),
    ("ZG", "GS 2018/006", "number", ("2018", "6")),
    ("ZG", "GS 27, 759", "legacy", None),          # volume, page: never a document number (0 of 394)
    ("OW", "OGS 2012, 62", "number", ("2012", "62")),
    ("OW", "OGS 2025, 10a", "number", ("2025", "10a")),
    ("OW", "2026, 006", "number", ("2026", "6")),
    ("OW", "OGS 2019, 12 und 13", "number", ("2019", "12")),
    ("BS", "KB 05.12.2020", "date", D(2020, 12, 5)),
    ("BS", "10.02.2024", "date", D(2024, 2, 10)),
    ("BS", "infolge Volksabstimmung vom 28.11.2021; KB 06.06.2020", "date", D(2020, 6, 6)),
    ("BS", "KtBl 2006 I 560", "legacy", None),
    ("BS", "nicht publiziert", "unknown", None),
    ("ZG", "[nicht angegeben]", "unknown", None),
    # a host without its own grammar: digits and a trailing letter, nothing else
    ("BE", "BAG 04-9", "number", ("4", "9")),
    ("SG", "nGS 2019-045", "number", ("2019", "45")),
    ("TG", "", "unknown", None),
])
def test_parse_reference(canton, text, kind, key):
    ref = parse_reference(canton, text)
    assert ref.kind == kind
    if key is not None:
        assert ref.key == key


@pytest.mark.parametrize("canton, number, key", [
    ("BL", "2017.026", ("2017", "26")),
    ("LU", "2016-14", ("2016", "14")),
    ("LU", "2017-022", ("2017", "22")),
    ("LU", "2020-051k", ("2020", "51k")),
    ("LU", "K 2025 2817", ("K", "2025", "2817")),
    ("ZG", "2018/006", ("2018", "6")),
    ("ZG", "GS 2022/081", ("2022", "81")),
    ("OW", "OGS 2012, 062 - ABl 2012, 420", ("2012", "62")),
    ("OW", "OGS 2025, 010a", ("2025", "10a")),
    ("OW", "2026, 006", ("2026", "6")),
    ("TG", "19/2025​", ("19", "2025")),       # zero-width spaces in the host's numbers
    ("TG", "ABl. 27/2025", ("27", "2025")),
    ("BE", None, None),
    ("BE", "", None),
])
def test_number_key(canton, number, key):
    assert number_key(canton, number) == key


# --- the matcher ------------------------------------------------------------

def test_bl_links_by_number():
    cands = [cand(1, "2015.015", "2015-03-03"), cand(2, "2017.026", "2017-05-30")]
    m = match_change_document("BL", ["GS 2017.026"], D(2017, 3, 21), D(2017, 7, 1), cands)
    assert (m.change_document_id, m.reason) == (2, "number")


def test_lu_new_style_links_by_number_with_and_without_zero_padding():
    cands = [cand(1, "2016-14", "2016-06-11"), cand(2, "2017-022", "2017-04-08")]
    assert match_change_document("LU", ["G 2017-022"], None, None, cands).change_document_id == 2
    assert match_change_document("LU", ["G 2016-014"], None, None, cands).change_document_id == 1


def test_lu_kantonsblatt_reference_links_to_the_k_number():
    cands = [cand(1, "2023-019", "2023-03-04"), cand(2, "K 2023 2658", "2023-09-16")]
    m = match_change_document("LU", ["K 2023 2658"], D(2023, 9, 5), D(2024, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (2, "number")


def test_lu_page_style_reference_falls_back_to_the_publication_window():
    # "G 2009 321" names a page, the documents are numbered 2009-nn: the
    # only way in is the date. One document published 24 days after the decision.
    cands = [cand(1, "2009-12", "2009-04-04"), cand(2, "2010-40", "2010-06-19")]
    m = match_change_document("LU", ["G 2009 321"], D(2009, 3, 9), D(2010, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (1, "window")


def test_lu_second_reference_is_tried_when_the_first_is_legacy():
    cands = [cand(1, "2017-016", "2017-02-25")]
    m = match_change_document("LU", ["K 2017 393", "G 2017-016"], D(2017, 2, 7), D(2017, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (1, "number")


def test_zg_modern_number_links_and_legacy_volume_page_uses_the_window():
    cands = [cand(1, "2018/006", "2018-02-02"), cand(2, "28/107", "2004-07-09")]
    assert match_change_document("ZG", ["GS 2018/006"], None, None, cands).change_document_id == 1
    m = match_change_document("ZG", ["GS 28, 107"], D(2004, 6, 8), D(2004, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (2, "window")


def test_ow_number_ignores_zero_padding_and_the_abl_half():
    cands = [cand(1, "OGS 2012, 062 - ABl 2012, 420", "2012-11-29"),
             cand(2, "OGS 2012, 063 - ABl 2012, 421", "2012-11-29")]
    m = match_change_document("OW", ["OGS 2012, 62"], D(2012, 11, 13), D(2013, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (1, "number")


def test_bs_links_the_kantonsblatt_date_to_date_publication():
    cands = [cand(1, "RS-BS40-0000000356", "2020-12-05"), cand(2, "2015-117", "2015-07-08")]
    m = match_change_document("BS", ["KB 05.12.2020"], D(2020, 11, 18), D(2021, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (1, "date")


def test_two_documents_on_the_same_day_are_ambiguous_not_guessed():
    cands = [cand(1, "RS-BS45-0000001077", "2025-04-19"), cand(2, "RS-BS45-0000001078", "2025-04-19")]
    m = match_change_document("BS", ["KB 19.04.2025"], D(2025, 4, 1), None, cands)
    assert (m.change_document_id, m.reason) == (None, "date_ambiguous")


def test_a_number_the_act_does_not_carry_is_unmatched_not_windowed():
    # The document exists on the host under another act; a window match
    # here would pick a neighbour and call it the source.
    cands = [cand(1, "2015.015", "2017-04-01")]
    m = match_change_document("BL", ["GS 2017.026"], D(2017, 3, 21), D(2017, 7, 1), cands)
    assert (m.change_document_id, m.reason) == (None, "number_unmatched")


def test_no_reference_links_through_a_unique_publication_in_the_window():
    cands = [cand(1, "33/2025", "2025-08-15"), cand(2, "40/2024", "2024-10-04")]
    m = match_change_document("TG", [], D(2025, 8, 5), D(2026, 1, 1), cands)
    assert (m.change_document_id, m.reason) == (1, "window")


def test_the_window_is_decision_to_sixty_days_after_the_later_of_decision_and_effect():
    cands = [cand(1, "x", "2020-01-10")]
    # published the day before the decision: outside
    assert match_change_document("TG", [], D(2020, 1, 11), None, cands).reason == "window_none"
    # effective date long after the decision: the window extends past it
    assert match_change_document("TG", [], D(2019, 6, 1), D(2019, 12, 1), cands).reason == "window"
    assert match_change_document("TG", [], D(2019, 6, 1), D(2019, 11, 1), cands).reason == "window_none"


def test_window_refuses_when_two_candidates_or_an_undated_one():
    two = [cand(1, "a", "2020-01-10"), cand(2, "b", "2020-01-20")]
    assert match_change_document("TG", [], D(2020, 1, 1), None, two).reason == "window_ambiguous"
    # OW's LB-era documents carry no date; measured 19 of 398 window matches
    # wrong on OW when such a candidate was silently skipped.
    undated = [cand(1, "a", "2020-01-10"), cand(2, "OGS 1999, 087 - LB XXV, 275", None)]
    assert match_change_document("OW", [], D(2020, 1, 1), None, undated).reason == "window_undated"


def test_no_candidates_and_no_decision_date_are_named():
    assert match_change_document("AR", [], D(2020, 1, 1), None, []).reason == "no_candidates"
    assert match_change_document("TG", [], None, None, [cand(1, "a", "2020-01-10")]).reason == "no_decision_date"


def test_a_row_string_is_accepted_in_place_of_the_list():
    cands = [cand(1, "2017.026", "2017-05-30")]
    m = match_change_document("BL", "18.05.2017 | 01.07.2017 | § 16 Abs. 1 | geändert | GS 2017.026",
                              D(2017, 5, 18), D(2017, 7, 1), cands)
    assert m.change_document_id == 1
