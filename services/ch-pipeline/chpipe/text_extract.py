"""HTML and PDF to plain text.

pdftotext -layout is used rather than a Python PDF library because it is already
on the prod box, it is an order of magnitude faster, and -layout keeps the
two-column judgment layouts that Swiss courts use from interleaving.
"""
from __future__ import annotations

import pathlib
import subprocess

from lxml import etree, html as lxml_html

PDFTOTEXT_TIMEOUT_SECONDS = 120

# Block-level tags after which we force a line break. lxml's text_content()
# just concatenates text nodes with no separator, so two adjacent <p> tags
# collapse into one run-on line unless we inject the break ourselves.
_BLOCK_TAGS = frozenset({
    "p", "div", "br", "li", "tr", "table", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6",
})


class PdfToolMissing(RuntimeError):
    pass


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
    return completed.stdout.decode("utf-8", errors="replace").strip()
