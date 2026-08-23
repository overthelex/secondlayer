"""HTML and PDF to plain text.

pdftotext -layout is used rather than a Python PDF library because it is already
on the prod box, it is an order of magnitude faster, and -layout keeps the
two-column judgment layouts that Swiss courts use from interleaving.
"""
from __future__ import annotations

import pathlib
import subprocess
import unicodedata

from lxml import etree, html as lxml_html

PDFTOTEXT_TIMEOUT_SECONDS = 120

# Block-level tags after which we force a line break. lxml's text_content()
# just concatenates text nodes with no separator, so two adjacent <p> tags
# collapse into one run-on line unless we inject the break ourselves.
_BLOCK_TAGS = frozenset({
    "p", "div", "li", "tr", "table", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6",
})

# Void elements have no content of their own, so `.tail` is the text that
# FOLLOWS them, not text they contain. Appending "\n" to that tail (as we do
# for container tags) pushes the break past the run it should precede, which
# both drops the break before the void element and misplaces it one run late.
# entscheidsuche HTML leans on <br> heavily for party blocks and case
# captions ("Beschwerdefuehrer:<br>Herr Mueller<br>Zug"), so the separator
# must be inserted at the FRONT of the tail instead.
_VOID_BLOCK_TAGS = frozenset({"br"})


class PdfToolMissing(RuntimeError):
    pass


def _strip_control_characters(text: str) -> str:
    """Drop NUL and other C0/C1 control characters from decoded pdftotext
    output, keeping \n, \r and \t.

    decode(..., errors="replace") only fixes invalid UTF-8 byte sequences --
    a genuine NUL byte, or any other Unicode Cc control character, is valid
    UTF-8 on its own and passes straight through undecoded. Postgres text
    columns reject NUL outright (DataError), so a broken-CMap PDF whose junk
    text layer happens to clear the quality gate could otherwise take down
    the whole batch on the write, not the extraction. Text that needed these
    bytes stripped was not usable text to begin with -- text_quality.score
    still judges what remains after they are gone.
    """
    return "".join(
        c for c in text
        if c in "\n\r\t" or unicodedata.category(c) != "Cc"
    )


def from_html(payload: bytes) -> str:
    """Text of an HTML document, with block-level breaks preserved."""
    if not payload.strip():
        return ""
    try:
        tree = lxml_html.fromstring(payload)
    except etree.ParserError:
        return ""
    for bad in tree.xpath("//script | //style | //head/comment()"):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    for el in tree.iter():
        if el.tag in _BLOCK_TAGS:
            el.tail = (el.tail or "") + "\n"
        elif el.tag in _VOID_BLOCK_TAGS:
            el.tail = "\n" + (el.tail or "")
    text = tree.text_content()
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def from_pdf(path: pathlib.Path) -> str:
    """Text layer of a PDF. Empty string means there is no usable text layer,
    which is the signal for the OCR stage — not an error."""
    if not path.exists():
        raise FileNotFoundError(path)
    try:
        completed = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            capture_output=True, timeout=PDFTOTEXT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise PdfToolMissing("pdftotext not installed") from exc
    except subprocess.TimeoutExpired:
        return ""
    if completed.returncode != 0:
        return ""
    text = completed.stdout.decode("utf-8", errors="replace")
    return _strip_control_characters(text).strip()
