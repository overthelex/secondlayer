"""Tesseract OCR for PDFs whose text layer failed the quality gate.

prod has no GPU, so this is CPU tesseract. Pages are rendered with pdftoppm at
300 dpi, which is the lowest resolution at which Swiss judgment scans OCR
cleanly, and fed to tesseract one page at a time so a single bad page cannot
take down a whole document.
"""
from __future__ import annotations

import pathlib
import subprocess
import tempfile

# ISO 639-1 as entscheidsuche reports it -> tesseract traineddata names.
_LANGUAGE_MAP = {"de": "deu", "fr": "fra", "it": "ita", "en": "eng"}
_DEFAULT = "deu+fra+ita"

RENDER_DPI = 300


class OcrToolMissing(RuntimeError):
    pass


class OcrRenderFailed(RuntimeError):
    """The OCR toolchain (pdftoppm or tesseract) ran but failed -- a crash,
    timeout, or non-zero exit, not a judgment about document legibility.

    This is distinct from a genuinely illegible scan, which still returns a
    (possibly empty or low-quality) string: the toolchain ran and produced
    its honest best effort. A tool crash must not be recorded as though OCR
    ran and found nothing -- that would fabricate a quality measurement and
    burn the document's one shot at a retry. See ocr_stage.run(), which lets
    this exception travel through the existing per-document guard so it is
    recorded via db.fail() (attempts incremented, last_error set, row stays
    on the queue) rather than db.complete(..., "failed", text_quality=0.0).
    """


def tesseract_languages(languages: list[str]) -> str:
    names: list[str] = []
    for code in languages:
        name = _LANGUAGE_MAP.get(str(code).lower())
        if name and name not in names:
            names.append(name)
    return "+".join(names) if names else _DEFAULT


def ocr_pdf(path: pathlib.Path, languages: list[str], timeout: int = 900) -> str:
    if not path.exists():
        raise FileNotFoundError(path)
    langs = tesseract_languages(languages)
    with tempfile.TemporaryDirectory() as tmp:
        stem = pathlib.Path(tmp) / "page"
        try:
            subprocess.run(
                ["pdftoppm", "-r", str(RENDER_DPI), "-png", str(path), str(stem)],
                capture_output=True, timeout=timeout, check=True)
        except FileNotFoundError as exc:
            raise OcrToolMissing("pdftoppm not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise OcrRenderFailed(
                f"pdftoppm timed out after {timeout}s rendering {path}") from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
            raise OcrRenderFailed(
                f"pdftoppm exited {exc.returncode} rendering {path}: {stderr}") from exc

        pages: list[str] = []
        page_failures: list[str] = []
        for image in sorted(pathlib.Path(tmp).glob("page-*.png")):
            try:
                done = subprocess.run(
                    ["tesseract", str(image), "stdout", "-l", langs, "--psm", "1"],
                    capture_output=True, timeout=timeout)
            except FileNotFoundError as exc:
                raise OcrToolMissing("tesseract not installed") from exc
            except subprocess.TimeoutExpired:
                page_failures.append(f"{image.name}: tesseract timed out after {timeout}s")
                continue
            if done.returncode == 0:
                pages.append(done.stdout.decode("utf-8", errors="replace"))
            else:
                stderr = done.stderr.decode("utf-8", errors="replace").strip()
                page_failures.append(f"{image.name}: tesseract exited {done.returncode}: {stderr}")

        # A genuinely illegible scan still yields SOME pages (possibly with
        # little or no recognisable text) -- that case returns a string, as
        # before, and is scored honestly by the caller. Only when every
        # single page failed to run at all (crash/timeout on all of them,
        # not just poor recognition) is this a tool failure rather than a
        # document-quality finding.
        if not pages and page_failures:
            raise OcrRenderFailed(
                f"tesseract failed on all {len(page_failures)} page(s) of {path}: "
                + "; ".join(page_failures))
        return "\n\n".join(pages).strip()
