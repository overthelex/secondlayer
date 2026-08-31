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
    """A document that LIES about its encoding must not be believed.

    The old assertion stopped at "Beschwerde" -- one character before the
    "ü" the test is named for -- so it passed against
    "BeschwerdefÃ¼hrer". from_html() now pins the parser to UTF-8, which
    overrides the meta declaration entirely.
    """
    html = "<html><meta charset='iso-8859-1'><p>Beschwerdeführer</p></html>".encode("utf-8")
    text = text_extract.from_html(html)
    assert "Beschwerdeführer" in text
    assert "Ã" not in text


def test_html_to_text_with_no_declaration_at_all_is_not_read_as_latin_1():
    """The measured defect: lxml_html.fromstring(bytes) with no declared
    charset falls back to ISO-8859-1, turning "Eidgenössisches ...
    Beschwerdeführer" into "EidgenÃ¶ssisches ... BeschwerdefÃ¼hrer" -- the
    exact damage that put 165,363 CH_BGer rows into this pipeline. The
    quality score cannot catch it, so the parser must not create it."""
    html = ("<html><body><p>Eidgenössisches Versicherungsgericht, "
            "Beschwerdeführer</p></body></html>").encode("utf-8")
    text = text_extract.from_html(html)
    assert "Eidgenössisches" in text
    assert "Beschwerdeführer" in text
    assert "Ã" not in text and "Â" not in text


def test_html_to_text_survives_an_xml_declaration():
    """Handing lxml a decoded str would raise ValueError here; bytes plus a
    pinned parser is the form that covers every declaration shape."""
    html = ("<?xml version='1.0' encoding='iso-8859-1'?>"
            "<html><body><p>Beschwerdeführer</p></body></html>").encode("utf-8")
    assert "Beschwerdeführer" in text_extract.from_html(html)


# --- charset resolution at fetch time ---

def test_charset_from_headers_reads_the_content_type_parameter():
    assert text_extract.charset_from_headers("text/html;charset=UTF-8") == "utf-8"
    assert text_extract.charset_from_headers("text/html; charset=\"iso-8859-1\"") == "iso8859-1"


def test_charset_from_headers_is_none_when_the_header_omits_it():
    """Measured 2026-08-23: entscheidsuche answers document requests with a
    bare `Content-Type: text/html`, no charset parameter at all. The header
    is authoritative when present, but it usually is not."""
    assert text_extract.charset_from_headers("text/html") is None
    assert text_extract.charset_from_headers(None) is None


def test_declared_charset_prefers_the_header_over_the_document():
    payload = b"<html><head><meta charset='iso-8859-1'></head></html>"
    assert text_extract.declared_charset(payload, "text/html;charset=utf-8") == "utf-8"


def test_declared_charset_falls_back_to_the_document_declaration():
    payload = b"<html><head><meta charset='iso-8859-1'></head></html>"
    assert text_extract.declared_charset(payload, "text/html") == "iso8859-1"


def test_declared_charset_is_none_when_nobody_declared_anything():
    assert text_extract.declared_charset(b"<html><body>x</body></html>", "text/html") is None


def test_decode_html_uses_a_latin_1_declaration_rather_than_guessing_utf8():
    payload = ("<html><head><meta charset='iso-8859-1'></head>"
               "<body><p>Beschwerdeführer</p></body></html>").encode("iso-8859-1")
    assert "Beschwerdeführer" in text_extract.decode_html(payload, "text/html")


def test_decode_html_defaults_to_utf8_when_nothing_is_declared():
    payload = "<html><body><p>Beschwerdeführer</p></body></html>".encode("utf-8")
    assert "Beschwerdeführer" in text_extract.decode_html(payload, "text/html")


def test_to_utf8_transcodes_a_latin_1_body_so_the_file_on_disk_is_utf8():
    """This is what makes a resumed run safe: extract reads the file with no
    HTTP response to consult, so the body has to already BE UTF-8."""
    payload = ("<html><head><meta charset='iso-8859-1'></head>"
               "<body><p>Beschwerdeführer</p></body></html>").encode("iso-8859-1")
    transcoded = text_extract.to_utf8(payload, "text/html")
    assert transcoded.decode("utf-8")
    # And the stale declaration inside it must not mislead the extractor.
    assert "Beschwerdeführer" in text_extract.from_html(transcoded)


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


def test_pdf_to_text_strips_nul_and_other_control_characters(tmp_path, monkeypatch):
    """decode(..., errors="replace") only fixes invalid UTF-8 -- a genuine NUL
    byte (or any other C0/C1 control byte) is valid UTF-8 on its own and
    passes straight through undecoded. Postgres rejects NUL in a text column
    outright, so these must never reach the database. Surrounding text and
    newlines must survive the strip."""
    dummy_pdf = tmp_path / "d.pdf"
    dummy_pdf.write_bytes(b"%PDF-1.4")

    raw = (
        "Das Bundesgericht\x00 hat entschieden.\n"
        "Zweite Zeile\x01\x02 mit Kontrollzeichen.\x0b\x0c"
    )

    class FakeCompleted:
        returncode = 0
        stdout = raw.encode("utf-8")
        stderr = b""

    monkeypatch.setattr(
        text_extract.subprocess, "run",
        lambda *a, **k: FakeCompleted())

    text = text_extract.from_pdf(dummy_pdf)

    assert "\x00" not in text
    assert "\x01" not in text and "\x02" not in text
    assert "\x0b" not in text and "\x0c" not in text
    assert "Das Bundesgericht hat entschieden." in text
    assert "Zweite Zeile mit Kontrollzeichen." in text
    assert "\n" in text


# --- the real document, end to end ---

FIXTURE_HTML = pathlib.Path(__file__).parent / "fixtures" / "decision_ch_bge.html"
# Captured 2026-08-23 from
#   https://entscheidsuche.ch/docs/CH_BGE/CH_BGE_001_BGE-80-I-1_1954-01-27.html
# The response's own header was `Content-Type: text/html` -- NO charset
# parameter -- so the HTTP header is not the authority here; the document's
# `<meta charset="utf-8"/>` is. Both paths are exercised below.
FIXTURE_HTML_CONTENT_TYPE = "text/html"


@pytest.mark.skipif(not FIXTURE_HTML.exists(),
                    reason="decision_ch_bge.html fixture not captured")
def test_a_real_entscheidsuche_page_extracts_with_its_accents_intact():
    """The branch had no real HTML fixture at all: from_html had never run
    against an actual entscheidsuche page. This is that page, fetched and
    extracted the way the pipeline does it."""
    raw = FIXTURE_HTML.read_bytes()
    body = text_extract.to_utf8(raw, FIXTURE_HTML_CONTENT_TYPE)
    text = text_extract.from_html(body)

    assert "Bundesgericht" in text or "Urteil" in text
    assert "Graubünden" in text
    assert "Grundsätze" in text
    assert "über" in text
    assert "Ã" not in text and "Â" not in text
    assert text_quality.score(text, ["de"]) > text_quality.ACCEPT_THRESHOLD


@pytest.mark.skipif(not FIXTURE_HTML.exists(),
                    reason="decision_ch_bge.html fixture not captured")
def test_the_real_page_stripped_of_its_declaration_is_still_not_mojibake():
    """The same real bytes with the one thing that saved them removed.

    entscheidsuche ships `<meta charset="utf-8"/>` today and its
    Content-Type carries no charset, so the whole corpus rests on that meta
    tag. A spider that stops emitting it -- or a mirror that serves the
    body raw -- would have silently re-created the mojibake. Against the
    old code this document decodes as ISO-8859-1 and comes out
    "GraubÃ¼nden"; the score would have promoted it (0.9850 measured,
    against a 0.55 threshold)."""
    raw = FIXTURE_HTML.read_bytes().replace(b'<meta charset="utf-8"/>', b"")
    assert b"charset" not in raw

    text = text_extract.from_html(text_extract.to_utf8(raw, "text/html"))
    assert "Graubünden" in text
    assert "GraubÃ¼nden" not in text
    assert not text_quality.is_mojibake(text)


def test_the_control_character_strip_is_equivalent_to_the_category_check():
    """The regex replaced a per-character `unicodedata.category(c) != "Cc"`
    loop (10.576 ms/doc -> 0.444 ms/doc on the real fixture, 23.8x). Cc is
    exactly U+0000..U+001F plus U+007F..U+009F, so the two must agree on
    every one of those 160 code points, and TAB/LF/CR must survive both."""
    import unicodedata
    sample = "".join(chr(c) for c in range(0x00, 0xA1))
    expected = "".join(
        c for c in sample
        if c in "\n\r\t" or unicodedata.category(c) != "Cc")
    assert text_extract._strip_control_characters(sample) == expected
    for keeper in ("\t", "\n", "\r"):
        assert keeper in text_extract._strip_control_characters(sample)


def test_the_strip_leaves_accented_letters_alone():
    """U+0080..U+009F is C1, but U+00A0 and up are printable Latin-1 and
    include every accent this corpus depends on."""
    text = "Beschwerdeführer, société, però, ÂGE, § 5"
    assert text_extract._strip_control_characters(text) == text
