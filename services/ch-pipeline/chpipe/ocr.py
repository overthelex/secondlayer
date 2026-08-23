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
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            return ""

        pages: list[str] = []
        for image in sorted(pathlib.Path(tmp).glob("page-*.png")):
            try:
                done = subprocess.run(
                    ["tesseract", str(image), "stdout", "-l", langs, "--psm", "1"],
                    capture_output=True, timeout=timeout)
            except FileNotFoundError as exc:
                raise OcrToolMissing("tesseract not installed") from exc
            except subprocess.TimeoutExpired:
                continue
            if done.returncode == 0:
                pages.append(done.stdout.decode("utf-8", errors="replace"))
        return "\n\n".join(pages).strip()
