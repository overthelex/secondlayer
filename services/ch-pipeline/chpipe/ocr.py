"""Tesseract OCR for PDFs whose text layer failed the quality gate.

prod has no GPU, so this is CPU tesseract. Pages are rendered with pdftoppm at
300 dpi, which is the lowest resolution at which Swiss judgment scans OCR
cleanly, and fed to tesseract one page at a time so a single bad page cannot
take down a whole document.

"One page at a time" is now literal. It used to be a claim in this docstring
and nothing more: pdftoppm was invoked once for the whole document, so every
page was rasterised before the first tesseract call. A 300-page scan at 300
dpi is roughly 2.4 GB of PNG, and at ocr_workers=2 that is ~5 GB held for as
long as the document takes -- in the DEFAULT tempfile directory, which is
/tmp on the root filesystem, not the 994 GB /data volume the spec sizes
against. Rendering page by page holds one image at a time (~8 MB), and
tmp_root puts it on the same volume as the raw corpus.
"""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import tempfile

# ISO 639-1 as entscheidsuche reports it -> tesseract traineddata names.
_LANGUAGE_MAP = {"de": "deu", "fr": "fra", "it": "ita", "en": "eng"}
_DEFAULT = "deu+fra+ita"

RENDER_DPI = 300

_PAGES = re.compile(rb"^Pages:\s+(\d+)", re.MULTILINE)


class OcrToolMissing(RuntimeError):
    pass


class OcrRenderFailed(RuntimeError):
    """The OCR toolchain (pdfinfo, pdftoppm or tesseract) ran but failed -- a
    crash, timeout, or non-zero exit, not a judgment about document
    legibility.

    This is distinct from a genuinely illegible scan, which still returns a
    (possibly empty or low-quality) string: the toolchain ran and produced
    its honest best effort. A tool crash must not be recorded as though OCR
    ran and found nothing -- that would fabricate a quality measurement and
    burn the document's one shot at a retry. See ocr_stage.run(), which lets
    this exception travel through the existing per-document guard so it is
    recorded via db.fail() (attempts incremented, last_error set, row stays
    on the queue) rather than db.complete(..., "failed", text_quality=0.0).

    Producing NO pages at all is one of these, even when pdftoppm exits 0.
    Returning "" there would score 0.0 and close the document as permanently
    failed with text_source='ocr' -- recording that OCR ran and found nothing
    when it never ran at all.
    """


# Tesseract is OpenMP-multithreaded and, left alone, spreads one page over
# every core it can find. On the first prod run two OCR workers showed as
# 235% and 213% CPU, load went past 7 on eight cores, and extract's
# capacity guard -- a load-average check, not a priority check -- paused
# 38 times (60 s each) inside one 30-minute tick while nice 19 OCR kept
# the box busy.
# One thread per worker: ocr_workers is the parallelism knob, not OpenMP.
_TESSERACT_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}


def tesseract_languages(languages: list[str]) -> str:
    names: list[str] = []
    for code in languages:
        name = _LANGUAGE_MAP.get(str(code).lower())
        if name and name not in names:
            names.append(name)
    return "+".join(names) if names else _DEFAULT


def page_count(path: pathlib.Path, timeout: int = 60) -> int:
    """How many pages this PDF has, per pdfinfo.

    pdfinfo ships in the same poppler-utils package as pdftoppm and
    pdftotext, both of which this pipeline already requires, so this adds no
    new dependency. Asking is better than probing: pdftoppm past the last
    page exits 99 with "Wrong page range given", and telling that apart from
    a real failure by parsing stderr is exactly the kind of guess that ends
    up recording a broken document as an empty one.
    """
    try:
        done = subprocess.run(["pdfinfo", str(path)],
                              capture_output=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise OcrToolMissing("pdfinfo not installed (poppler-utils)") from exc
    except subprocess.TimeoutExpired as exc:
        raise OcrRenderFailed(
            f"pdfinfo timed out after {timeout}s on {path}") from exc
    if done.returncode != 0:
        stderr = done.stderr.decode("utf-8", errors="replace").strip()
        raise OcrRenderFailed(
            f"pdfinfo exited {done.returncode} on {path}: {stderr}")
    match = _PAGES.search(done.stdout)
    if not match:
        raise OcrRenderFailed(f"pdfinfo reported no page count for {path}")
    return int(match.group(1))


def _render_page(path: pathlib.Path, number: int, tmp: pathlib.Path,
                 timeout: int) -> pathlib.Path | None:
    """One page as a PNG, or None if pdftoppm exited 0 and wrote nothing."""
    stem = tmp / f"p{number}"
    try:
        subprocess.run(
            ["pdftoppm", "-r", str(RENDER_DPI), "-png",
             "-f", str(number), "-l", str(number), str(path), str(stem)],
            capture_output=True, timeout=timeout, check=True)
    except FileNotFoundError as exc:
        raise OcrToolMissing("pdftoppm not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise OcrRenderFailed(
            f"pdftoppm timed out after {timeout}s rendering page {number} "
            f"of {path}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise OcrRenderFailed(
            f"pdftoppm exited {exc.returncode} rendering page {number} "
            f"of {path}: {stderr}") from exc
    # pdftoppm zero-pads the suffix to the width of the page count, so the
    # exact filename is not predictable from `number` alone.
    images = sorted(tmp.glob(f"p{number}-*.png"))
    return images[0] if images else None


def ocr_pdf(path: pathlib.Path, languages: list[str], timeout: int = 900,
            tmp_root: pathlib.Path | None = None) -> str:
    """Text of a scanned PDF, one page at a time.

    `tmp_root` is where the page images go. It defaults to the directory the
    PDF itself lives in -- i.e. the raw corpus volume -- rather than the
    system temp directory, which on prod is /tmp on the root filesystem and
    is not sized for gigabytes of intermediate PNG.
    """
    if not path.exists():
        raise FileNotFoundError(path)
    langs = tesseract_languages(languages)
    total = page_count(path, timeout=min(timeout, 60))
    if total < 1:
        raise OcrRenderFailed(f"pdfinfo reports {total} pages for {path}")

    root = pathlib.Path(tmp_root) if tmp_root else path.parent
    root.mkdir(parents=True, exist_ok=True)

    pages: list[str] = []
    page_failures: list[str] = []
    with tempfile.TemporaryDirectory(dir=str(root), prefix="chpipe-ocr-") as tmp:
        tmpdir = pathlib.Path(tmp)
        for number in range(1, total + 1):
            image = _render_page(path, number, tmpdir, timeout)
            if image is None:
                # pdftoppm exited 0 and wrote nothing. Treating this as "OCR
                # read the page and found nothing" would fabricate a quality
                # measurement for a page nobody rendered.
                page_failures.append(
                    f"page {number}: pdftoppm exited 0 but produced no image")
                continue
            try:
                done = subprocess.run(
                    ["tesseract", str(image), "stdout", "-l", langs, "--psm", "1"],
                    capture_output=True, timeout=timeout, env=_TESSERACT_ENV)
            except FileNotFoundError as exc:
                raise OcrToolMissing("tesseract not installed") from exc
            except subprocess.TimeoutExpired:
                page_failures.append(
                    f"page {number}: tesseract timed out after {timeout}s")
                continue
            finally:
                # Hold one page image at a time, not the whole document.
                image.unlink(missing_ok=True)
            if done.returncode == 0:
                pages.append(done.stdout.decode("utf-8", errors="replace"))
            else:
                stderr = done.stderr.decode("utf-8", errors="replace").strip()
                page_failures.append(
                    f"page {number}: tesseract exited {done.returncode}: {stderr}")

    # A genuinely illegible scan still yields SOME pages (possibly with
    # little or no recognisable text) -- that case returns a string, as
    # before, and is scored honestly by the caller. Only when no page was
    # successfully read at all is this a tool failure rather than a
    # document-quality finding.
    if not pages:
        raise OcrRenderFailed(
            f"no page of {path} could be read: "
            + ("; ".join(page_failures) if page_failures
               else f"pdftoppm produced nothing for any of {total} page(s)"))
    return "\n\n".join(pages).strip()
