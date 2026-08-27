"""PDF of a cantonal edition -> articles + plain text.

Where the PDFs come from and why the layout is one layout: every Lexwork
host (19 cantons) renders `/api/{lang}/versions/{id}/pdf_file` with the same
engine, and lexfind.ch's `/tolv/{version}/{lang}` serves the same files for
the hosts it mirrors. Measured 2026-08-26 on 60 editions from 9 hosts (AI,
BE, BS, FR, GR de/it/rm, LU, SO, VS, ZG; scripts/pdf_gate.py) the page
grammar is identical everywhere:

    header   title-left + systematic-number-right (page 1: number only)
    body     "Art. 12 *     Marginal title" / "§ 3" at column 0, preceded by
             a blank line; paragraph numbers are superscripts, which
             pdftotext -layout puts on a line of their own ("1") directly
             above the paragraph's first line; enumerations "a)" / "1."
             indented; amendment marker "*" after a number or a paragraph
    footer   footnotes ("1)  BSG 2013/014"), "* Änderungstabellen am
             Schluss des Erlasses", page number alone on the last line
    tail     signature block, then "Änderungstabelle - Nach Beschluss" (the
             modification tables, fr "Tableau des modifications par ...",
             it "Tabella modifiche - Secondo ...", rm "Tabella da las
             modificaziuns - tenor ...") to the end

Extractor choice, measured on the same 60 files (word-level
SequenceMatcher against the HTML-parsed full_text of the same version):
pdftotext -layout 0.880 median, pdftotext raw 0.899, PyMuPDF 0.880,
pdfminer.six 0.846. The text layer is the same for all four; the gap to
1.0 is the header/footer/table furniture this module strips, not
extraction quality. -layout is chosen over raw because raw mode emits
enumerations out of reading order (the letters "a)" "b)" first, then all
their texts) and glues superscripts to the wrong paragraph, and over
PyMuPDF because poppler is already on the prod box (pdftotext 22.02) and
text_extract.from_pdf uses it for the decisions corpus: no new dependency.

What the split reproduces of the HTML parse (chpipe/lexwork.py): article
number, marginal note, the article's paragraphs as "1 text 2 text" (the
HTML text carries the paragraph number the same way), and an e_id in
Lexwork's uid convention ("t-0--t-2--t-2‐1--a-4" = article 4 under
heading 2.1 under heading 2) so diff_articles can key a PDF edition
against an HTML one of the same act. Footnote texts are dropped (the HTML
articles do not carry them either; the raw pdftotext output is kept in
akn_xml). Gate numbers per host live in scripts/pdf_gate.py.
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import tempfile
from dataclasses import dataclass

from . import akn
from .text_extract import PDFTOTEXT_TIMEOUT_SECONDS, PdfToolMissing

_WS = re.compile(r"\s+")

# "Art. 12a *   Marginal title", "Artikel 3", "§ 7", "Art. 1" -- column 0,
# the number may carry the platform's amendment star, the marginal title
# (when present) sits two or more spaces to the right. \s? not \s*: "Art.12"
# does not occur, and "§3" only inside the modification table.
_NOT_A_MARGINAL = (r"(?!(?:Abs|Absatz|Absätze|al|alinéa|cpv|capoverso|Ziff|Ziffer|Bst|Buchstabe|"
                   r"lit|let|lettre|para|Satz|und|et|e|bis|ff)\b\.?\s)")
# "Art. 1. Ziele" -- the number carries a dot on SO's concordats and
# foundation deeds of the 1960s-90s (38 of 389 article-less editions on
# 2026-08-27); "\.?" before the marginal admits it. Not "Art. 1.1": the
# dot must be followed by a space or the line end.
_HEADING = re.compile(
    r"^(?:Art\.|Artikel|Article|Articolo|Artitgel|§)\s?([A-Z]?\d+[a-zA-Z]*(?:-\d+[a-zA-Z]*)?)"
    r"\.?(?=[\s*]|$)\s?\*?(?:\s+" + _NOT_A_MARGINAL + r"(\S.*))?$")
# A heading centred on its own indented line ("§1", "Art. 2", "Art. 1
# Geltungsbereich" 20 spaces in): ZG's and AI's accession decrees and SG's
# older layout. Column 0 is not required here, so the rest of the line has
# to look like a marginal, not a citation's continuation ("Art. 45 Abs. 4
# KV kann daher ...", "Artikel 4 Absatz 5 der Verordnung", "Art. 24 FV92
# . . . ." in a table of contents).
_CENTRED_HEADING = re.compile(
    r"^\s{2,}(?:Art\.|Artikel|Article|Articolo|§)\s?([A-Z]?\d+[a-zA-Z]*)\.?(?=[\s*]|$)\s?\*?"
    r"(?:\s{2,}" + _NOT_A_MARGINAL +
    r"(?!(?:der|die|das|des|dem|den|du|de|la|le|les|della|del|dell|dal|KV|VV)\b)([^\d\s][^.]{0,70}))?\s*$")
# A marginal title in a left column, the article on the same line:
# "Gegenstand        § 1.   Die Gebühren, welche ..." (AR 88258, the
# ATIOZ fee regulation). The text after the number is the provision's
# first line, not the marginal; a paragraph number may open it inline.
_LEFT_COLUMN_HEADING = re.compile(
    r"^([^\s\d§][^§]{0,50}?)\s{2,}(?:§|Art\.)\s?(\d+[a-zA-Z]*)\.?\s+(\S.*)$")
_INLINE_PARAGRAPH = re.compile(r"^(\d{1,2})\s+(?=[A-ZÄÖÜ])")
# In the left-column layout a marginal that wraps puts its second word at
# column 0 of the next body line: "Allgemeine" / "Bestimmungen     sichts-".
_LEFT_COLUMN_CONTINUATION = re.compile(r"^([^\s\d§][^\s]{0,30}(?: [^\s\d]{1,30}){0,3})\s{3,}(\S.*)$")
# A page's last non-blank line, only digits: the page number.
# "3", or "-3-" / "- 3 -" on the pre-2015 conversions (VS 101.1 of 2008)
_PAGE_NUMBER = re.compile(r"^(?:\d{1,3}|-\s?\d{1,3}\s?-)$")
# A superscript paragraph number on a line of its own ("1", "2bis").
_PARAGRAPH_MARK = re.compile(r"^(\d{1,2}(?:bis|ter|quater|quinquies)?)\s*\*?$")
# A footnote's first line at the foot of a page: "1)  BSG 2013/014", "3)".
_FOOTNOTE_START = re.compile(r"^\d{1,3}\)(?:\s|$)")
# A footnote reference glued to the word it annotates: "Grischun1)," ->
# "Grischun,". Not "Abs. 2)": a space before the digit is a citation.
_FOOTNOTE_REF = re.compile(
    r"(?<=[^\W\d_\)\].,;:])\d{1,2}\)|(?<=\d{4})\d{1,2}\)|(?<=[^\W\d_])\d{1,2}(?=[\s,.;:]|$)"
    r"|(?<=\d{4}) \d{1,2}(?=[,.;:])|(?<=(?:19|20)\d{2})\d{1,2}(?=[,.;:)]|$)")
# The platform's amendment marker, on its own between spaces or at an end.
_STAR = re.compile(r"(?:(?<=\s)|^)\*(?=\s|$)|(?<=\S)\s?\*(?=\s|$)")
# The note pdftotext prints under page 1, in the four UI languages.
_TABLE_NOTE = re.compile(
    r"^\*\s.*(?:nderungs|modific|tabell)", re.IGNORECASE)
# First line of the modification tables; everything from here on is history,
# not text (the HTML parse reads it into ch_article_provenance instead).
# SO prefixes the title with the same star as its page-1 note ("* Änderungs-
# tabelle - Nach Beschluss"); the dash after the word tells the two apart.
_TABLE_TITLE = re.compile(
    r"^\s*\*?\s*(?:Änderungstabelle|Tableau(?:x)? des modifications|Tabella (?:delle )?modifiche|"
    r"Tabella da las modificaziuns)(?:\s*[-–]|\s+(?:par|nach|secondo|tenor)\b)", re.IGNORECASE)
# Systematic number on its own line ("110.200", "152", "10.1.11") -- the
# page header on page 1, and the right-hand half of the header elsewhere.
_SYSNR = re.compile(r"^(?:Nr\.\s*)?\d{1,4}(?:\.\d+)*[a-z]?(?:-[A-Z]\d*)?$")   # ZG "811.15-A1"
_LEADING_PAGE_NUMBER = re.compile(r"^\d{1,3}\s{2,}")
# LU prints the act's publication reference at the foot of every page:
# "G 2015 174", "G V 437 | Z I 159".
_LU_REFERENCE = re.compile(r"^[A-Z]{1,3}(?: [IVXL]+)? \d{1,4}(?:[ /]\d+)*(?: \| .*)?$")
# A section heading between articles: "2.1 Dommage causé", "1. Kapitel:
# Allgemeines", "I. Abschnitt". Column 0, one short block, and -- checked by
# the caller -- followed by an article or another heading.
_SECTION = re.compile(
    r"^((?:\d+[a-z]?(?:\.\d+[a-z]?)*\.?)|(?:[IVXL]+(?:bis|ter)?\.?)|(?:[A-Z]\d+))\s+(\S.*)$")
_SECTION_WORD = re.compile(
    r"^(?:Kapitel|Titel|Abschnitt|Teil|Unterabschnitt|Chapitre|Titre|Section|Partie|"
    r"Capitolo|Titolo|Sezione|Parte|Chapitel|Part|Secziun|Partiziun)\b:?", re.IGNORECASE)
# A hyphen at a line end that is a real compound, not a wrap: "Kantons-" +
# "und Gemeindesteuern" keeps the hyphen and the space.
_CONJUNCTION = re.compile(r"^(?:und|oder|bzw\.|sowie|et|ou|e|ed|o|od|u|ni)\b", re.IGNORECASE)
_HYPHEN_END = re.compile(r"\s?-$")


class PdfTextError(RuntimeError):
    pass


@dataclass(frozen=True)
class Extraction:
    raw_text: str
    articles: list[akn.Article]
    full_text: str


# ---------------------------------------------------------------------------
# pdftotext
# ---------------------------------------------------------------------------

def raw_text(path: pathlib.Path) -> str:
    """pdftotext -layout of a file. Raises PdfToolMissing without poppler and
    PdfTextError when poppler refuses the file (not a PDF, encrypted, timeout)
    -- unlike text_extract.from_pdf, which returns "" for the OCR stage to
    pick up: an edition's PDF with no text layer is a failure to record, not
    a document to OCR."""
    try:
        completed = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            capture_output=True, timeout=PDFTOTEXT_TIMEOUT_SECONDS)
    except FileNotFoundError as exc:
        raise PdfToolMissing("pdftotext not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise PdfTextError(f"pdftotext timed out after {PDFTOTEXT_TIMEOUT_SECONDS}s") from exc
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip().splitlines()
        raise PdfTextError(f"pdftotext exit {completed.returncode}: {detail[-1] if detail else ''}")
    text = completed.stdout.decode("utf-8", errors="replace")
    return text.replace("\x00", "")


def raw_text_of_bytes(data: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(data)
        tmp.flush()
        return raw_text(pathlib.Path(tmp.name))


# ---------------------------------------------------------------------------
# page furniture
# ---------------------------------------------------------------------------

def _key(line: str) -> str:
    return _WS.sub(" ", line).strip()


def _dedent(lines: list[str]) -> list[str]:
    """pdftotext -layout indents a whole page when something on it sits left
    of the text column (ZG 153.2 page 2: eight spaces on every line), and the
    column-0 rules below would then miss every heading on that page."""
    indents = [len(l) - len(l.lstrip(" ")) for l in lines if l.strip()]
    cut = min(indents) if indents else 0
    return [l[cut:] if l.strip() else "" for l in lines]


def _strip_footnotes(lines: list[str], next_bare: int | None) -> tuple[list[str], int | None]:
    """Drop the footnote block at the foot of a page: from the topmost
    "n)" line of the trailing region (footnote starts, their indented
    continuations, blanks) to the end. Anything above that line -- an
    enumeration that happens to be indented -- is left alone.

    `next_bare` is the number the next paren-less footnote must carry
    (LU numbers them through the whole act: 1-3 on page 1, 4-6 on page 2),
    or None on hosts that write "n)". Returns the lines and the updated
    counter."""
    i = len(lines)
    while i > 0:
        line = lines[i - 1]
        if (not line.strip() or _FOOTNOTE_START.match(line) or line.startswith("    ")
                or _PAGE_NUMBER.match(line.strip()) or line.startswith("* ")):
            i -= 1
            continue
        break
    for index in range(i, len(lines)):
        line = lines[index]
        if _FOOTNOTE_START.match(line):
            return lines[:index], next_bare
        # LU style: the footnote number is a bare superscript ("1") with the
        # note indented four spaces under it. Only on the host whose acts
        # are numbered "Nr. 185", and only for the number the act's footnote
        # sequence expects next: VS (and LU itself, SRL 228 § 20) indent a
        # paragraph's first line by four spaces too, and a one-line last
        # paragraph "1" at the foot of a page read as a footnote until the
        # counter said the next note is 4
        if (next_bare is not None and line.strip() == str(next_bare)
                and index + 1 < len(lines) and lines[index + 1].startswith("    ")):
            marks = [int(l.strip()) for l in lines[index:] if _PAGE_NUMBER.match(l.strip())]
            return lines[:index], (max(marks) + 1 if marks else next_bare)
    return lines, next_bare


def clean_pages(raw: str) -> list[list[str]]:
    """Pages of pdftotext -layout output with header, footer, page number,
    footnotes and the platform's table note removed, each page dedented.
    Header/footer detection is by repetition (a line among the first or
    last two of a page that recurs on another page) plus the systematic
    number learnt from page 1, so a one-page act loses its header too."""
    pages = [p.split("\n") for p in raw.split("\f")]
    pages = [[l.rstrip() for l in p] for p in pages]
    pages = [p for p in pages if any(l.strip() for l in p)]
    if not pages:
        return []
    # the page number is the last non-blank line when it is only digits
    for page in pages:
        while page and not page[-1].strip():
            page.pop()
        if page and _PAGE_NUMBER.match(page[-1].strip()):
            page.pop()
    sysnr = None
    first = next((l.strip() for l in pages[0] if l.strip()), "")
    first = _LEADING_PAGE_NUMBER.sub("", first)
    if _SYSNR.match(first):
        sysnr = first
    # lines seen in the head/foot zone of more than one page
    seen: dict[str, set[int]] = {}
    for index, page in enumerate(pages):
        nonblank = [l for l in page if l.strip()]
        for line in nonblank[:2] + nonblank[-2:]:
            seen.setdefault(_key(line), set()).add(index)
    repeated = {k for k, where in seen.items() if len(where) > 1}
    next_bare = 1 if sysnr and sysnr.startswith("Nr.") else None

    def is_furniture(line: str, zone: bool) -> bool:
        key = _key(line)
        if _TABLE_TITLE.match(line):
            return False
        if _TABLE_NOTE.match(line.strip()):
            return True
        if not zone:
            return False
        if (key in repeated and not _HEADING.match(key) and not _PARAGRAPH_MARK.match(key)
                and key.rstrip("*").rstrip()[-1:] not in ".;:,…"):
            # a running header/footer never ends a sentence; a body line
            # that happens to close two pages does
            return True
        if sysnr:
            # "3   Nr. 185", "Nr. 185   3", "101.2   6", "Titel   101.2"
            for bare in (re.sub(r"^\d{1,3} ", "", key), re.sub(r" \d{1,3}$", "", key)):
                if bare == sysnr or bare.endswith(" " + sysnr):
                    return True
        if _LU_REFERENCE.match(key):
            return True
        if key.startswith("-") and _PAGE_NUMBER.match(key):
            return True     # "-2-" at the top of a page (VS 2008 conversions)
        return bool(_SYSNR.match(key) and "." in key)

    cleaned: list[list[str]] = []
    for page in pages:
        nonblank_idx = [i for i, l in enumerate(page) if l.strip()]
        zone = set(nonblank_idx[:2] + nonblank_idx[-2:])
        kept = [l for i, l in enumerate(page) if not is_furniture(l, i in zone)]
        while kept and not kept[-1].strip():
            kept.pop()
        if kept and _PAGE_NUMBER.match(kept[-1].strip()):
            # AI prints the page number ABOVE its table note
            kept.pop()
        # dedent first: ZG indents a whole page (153.2 page 2, eight spaces)
        # and every line of it would otherwise read as a footnote continuation
        kept = _dedent(kept)
        kept, next_bare = _strip_footnotes(kept, next_bare)
        while kept and not kept[0].strip():
            kept.pop(0)
        while kept and not kept[-1].strip():
            kept.pop()
        if kept:
            cleaned.append(kept)
    return cleaned


# ---------------------------------------------------------------------------
# blocks -> articles
# ---------------------------------------------------------------------------

@dataclass
class _Block:
    lines: list[str]
    gap: int          # blank lines above it on the same page (0 at page top)


def _blocks(pages: list[list[str]]) -> list[_Block]:
    """Runs of non-blank lines. The modification tables end the document."""
    out: list[_Block] = []
    for page in pages:
        gap = 0
        current: list[str] | None = None
        for line in page:
            if _TABLE_TITLE.match(line):
                if current:
                    out.append(_Block(current, gap))
                return out
            if not line.strip():
                if current:
                    out.append(_Block(current, gap))
                    current = None
                    gap = 0
                gap += 1 if current is None else 0
                continue
            if current and _line_ends_block(current[-1]) and (
                    _HEADING.match(line) or _CENTRED_HEADING.match(line)
                    or _LEFT_COLUMN_HEADING.match(line)):
                # BE prints a section heading, a repealed "Art. 6 * ..." and
                # the next article on adjacent lines with no blank between
                out.append(_Block(current, gap))
                current = None
                gap = 0
            if current is None:
                current = []
            current.append(line)
        if current:
            out.append(_Block(current, gap))
    return out


def _line_ends_block(line: str) -> bool:
    """Can a heading start right under this line? Yes after a sentence end
    or a short line (a section heading, "Art. 6 * …"); not under a full
    wrapped line, where "§ 9 Absatz 1 Buchstabe c" at column 0 is the
    continuation of a citation (SO 101.6 was split there)."""
    text = line.strip()
    return (text[-1:] in ".:;…!?)*" or len(text) < 45
            or _SECTION.match(text) is not None or _HEADING.match(text) is not None)


def _join(lines: list[str]) -> str:
    """Lines of one paragraph -> one string, wrapped hyphens rejoined."""
    out = ""
    for line in lines:
        piece = line.strip()
        if not out:
            out = piece
            continue
        if _HYPHEN_END.search(out):
            head = _HYPHEN_END.sub("", out)
            if _CONJUNCTION.match(piece):
                out = head + "- " + piece
            elif piece[:1].isupper():
                out = head + "-" + piece
            else:
                out = head + piece
        else:
            out = out + " " + piece
    return _WS.sub(" ", out).strip()


def _tidy(text: str) -> str:
    text = _FOOTNOTE_REF.sub("", text)
    text = _STAR.sub("", text)
    return _WS.sub(" ", text).strip()


def _paragraphs(lines: list[str], inline_marks: bool = False) -> list[str]:
    """A prose block -> its paragraphs: a new one starts at each superscript
    number line, which is prefixed to the text that follows it the way the
    HTML text carries "1 Der Verlauf ...". In the left-column layout the
    number sits inline ("    2 Bei der Gebührenerhebung ...") and opens a
    paragraph too; that reading is switched on only for that layout, since
    "20 Prozent" can start a wrapped line anywhere else."""
    paragraphs: list[list[str]] = []
    pending_mark: str | None = None
    for line in lines:
        m = _PARAGRAPH_MARK.match(line.strip())
        if m:
            pending_mark = m.group(1)
            paragraphs.append([])
            continue
        if inline_marks and _INLINE_PARAGRAPH.match(line.strip()):
            paragraphs.append([])
        if not paragraphs:
            paragraphs.append([])
        if pending_mark is not None:
            paragraphs[-1].append(pending_mark + " " + line.strip())
            pending_mark = None
        else:
            paragraphs[-1].append(line)
    if pending_mark is not None:
        paragraphs[-1].append(pending_mark)
    return [_tidy(_join(p)) for p in paragraphs if p]


def _section_of(block: _Block) -> tuple[str, str] | None:
    """(number token, heading text) when the block is a section heading."""
    if len(block.lines) > 2 or sum(len(l) for l in block.lines) > 160:
        return None
    first = block.lines[0]
    if first.startswith(" ") or _PARAGRAPH_MARK.match(first.strip()):
        # a paragraph superscript at the top of a page is not a heading
        return None
    joined = _join(block.lines)
    if joined.rstrip("*").rstrip()[-1:] in ".;:,":
        # an enumeration item ("4. Bei Namensänderungen ... erhoben.") in a
        # block of its own, not a heading
        return None
    m = _SECTION.match(joined)
    if not m:
        word = _SECTION_WORD.match(first)
        if not word:
            return None
        return ("", _join(block.lines))
    number, rest = m.group(1), m.group(2)
    w = _SECTION_WORD.match(rest)
    if w:
        number = number + " " + w.group(0)
    return (number, _join(block.lines))


def _uid_token(number: str) -> str:
    """"2.1" -> "2‐1", "1. Kapitel:" -> "1‐‐Kapitel‐": Lexwork replaces every
    non-alphanumeric character of a heading's number with U+2010."""
    return re.sub(r"[^0-9A-Za-z]", "‐", number.strip())


def _numeric_parts(number: str) -> tuple[str, ...] | None:
    m = re.match(r"^(\d+(?:\.\d+)*)\.?$", number.strip())
    return tuple(m.group(1).split(".")) if m else None


class _Sections:
    """The open heading chain, for Lexwork-shaped e_ids."""

    def __init__(self) -> None:
        self.stack: list[tuple[tuple[str, ...] | None, str]] = []

    def push(self, number: str) -> None:
        parts = _numeric_parts(number.split(" ")[0])
        while self.stack:
            top_parts, _ = self.stack[-1]
            if parts and top_parts and len(top_parts) < len(parts) \
                    and parts[:len(top_parts)] == top_parts:
                break
            self.stack.pop()
        self.stack.append((parts, _uid_token(number) if number else "x"))

    def e_id(self, article_number: str) -> str:
        chain = "".join(f"--t-{token}" for _, token in self.stack)
        return f"t-0{chain}--a-{_uid_token(article_number)}"

    @property
    def parent(self) -> str | None:
        if not self.stack:
            return None
        return "t-0" + "".join(f"--t-{token}" for _, token in self.stack)


_CONTINUATION = re.compile(r"^(?:[a-z]\)|\d{1,2}\.\s|[-–•]\s|\s)")


def _continues_article(block: _Block) -> bool:
    """Does a block one blank line below an article's text still belong to
    it? Yes when it opens with a paragraph superscript, an enumeration item
    or an indented line; the enactment lines after the last article ("RRB
    Nr. 2020/1784 vom 7. Dezember 2020.") open with none of those."""
    first = block.lines[0]
    return bool(_PARAGRAPH_MARK.match(first.strip()) or _CONTINUATION.match(first))


def _int_prefix(number: str) -> int:
    m = re.search(r"\d+", number)
    return int(m.group(0)) if m else 0


def _in_order(number: str, last: int) -> bool:
    """Article numbers only go up within an act; a cited "Art. 5 Abs. 2" that
    happens to start a line after a blank one is not a heading. Annex
    articles ("A1-1") restart the count and are always accepted."""
    if number[:1].isalpha():
        return True
    return _int_prefix(number) >= last


def split_text(raw: str) -> tuple[list[akn.Article], str]:
    """pdftotext -layout output -> (articles, full_text). The offline half
    of extract(): what pdf_text_stage stores in akn_xml is `raw`, so a
    better split later never needs the PDF again."""
    blocks = _blocks(clean_pages(raw))
    sections = _Sections()
    articles: list[akn.Article] = []
    lines: list[str] = []
    current: dict | None = None
    seen_e_ids: set[str] = set()

    def close() -> None:
        nonlocal current
        if current is None:
            return
        e_id = current["e_id"]
        if e_id in seen_e_ids:
            suffix = 2
            while f"{e_id}-{suffix}" in seen_e_ids:
                suffix += 1
            e_id = f"{e_id}-{suffix}"
        seen_e_ids.add(e_id)
        articles.append(akn.Article(
            e_id=e_id,
            article_number=akn.normalise_number(current["number"]),
            marginal_note=current["marginal"] or None,
            text=" ".join(current["paragraphs"]).strip(),
            ordinal=len(articles),
            parent_e_id=current["parent"]))
        current = None

    last_number = 0
    left_column = False
    for index, block in enumerate(blocks):
        if not block.lines:
            continue        # a marginal title consumed by the heading before it
        first = block.lines[0]
        heading = _HEADING.match(first)
        shape = "plain"
        if not heading:
            heading = _CENTRED_HEADING.match(first)
            shape = "centred"
            if heading is None and (index == 0 or _line_ends_block(blocks[index - 1].lines[-1])
                                    if blocks[index - 1].lines else True):
                heading = _LEFT_COLUMN_HEADING.match(first)
                shape = "left"
        number = heading.group(2 if shape == "left" else 1) if heading else ""
        if heading and _in_order(number, last_number):
            close()
            last_number = _int_prefix(number)
            if shape == "left":
                left_column = True
                marginal_lines = [heading.group(1)]
                block.lines[0] = "  " + heading.group(3)
                body_start = 0
            else:
                marginal_lines = [heading.group(2) or ""]
                body_start = 1
            if left_column:
                # the wrapped marginal's further words sit at column 0 of
                # the body lines that follow
                for i in range(body_start, len(block.lines)):
                    m = _LEFT_COLUMN_CONTINUATION.match(block.lines[i])
                    if m and not _HEADING.match(block.lines[i]):
                        marginal_lines.append(m.group(1))
                        block.lines[i] = "  " + m.group(2)
            if shape == "centred" and not heading.group(2) and body_start < len(block.lines):
                # the marginal on the next centred line ("§1" / "Beitrittserklärung")
                nxt = block.lines[body_start]
                if (nxt.startswith("        ") and len(nxt.strip()) < 80
                        and nxt.strip()[-1:] not in ".;:," and not _PARAGRAPH_MARK.match(nxt.strip())):
                    marginal_lines = [nxt]
                    body_start += 1
            # a marginal title wrapped onto the next line sits in its column
            while (shape == "plain" and heading.group(2) and heading.group(2) != "…"
                   and body_start < min(len(block.lines), 3)
                   and (block.lines[body_start].startswith("      ")
                        or (not block.lines[body_start].startswith(" ")
                            # BE wraps a long marginal onto a short column-0
                            # line; SO 111.53's body starts at column 0 too,
                            # but with a full-width line
                            and (len(block.lines[body_start].strip()) < 50
                                 or marginal_lines[-1].rstrip().endswith("-"))))
                   and not _PARAGRAPH_MARK.match(block.lines[body_start].strip())):
                marginal_lines.append(block.lines[body_start])
                body_start += 1
            marginal = _tidy(_join(marginal_lines))
            following = blocks[index + 1] if index + 1 < len(blocks) else None
            if (not marginal and len(block.lines) == 1 and following is not None
                    and following.gap == 1 and following.lines
                    and (len(following.lines) == 1
                         or _PARAGRAPH_MARK.match(following.lines[1].strip()))
                    and len(following.lines[0]) < 80
                    and not following.lines[0].startswith(" ")
                    and not _PARAGRAPH_MARK.match(following.lines[0].strip())
                    and not _CONTINUATION.match(following.lines[0])
                    and not _HEADING.match(following.lines[0])
                    and _section_of(following) is None):
                # the 2000-era BE conversions put the marginal title on a
                # line of its own under a blank ("Art. 1", "", "Gegenstand")
                marginal = _tidy(following.lines[0])
                following.lines = following.lines[1:]
            current = {"number": number, "marginal": marginal,
                       "e_id": sections.e_id(number), "parent": sections.parent,
                       "paragraphs": _paragraphs(block.lines[body_start:], left_column)}
            label = block.lines[0].split()[0]
            title = f"{label} {number}" + (f" {marginal}" if marginal else "")
            lines.append(title)
            lines.extend(current["paragraphs"])
            continue
        section = _section_of(block)
        following = blocks[index + 1] if index + 1 < len(blocks) else None
        follows_heading = following is not None and (
            bool(_HEADING.match(following.lines[0])) or _section_of(following) is not None)
        if section and (follows_heading or current is None):
            close()
            sections.push(section[0])
            lines.append(_tidy(section[1]))
            continue
        if current is not None and block.gap >= 1 and not _continues_article(block) \
                and not any(_HEADING.match(b.lines[0]) for b in blocks[index + 1:]):
            # the signature block after the last article, an annex: not
            # part of the provision
            close()
        paragraphs = _paragraphs(block.lines, left_column)
        if current is not None:
            current["paragraphs"].extend(paragraphs)
        lines.extend(paragraphs)
    close()
    return articles, "\n".join(l for l in lines if l)


def extract(path: pathlib.Path) -> Extraction:
    raw = raw_text(path)
    articles, full_text = split_text(raw)
    return Extraction(raw, articles, full_text)


def extract_bytes(data: bytes) -> Extraction:
    raw = raw_text_of_bytes(data)
    articles, full_text = split_text(raw)
    return Extraction(raw, articles, full_text)
