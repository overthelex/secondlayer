import pathlib
import pytest
from chpipe import text_quality
from chpipe.config import Settings
from chpipe.stages import extract_stage


def _settings(tmp_path) -> Settings:
    return Settings(dsn="postgresql://unused@127.0.0.1:1/unused", raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=99.0, max_attempts=3)


GOOD_DE_HTML = ("<html><body>" + "<p>Das Bundesgericht hat die Beschwerde des "
                "Beschwerdeführers gegen das Urteil des Obergerichts abgewiesen, "
                "soweit darauf einzutreten ist.</p>" * 8 + "</body></html>")


def test_html_body_extracts_and_goes_straight_to_extracted(tmp_path):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text(GOOD_DE_HTML)
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert "Bundesgericht" in text
    assert quality > text_quality.ACCEPT_THRESHOLD
    assert nxt == "extracted"


def test_a_pdf_with_no_text_layer_is_queued_for_ocr(tmp_path, monkeypatch):
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4 scan")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf", lambda p: "")
    text, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert text == ""
    assert quality == 0.0
    assert nxt == "ocr_pending"


def test_a_pdf_whose_text_layer_is_junk_is_queued_for_ocr(tmp_path, monkeypatch):
    """Presence is not quality. This is the case that silently poisons corpora."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.pdf").write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(extract_stage.text_extract, "from_pdf",
                        lambda p: "B u n d e s g e r i c h t " * 40)
    _, quality, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "pdf", "languages": ["de"]})
    assert quality < text_quality.ACCEPT_THRESHOLD
    assert nxt == "ocr_pending"


def test_html_that_extracts_to_junk_is_not_sent_to_ocr(tmp_path):
    """There is no scan behind an HTML page, so OCR cannot help; it fails instead."""
    s = _settings(tmp_path)
    (tmp_path / "S").mkdir()
    (tmp_path / "S" / "d.html").write_text("<html><body>...</body></html>")
    _, _, nxt = extract_stage.extract_one(
        s, {"doc_id": "d", "spider": "S", "text_source": "html", "languages": ["de"]})
    assert nxt == "failed"


def test_a_missing_raw_file_raises_so_the_row_can_be_refetched(tmp_path):
    s = _settings(tmp_path)
    with pytest.raises(FileNotFoundError):
        extract_stage.extract_one(
            s, {"doc_id": "gone", "spider": "S", "text_source": "pdf", "languages": []})
