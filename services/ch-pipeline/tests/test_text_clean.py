import time
from pathlib import Path

import pytest

from chpipe.text_clean import (
    CLEANER_VERSION,
    OWN_REFLOW_SPIDERS,
    clean_pdf_text,
    hyphen_vocabulary,
    is_hard_wrapped,
    join_hyphen,
    normalise_chars,
    split_columns,
    strip_page_furniture,
    unwrap,
)
from chpipe.text_damage import markers

FIXTURES = Path(__file__).parent / "fixtures"
GR_FIXTURE = (FIXTURES / "pdftext_decision_gr_hardwrap.txt").read_text()
VB_TWOCOL = (FIXTURES / "pdftext_decision_vb_twocolumn.txt").read_text()
UNIBE_TWOCOL = (FIXTURES / "pdftext_decision_unibe_twocolumn.txt").read_text()
HTML_FIXTURE = (FIXTURES / "decision_bger_html_reflowed.txt").read_text()

V = frozenset()


def test_constants():
    assert CLEANER_VERSION == 1
    assert OWN_REFLOW_SPIDERS == frozenset({"CH_WEKO_RPW", "CH_WEKO"})


def test_join_hyphen_wrap():
    assert join_hyphen("Zusammenschluss-", "vorhaben", V) == "Zusammenschlussvorhaben"


def test_join_hyphen_conjunction():
    assert join_hyphen("Kantons-", "und Gemeindesteuern", V) == "Kantons- und Gemeindesteuern"


def test_join_hyphen_uppercase():
    assert join_hyphen("Schweizer-", "Franken", V) == "Schweizer-Franken"


def test_join_hyphen_vocab_keeps_real_hyphen():
    V2 = frozenset({"rechts", "staat", "rechtsstaat", "nord", "süd"})
    assert join_hyphen("Nord-", "süd", V2) == "Nord-süd"       # both parts known, join unknown
    assert join_hyphen("Rechts-", "staat", V2) == "Rechtsstaat"


@pytest.mark.parametrize("head, tail", [
    ("Kantons-", "und/oder Gemeindesteuern"),
    ("Kantons-", "resp. Bundesrecht"),
    ("Kantons-", "bis Bundesebene"),
    ("Vor-", "wie Nachteile"),
    ("pré-", "à post-"),
    ("Kantons-", "bzw. Gemeindesteuern"),
    ("Kantons-", "beziehungsweise Bundesrecht"),
    ("Kantons-", "respektive Bundesrecht"),
    ("cantonal-", "et/ou fédéral"),
])
def test_join_hyphen_keeps_suspended_hyphen_before_conjunctions(head, tail):  # ruling R12
    assert join_hyphen(head, tail, V) == head + " " + tail


def test_join_hyphen_keeps_numeric_ranges():
    assert join_hyphen("in den Jahren 1990-", "1995", V) == "in den Jahren 1990-1995"


def test_hyphen_vocabulary_excludes_german():
    assert hyphen_vocabulary([]) == frozenset()
    assert hyphen_vocabulary(["de"]) == frozenset()
    fr = hyphen_vocabulary(["fr"])
    assert fr and all(w == w.lower() for w in fr)
    assert hyphen_vocabulary(["de", "fr", "it"]) == fr | hyphen_vocabulary(["it"])


def test_unwrap_paragraph_marker_starts_new_paragraph():
    out = unwrap(["schriftlicher Form zukommen liess.", "4. Nachdem das Sekretariat", "darüber informiert hatte."], V)
    assert out == ["schriftlicher Form zukommen liess.", "4. Nachdem das Sekretariat darüber informiert hatte."]


def test_unwrap_bridges_page_break_inside_hyphenated_word():
    out = unwrap(["muss sie aus zwei Dokumenten herleiten. Dass die For-", "", "", "derungen nunmehr K. zustehen"], V)
    assert out == ["muss sie aus zwei Dokumenten herleiten. Dass die Forderungen nunmehr K. zustehen"]


def test_unwrap_moves_page_header_out_of_a_wrapped_word():
    lines = ["muss sie aus zwei Dokumenten herleiten. Dass die For-", "", "  79", "13     PKG 2001", "", "",
             "derungen nunmehr K. zustehen sollen, müsste demnach ebenfalls aus einem"]
    assert unwrap(lines, V) == [
        "muss sie aus zwei Dokumenten herleiten. Dass die Forderungen nunmehr K. zustehen sollen, "
        "müsste demnach ebenfalls aus einem", "13     PKG 2001"]


BODY = ["Das Obergericht des Kantons hat die Berufung mit Urteil abgewiesen, weil die",
        "Voraussetzungen der Bestimmung nicht erfüllt waren und keine Ausnahme vorliegt."]


@pytest.mark.parametrize("block", [
    ["A.________, vertreten durch", "Rechtsanwalt X.,", "Beschwerdeführer,", "", "gegen", "", "B.________,"],
    ["Gegenstand", "", "unentgeltliche Rechtspflege,"],
    ["Le Tribunal fédéral", "", "vu le recours du 3 mai 2020,", "", "attendu que le recourant"],
])
def test_unwrap_does_not_bridge_structural_blocks(block):
    out = unwrap(BODY + [""] + block, V)
    assert out[2:] == [ln for ln in block]


@pytest.mark.parametrize("lines", [
    ["Das Obergericht des Kantons Zürich hat die Berufung des Klägers mit Urteil vom",
     "12. Juli 2019 abgewiesen, weil die Voraussetzungen der Bestimmung fehlten."],
    ["Die Voraussetzungen für einen Aufenthalt des Beschwerdeführers sind gemäss",
     "Art. 8 EMRK nicht erfüllt, weil keine schützenswerte Beziehung besteht."],
])
def test_unwrap_marker_after_open_sentence_joins(lines):  # ruling R13
    assert unwrap(BODY + lines, V) == [" ".join(BODY + lines)]


def _page(n: int) -> list[str]:
    return [f"Zeile {n}.{k} des Urteils." for k in range(20)]


def test_strip_page_furniture_drops_folios_and_running_headers():
    # Ruling R14: a repeated line is a running header only with page-like spacing.
    header = "Bundesgericht 4A_1/2020"
    lines = ["Urteil vom 3. Mai", "8", header, *_page(1), header, *_page(2), header, *_page(3)]
    assert strip_page_furniture(lines) == ["Urteil vom 3. Mai", *_page(1), *_page(2), *_page(3)]


def test_strip_page_furniture_keeps_repeated_rows_close_together():
    lines = ["Kosten:", "Total     0", "x", "Total     0", "y", "Total     0"]
    assert strip_page_furniture(lines) == lines


def test_strip_page_furniture_drops_folio_headers_with_increasing_folios():
    lines = ["PKG 2001       13", *_page(1), "              79", "PKG 2001       14", *_page(2),
             "PKG 2001       15", *_page(3)]
    assert strip_page_furniture(lines) == [*_page(1), *_page(2), *_page(3)]


def test_strip_page_furniture_keeps_amount_rows():
    lines = ["Kosten des Verfahrens:", "Gerichtsgebühr       500", "Schreibgebühren      120",
             "Total                620", "", "Kosten des Rekursverfahrens:", "Gerichtsgebühr       800",
             "Total                800", "Steuerbares Einkommen    12/15"]
    assert strip_page_furniture(lines) == lines


def test_strip_page_furniture_keeps_headers_without_increasing_folios():
    # GR: "PKG 2001  13" / "13  PKG 2001" carry the section number, not the page folio.
    lines = ["PKG 2001       13", *_page(1), "13     PKG 2001", *_page(2), "PKG 2001       13", *_page(3)]
    assert strip_page_furniture(lines) == lines


def test_is_hard_wrapped():
    assert is_hard_wrapped(GR_FIXTURE) and not is_hard_wrapped(HTML_FIXTURE)


def test_clean_pdf_text_hardwrapped_fixture():
    out = clean_pdf_text(GR_FIXTURE, ["de"])
    assert "iden-\n" not in out and "identisch sein" in out
    assert markers(out)["hyphen_breaks"] == 0 and markers(out)["page_number_lines"] == 0
    assert markers(out)["mean_line_len"] > 300


def test_html_fixture_is_a_true_noop_fixture():
    m = markers(HTML_FIXTURE)
    assert m["page_number_lines"] == 0 and m["repeated_lines"] == 0
    assert "\n\n\n" not in HTML_FIXTURE


def test_clean_pdf_text_reflowed_is_noop_except_chars():
    assert clean_pdf_text(HTML_FIXTURE, ["de"]) == normalise_chars(HTML_FIXTURE).strip()


def test_split_columns_deinterleaves_two_column_run():
    out = "\n".join(split_columns(VB_TWOCOL.splitlines()))
    # left column sentence is contiguous after the split, not interleaved with "Proposition de la commission"
    assert "sich von diesen Aeusserun-\ngen des Chefbeamten" in out
    assert "Aeusserun-       Proposition" not in out
    # the running header above two blank lines is not pulled into the run
    assert out.split("\n")[0] == VB_TWOCOL.split("\n")[0]


def test_split_columns_is_linear_on_alternating_lines():
    gutter = "a" * 30 + "     " + "b" * 30
    lines = [gutter, "plain text line without any gutter"] * 10_000
    t0 = time.perf_counter()
    out = split_columns(lines)
    assert time.perf_counter() - t0 < 2
    assert sum(len(x.replace(" ", "")) for x in out) == sum(len(x.replace(" ", "")) for x in lines)


def test_split_columns_passes_single_column_through():
    assert split_columns(GR_FIXTURE.splitlines()) == GR_FIXTURE.splitlines()
    assert split_columns(HTML_FIXTURE.splitlines()) == HTML_FIXTURE.splitlines()


def test_clean_pdf_text_twocolumn_unibe():
    out = clean_pdf_text(UNIBE_TWOCOL, ["fr"])
    assert "nn decret     mune" not in out
    assert "chargeant eette derniere autorite de eonvoquer de nouveau" in out   # OCR spelling, left page contiguous


def test_normalise_chars():
    assert normalise_chars("ﬁnanz x­y") == "finanz xy"
    assert normalise_chars("a b c ﬂ ﬀ ﬃ ﬄ �") == "a b c fl ff ffi ffl �"
