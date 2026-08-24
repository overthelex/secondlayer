import pathlib
import shutil
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


def _fake_pdfinfo(pages: int):
    return subprocess.CompletedProcess(
        ["pdfinfo"], 0, stdout=f"Title: x\nPages:          {pages}\n".encode(),
        stderr=b"")


def test_ocr_render_failed_when_pdftoppm_exits_nonzero(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(3)
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
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(3)
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
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(1)
        if cmd[0] == "pdftoppm":
            stem = pathlib.Path(cmd[-1])
            (stem.parent / f"{stem.name}-1.png").write_bytes(b"fake png bytes")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        if cmd[0] == "tesseract":
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    text = ocr.ocr_pdf(pdf, ["de"], timeout=5)
    assert text == ""


# --- I9: pdftoppm exiting 0 with zero pages must not fabricate a measurement ---

def test_a_render_that_produces_no_image_is_a_tool_failure_not_an_empty_scan(
        tmp_path, monkeypatch):
    """pdftoppm exits 0 and writes nothing. Returning "" here scores 0.0 and
    closes the document as permanently failed with text_source='ocr' --
    recording that OCR ran and found nothing when it never ran at all.
    OcrRenderFailed's own docstring forbids exactly this."""
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(2)
        if cmd[0] == "pdftoppm":
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        raise AssertionError("tesseract must not run: there is no image")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    with pytest.raises(ocr.OcrRenderFailed) as exc_info:
        ocr.ocr_pdf(pdf, ["de"], timeout=5)
    assert "no image" in str(exc_info.value)


def test_a_pdf_with_no_pages_is_a_tool_failure(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)
    monkeypatch.setattr(
        ocr.subprocess, "run",
        lambda cmd, **k: _fake_pdfinfo(0) if cmd[0] == "pdfinfo"
        else pytest.fail("nothing may run for a zero-page document"))
    with pytest.raises(ocr.OcrRenderFailed, match="0 pages"):
        ocr.ocr_pdf(pdf, ["de"], timeout=5)


def test_a_missing_pdfinfo_is_a_missing_tool_not_an_empty_document(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)

    def fake_run(cmd, **kwargs):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    with pytest.raises(ocr.OcrToolMissing, match="pdfinfo"):
        ocr.ocr_pdf(pdf, ["de"], timeout=5)


# --- I8: one page at a time, on the right volume ---

def test_pages_are_rendered_one_at_a_time(tmp_path, monkeypatch):
    """pdftoppm used to be invoked once for the whole document, so every
    page was rasterised before the first tesseract call. A 300-page scan at
    300 dpi is ~2.4 GB of PNG, and at ocr_workers=2 that is ~5 GB held for
    days."""
    pdf = _fake_pdf(tmp_path)
    live_images = []
    peak = {"n": 0}
    order = []

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(5)
        if cmd[0] == "pdftoppm":
            assert "-f" in cmd and "-l" in cmd, "must render a single page"
            assert cmd[cmd.index("-f") + 1] == cmd[cmd.index("-l") + 1]
            stem = pathlib.Path(cmd[-1])
            image = stem.parent / f"{stem.name}-1.png"
            image.write_bytes(b"fake png bytes")
            live_images.append(image)
            order.append(("render", cmd[cmd.index("-f") + 1]))
            peak["n"] = max(peak["n"],
                            sum(1 for i in live_images if i.exists()))
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        if cmd[0] == "tesseract":
            order.append(("ocr", pathlib.Path(cmd[1]).name))
            return subprocess.CompletedProcess(cmd, 0, stdout=b"page text",
                                               stderr=b"")
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    text = ocr.ocr_pdf(pdf, ["de"], timeout=5)

    assert text.count("page text") == 5
    assert peak["n"] == 1, "at most one page image may exist at a time"
    assert [step for step, _ in order] == ["render", "ocr"] * 5,         "render and OCR must interleave, not render-all-then-OCR-all"
    assert not [i for i in live_images if i.exists()],         "every page image must be deleted once it has been read"


def test_page_images_go_on_the_volume_we_were_given(tmp_path, monkeypatch):
    """tempfile.TemporaryDirectory() with no dir= is /tmp on the root
    filesystem, not the 994 GB /data volume the spec sizes against."""
    pdf = _fake_pdf(tmp_path)
    volume = tmp_path / "data-volume"
    seen = []

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(1)
        if cmd[0] == "pdftoppm":
            stem = pathlib.Path(cmd[-1])
            seen.append(stem)
            (stem.parent / f"{stem.name}-1.png").write_bytes(b"x")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        return subprocess.CompletedProcess(cmd, 0, stdout=b"t", stderr=b"")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    ocr.ocr_pdf(pdf, ["de"], timeout=5, tmp_root=volume)

    assert seen and seen[0].is_relative_to(volume),         f"page images landed outside the requested volume: {seen}"
    assert not list(volume.glob("chpipe-ocr-*")),         "the temp directory must be cleaned up"


def test_the_temp_root_defaults_to_the_pdfs_own_directory(tmp_path, monkeypatch):
    pdf = _fake_pdf(tmp_path)
    seen = []

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(1)
        if cmd[0] == "pdftoppm":
            stem = pathlib.Path(cmd[-1])
            seen.append(stem)
            (stem.parent / f"{stem.name}-1.png").write_bytes(b"x")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        return subprocess.CompletedProcess(cmd, 0, stdout=b"t", stderr=b"")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    ocr.ocr_pdf(pdf, ["de"], timeout=5)
    assert seen and seen[0].is_relative_to(tmp_path)


# --- The real toolchain, on the real fixture ---

FIXTURE_PDF = pathlib.Path(__file__).parent / "fixtures" / "decision_zg.pdf"
_TOOLS = [shutil.which(t) for t in ("pdfinfo", "pdftoppm", "tesseract")]

pytestmark_tools = pytest.mark.skipif(
    not FIXTURE_PDF.exists() or not all(_TOOLS),
    reason="poppler-utils and tesseract are needed for the real-toolchain test")


@pytestmark_tools
def test_page_count_reads_a_real_pdf():
    assert ocr.page_count(FIXTURE_PDF) == 39


@pytestmark_tools
def test_the_whole_chain_reads_a_real_swiss_decision(tmp_path, monkeypatch):
    """Everything above fakes subprocess.run. This one does not: pdfinfo,
    pdftoppm and tesseract all really run, on the real 39-page Zug
    Obergericht decision, into a temp directory on the volume we chose.
    Capped at 3 pages (~2.5 s each at 300 dpi) so the suite stays fast."""
    monkeypatch.setattr(ocr, "page_count", lambda path, timeout=60: 3)
    volume = tmp_path / "data"
    text = ocr.ocr_pdf(FIXTURE_PDF, ["de"], timeout=120, tmp_root=volume)

    assert "Obergericht" in text
    assert "Abteilungspräsident" in text, "German accents must survive OCR"
    assert not list(volume.glob("chpipe-ocr-*")), \
        "the per-document temp directory must be cleaned up"


def test_tesseract_runs_single_threaded(tmp_path, monkeypatch):
    """OpenMP tesseract on the first prod run: two workers at 235% and 213%
    CPU, load past 7, and extract's load-average guard paused for most of a
    30-minute tick. Parallelism belongs to ocr_workers, not to OpenMP."""
    pdf = _fake_pdf(tmp_path)
    seen = {}

    def fake_run(cmd, **kwargs):
        if cmd[0] == "pdfinfo":
            return _fake_pdfinfo(1)
        if cmd[0] == "pdftoppm":
            stem = pathlib.Path(cmd[-1])
            (stem.parent / f"{stem.name}-1.png").write_bytes(b"fake png bytes")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        if cmd[0] == "tesseract":
            seen["env"] = kwargs.get("env")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr(ocr.subprocess, "run", fake_run)
    ocr.ocr_pdf(pdf, ["de"], timeout=5)
    assert seen["env"] is not None, "tesseract must get an explicit environment"
    assert seen["env"].get("OMP_THREAD_LIMIT") == "1"
    assert "PATH" in seen["env"], "the rest of the environment must survive"
