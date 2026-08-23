import pytest
from chpipe import ocr


def test_maps_iso_codes_to_tesseract_names():
    assert ocr.tesseract_languages(["de"]) == "deu"
    assert ocr.tesseract_languages(["fr"]) == "fra"
    assert ocr.tesseract_languages(["it"]) == "ita"


def test_combines_several_languages_in_document_order():
    assert ocr.tesseract_languages(["fr", "de"]) == "fra+deu"


def test_unknown_or_empty_falls_back_to_all_three_national_languages():
    assert ocr.tesseract_languages([]) == "deu+fra+ita"
    assert ocr.tesseract_languages(["rm"]) == "deu+fra+ita"


def test_deduplicates_repeated_languages():
    assert ocr.tesseract_languages(["de", "de", "fr"]) == "deu+fra"


def test_ocr_on_a_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        ocr.ocr_pdf(tmp_path / "nope.pdf", ["de"], timeout=5)
