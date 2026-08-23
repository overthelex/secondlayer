import pathlib

import pytest
from chpipe import text_extract, text_quality

FIXTURE_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"


def test_html_to_text_drops_markup_and_keeps_words():
    html = b"<html><body><p>Das Bundesgericht</p><p>hat entschieden</p></body></html>"
    text = text_extract.from_html(html)
    assert "Bundesgericht" in text
    assert "<p>" not in text


def test_html_to_text_drops_script_and_style_content():
    html = b"<html><head><style>.a{color:red}</style></head>" \
           b"<body><script>var x=1</script><p>Urteil</p></body></html>"
    text = text_extract.from_html(html)
    assert "Urteil" in text
    assert "color" not in text and "var x" not in text


def test_html_to_text_preserves_paragraph_breaks():
    html = b"<p>Erwaegung 1</p><p>Erwaegung 2</p>"
    assert "\n" in text_extract.from_html(html)


def test_html_to_text_splits_br_separated_lines():
    """entscheidsuche HTML uses <br> heavily inside a single <p> for party
    blocks and case captions. <br> is a void element, so its .tail is the
    text that FOLLOWS it — a break appended there lands one run late and the
    break before it is lost. Each line must come out separated."""
    html = b"<p>Beschwerdefuehrer:<br>Herr Muller<br>Zug</p>"
    lines = text_extract.from_html(html).splitlines()
    assert lines == ["Beschwerdefuehrer:", "Herr Muller", "Zug"]


def test_html_to_text_handles_a_broken_encoding_declaration():
    html = "<html><meta charset='iso-8859-1'><p>Beschwerdeführer</p></html>".encode("utf-8")
    assert "Beschwerde" in text_extract.from_html(html)


@pytest.mark.skipif(not FIXTURE_PDF.exists(), reason="decision_zg.pdf fixture not captured")
def test_pdf_to_text_reads_a_real_swiss_decision():
    """decision_zg.pdf is a real Zug Obergericht decision downloaded from
    entscheidsuche.ch (see tests/fixtures/decision_zg.pdf). Extracting it and
    scoring the result is the whole point of this pipeline stage: a real
    judgment's text layer must both contain recognisable German legal words
    and pass the quality gate that decides between "keep" and "send to OCR"."""
    text = text_extract.from_pdf(FIXTURE_PDF)
    assert text
    assert any(word in text for word in ("Gericht", "Urteil", "Kanton", "Beschwerde"))
    assert text_quality.score(text, ["de"]) > text_quality.ACCEPT_THRESHOLD


def test_pdf_to_text_on_a_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        text_extract.from_pdf(tmp_path / "nope.pdf")
