import pathlib
import subprocess

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


# --- Round 1 review finding: a tool crash must not be recorded as a
# genuinely illegible document. ocr_pdf must distinguish "pdftoppm/tesseract
# ran and failed" (OcrRenderFailed -- travels through the stage's existing
# per-document guard into db.fail(), keeping the retry budget and the
# diagnostic) from "the toolchain ran fine and produced little or no text"
# (a normal string return, scored honestly and routed to the still-bad
# branch). All three tests below patch chpipe.ocr.subprocess.run rather than
# invoking real tools, so they stay fast; the real toolchain behaviour is
# already evidenced by the OCR measurement in the task report.

def _fake_pdf(tmp_path) -> pathlib.Path:
    pdf = tmp_path / "d.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    return pdf


def test_ocr_render_failed_when_pdftoppm_exits_nonzero(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        assert cmd[0] == "pdftoppm", "tesseract must not run when pdftoppm fails"
        raise subprocess.CalledProcessError(
            1, cmd, stderr=b"pdftoppm: Syntax Error: corrupt xref table")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    with pytest.raises(ocr.OcrRenderFailed) as exc_info:
        ocr.ocr_pdf(pdf, ["de"], timeout=5)
    message = str(exc_info.value)
    assert "pdftoppm" in message
    assert "corrupt xref table" in message


def test_ocr_render_failed_on_pdftoppm_timeout(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        assert cmd[0] == "pdftoppm", "tesseract must not run when pdftoppm times out"
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 5))

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    with pytest.raises(ocr.OcrRenderFailed) as exc_info:
        ocr.ocr_pdf(pdf, ["de"], timeout=5)
    message = str(exc_info.value)
    assert "pdftoppm" in message
    assert "timed out" in message


def test_a_successful_render_with_no_readable_text_still_returns_a_string(
        tmp_path, monkeypatch):
    """The genuinely-illegible-scan path is untouched: pdftoppm and
    tesseract both run and exit 0, but tesseract finds nothing to
    transcribe. That is a document-quality finding, not a tool failure, and
    must still return a string (empty, here) for the caller to score --
    never raise."""
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdftoppm":
            # Mimic pdftoppm's own naming convention: <stem>-<n>.png next to
            # the requested stem, so ocr_pdf's "page-*.png" glob finds it.
            stem = pathlib.Path(cmd[-1])
            (stem.parent / f"{stem.name}-1.png").write_bytes(b"fake png bytes")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        if cmd[0] == "tesseract":
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    text = ocr.ocr_pdf(pdf, ["de"], timeout=5)
    assert text == ""
