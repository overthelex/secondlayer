"""HTML and PDF to plain text.

pdftotext -layout is used rather than a Python PDF library because it is already
on the prod box, it is an order of magnitude faster, and -layout keeps the
two-column judgment layouts that Swiss courts use from interleaving.
"""
from __future__ import annotations

import codecs
import pathlib
import re
import subprocess
import unicodedata

from lxml import etree, html as lxml_html

PDFTOTEXT_TIMEOUT_SECONDS = 120

# Raw HTML bodies are transcoded to UTF-8 by fetch_stage.write_body() before
# they ever reach the disk, so every file this module reads is UTF-8 by
# construction. The parser is therefore pinned to UTF-8 rather than left to
# sniff, and that pin is the whole point:
#
#   lxml_html.fromstring(bytes) with no declared charset falls back to
#   ISO-8859-1, which turns 'Eidgenössisches ... Beschwerdeführer' into
#   'EidgenÃ¶ssisches ... BeschwerdefÃ¼hrer' -- exactly the damage that put
#   165,363 CH_BGer rows into this pipeline in the first place. Measured, the
#   quality score cannot catch it (clean 0.9820 vs mojibake 0.9850 on the
#   real CH_BGE fixture), because mojibake is all-alpha, correctly
#   word-lengthed and carries no U+FFFD.
#
# An explicit encoding also overrides any in-document declaration -- a stale
# `<meta charset=iso-8859-1>` surviving inside an already-transcoded body,
# an `http-equiv` Content-Type, or an XML declaration -- all three verified
# against lxml 5.4.0. Handing lxml a `str` instead would work for the first
# two but raises ValueError on the third, so bytes plus a pinned parser is
# the form that covers every case.
_HTML_PARSER = lxml_html.HTMLParser(encoding="utf-8")

_META_CHARSET = re.compile(
    rb"""<meta[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_.:+-]+)""", re.IGNORECASE)
_XML_ENCODING = re.compile(
    rb"""<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9_.:+-]+)["']""", re.IGNORECASE)
# Only the first chunk of a document may carry a declaration; HTML5 mandates
# the first 1024 bytes, and scanning the whole body of a 30 KB judgment for a
# meta tag that is legally required to be near the top buys nothing.
_DECLARATION_WINDOW = 2048

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


def _usable_codec(name: str | None) -> str | None:
    if not name:
        return None
    try:
        return codecs.lookup(name).name
    except (LookupError, ValueError):
        return None


def charset_from_headers(content_type: str | None) -> str | None:
    """The charset parameter of an HTTP Content-Type header, if it has one.

    Measured against entscheidsuche on 2026-08-23: the document endpoints
    answer `Content-Type: text/html` with NO charset parameter, while the
    directory listings answer `text/html;charset=UTF-8`. So the header is
    authoritative when present but is usually absent for the bodies we
    actually parse -- which is why declared_charset() falls through to the
    in-document declaration rather than trusting the header alone.
    """
    if not content_type:
        return None
    for part in content_type.split(";")[1:]:
        key, _, value = part.partition("=")
        if key.strip().lower() == "charset":
            return _usable_codec(value.strip().strip('"\''))
    return None


def declared_charset(payload: bytes, content_type: str | None = None) -> str | None:
    """The encoding this document says it is, or None if it never said.

    Order of authority: the HTTP Content-Type header, then the document's own
    `<meta charset>` / `<meta http-equiv>` / XML declaration. Never guessed --
    a None here means nobody declared anything, and decode_html() falls back
    to UTF-8 on its own terms rather than pretending a declaration existed.
    """
    from_header = charset_from_headers(content_type)
    if from_header:
        return from_header
    head = payload[:_DECLARATION_WINDOW]
    for pattern in (_META_CHARSET, _XML_ENCODING):
        match = pattern.search(head)
        if match:
            name = _usable_codec(match.group(1).decode("ascii", errors="replace"))
            if name:
                return name
    return None


def decode_html(payload: bytes, content_type: str | None = None) -> str:
    """Bytes -> str using what the response and the document actually declared.

    This is the only place in the pipeline that decides an HTML document's
    encoding, and it runs at FETCH time, while the HTTP headers still exist.
    Once fetch_stage has written the body it is UTF-8 on disk and the
    question never comes up again.

    Fallback order when nothing is declared: UTF-8 strict (the overwhelming
    majority, and the one encoding whose multi-byte structure makes a wrong
    guess detectable), then cp1252, which is a superset of ISO-8859-1 and
    decodes every byte. Never lxml's silent ISO-8859-1 fallback, which is
    what produced the mojibake this pipeline exists to repair.
    """
    declared = declared_charset(payload, content_type)
    if declared:
        try:
            return payload.decode(declared)
        except (UnicodeDecodeError, LookupError):
            pass
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return payload.decode("cp1252", errors="replace")


def to_utf8(payload: bytes, content_type: str | None = None) -> bytes:
    """An HTML body re-encoded as UTF-8, so the file on disk is self-describing.

    A resumed run reads the file with no HTTP response to consult, so the
    charset has to survive on disk somehow. Transcoding is chosen over a
    sidecar charset file (an extra 800,000 inodes, and a body whose sidecar
    is missing is undecodable) and over a database column (a row whose file
    was written by a different run would disagree with it). After this, the
    body's own encoding IS UTF-8, which is what from_html() assumes.
    """
    return decode_html(payload, content_type).encode("utf-8")


def from_html(payload: bytes) -> str:
    """Text of an HTML document, with block-level breaks preserved.

    `payload` must be UTF-8 -- fetch_stage guarantees that for everything it
    writes. Bytes that are not valid UTF-8 are decoded with replacement
    characters, which text_quality scores down rather than silently
    accepting; that is deliberate, because a body that is not UTF-8 here did
    not come through the fetch stage.
    """
    if not payload.strip():
        return ""
    try:
        tree = lxml_html.fromstring(payload, parser=_HTML_PARSER)
    except (etree.ParserError, ValueError):
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
