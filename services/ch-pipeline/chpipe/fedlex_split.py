"""Stored pdftotext output of a Fedlex pdf-a edition -> articles.

Why a sibling of pdf_text.py rather than more gates inside it: the input is
not the same shape. fedlex_pdf_text_stage stored text_extract.from_pdf()'s
output, whose control-character strip removes the form feeds pdftotext
prints between pages -- so clean_pages()'s whole page model (header/footer
zones, per-page footnote strip) has nothing to split on. Page furniture has
to be recognised INSIDE one stream: the running header that opens every
page after the first (the act title and the SR number on one line), the
folio that closes every page (a bare number at column 0 on even printed
pages, a right-aligned one on odd), and the footnote block above the folio
(Fedlex numbers footnotes "9   text" with no parenthesis, plus the "AS 1952
1087" publication line). The heading grammar differs too, measured
2026-08-31 on 63 (act, lang) pairs that exist both as pdf-a and as AKN
(scripts/fedlex_pdf_gate.py -- the gate numbers live there):

  col0 layout (56/63)  "Art. 6" at column 0, marginal title two or more
                       spaces to the right on the same line; paragraph
                       numbers inline ("1 Alle Schweizer sind ...")
  marginal-column      the whole body indented to one column ("Art. 25" at
  layout (7/63)        column ~16-20), marginal titles in the left column
                       across several lines ("A. Arrondisse-" / "ments de
                       pour-" ...); post-1997 consolidations
  Roman articles       treaties number "Art. I", "Art. V" -- no arabic
                       digits, so akn.normalise_number() yields None, the
                       same as the AKN parse of the same acts (e_id art_I)
  glued footnotes      the PDF's superscript footnote references survive
                       pdftotext GLUED to the number: "Art. 25" is article
                       2 with footnote 5, "Art. 12" article 1 with footnote
                       2 -- only the article sequence disambiguates
  ranges               "Art. 2–311" is the repealed range 2-3, footnote 11

What pdf_text.py knows that still applies is imported, not copied: the
hyphen-rejoining line join, the Article shape, the number normaliser.

split_fedlex_text() returns (articles, text) like pdf_text.split_text();
the caller (fedlex_pdf_text_stage's resplit mode) stores only the articles
and leaves the row's full_text exactly as the 2026-08 backfill wrote it.
"""
from __future__ import annotations

import re

from . import akn
from .pdf_text import _join

_WS = re.compile(r"\s+")

# The SR number learnt from the head of the document: "0.515.21", "281.1",
# "101", "141.0", "0.946.293.212" -- with or without a trailing lowercase
# letter. A bare 1-4 digit group alone is accepted only with a dot somewhere
# OR when it stands right-aligned at the top (the SR of a pre-1999 act is
# dotless: "101").
_SYSNR = re.compile(r"^\d{1,4}(?:\.\d{1,3})*[a-z]?$")

# Folio: a bare page number at column 0 (even printed pages) or right-
# aligned (odd pages, pdftotext keeps the indent).
_FOLIO = re.compile(r"^\d{1,4}$")
_FOLIO_RIGHT = re.compile(r"^\s{8,}\d{1,4}$")

# A Fedlex footnote's first line: number at column 0, two or more spaces,
# text ("9    Term in accordance with ..."). The two-space minimum is what
# tells it from an inline paragraph number ("1 Alle Schweizer sind ..."),
# which Fedlex glues with exactly one space.
_FOOTNOTE_START = re.compile(r"^\d{1,3}\s{2,}\S")
# The publication line above footnote 1: "AS 1952 1087", "RO 11 488 et
# RS 3 3", "BS 11 469: BBl 1909 I 1", "CS 11 252", "RU 2005 4097".
_PUBLICATION = re.compile(r"^(?:AS|BS|BBl|RO|RS|CS|RU|FF)\s+\d")

# Article heading token after "Art. "/"Artikel "/"Article "/"Articolo ":
#   arabic with optional letter suffix and glued footnote digits: 1, 12, 4a8
#   a dash range (repealed together): 2–311
#   roman (treaties): I, V5, XII
#   first-article words: premier (fr)
_LABEL = r"(?:Art\.|Artikel|Article|Articolo|Artitgel)"
_ONE = r"\d+(?:\.\d+)?[a-z]{0,10}\d{0,3}"
# a run: dash, or the language's "to" ("Art. 91 a 94", "Art. 4 à 6"); a
# pair: the language's "and" ("Art. 15 et 16", "Art. 45 und 46")
_TOKEN = (r"(?:" + _ONE + r"(?:\s?[-–—]\s?" + _ONE + r"|\s(?:à|a|et|und|e|and)\s" + _ONE + r")?"
          r"|[IVXLCDM]+\d{0,3}|premier|1er)")
# After the token, one of: a footnote reference the PDF set a space away
# ("Art. 133 215"), a repeal ellipsis ("Art. 119 ..."), then optionally the
# marginal title two or more spaces to the right.
_HEADING = re.compile(
    r"^(\s*)" + _LABEL + r"\s+(" + _TOKEN + r")(?=[\s.,]|$)\.?"
    r"(?:\s(?:\d{1,3}|…|\.\.\.))?"
    r"(?:\s\s+(\S.*?))?\s*$")
# A citation, not a heading: "Art. 45 Abs. 4 KV kann ...", "Article 4,
# paragraphe 5" -- the token is followed by a reference word.
_CITATION_TAIL = re.compile(
    r"^(?:Abs|Absatz|Absätze|al|alinéa|cpv|capoverso|Ziff|Ziffer|Bst|Buchstabe|lit|let|"
    r"lettre|para|paragraph|Satz|und|et|e(?:d)?|o(?:d)?)\b\.?(\s|$)", re.IGNORECASE)
# A table-of-contents line: the heading is followed by dot leaders.
_TOC_TAIL = re.compile(r"(?:\.\s){3,}|\.{4,}")

_ROMAN = re.compile(r"^[IVXLCDM]+$")
_ARABIC = re.compile(r"^(\d+)([a-z]{0,10})$")
# The letter suffixes an article number actually carries: one letter
# ("39a" ... "39k") or a Latin ordinal ("1bis", "20quinquies").
_NUMBER_SUFFIXES = re.compile(
    r"^(?:[a-z]|bis|ter|quater|quinquies|sexies|septies|octies|novies|decies|"
    r"undecies|duodecies|terdecies|quaterdecies|quindecies)$")

# A structural line that ends the article run: an annex, the in-force date
# line, a treaty's attestation formula, a signature place-and-date.
_TAIL_BREAK = re.compile(
    r"^\s*(?:Anhang|Anhänge|Annexe|Annexes|Allegato|Allegati|Appendix|Annex\b|"
    r"Datum des Inkrafttretens|Date de l'entrée en vigueur|Data dell'entrata in vigore|"
    r"Zu Urkund dessen|En foi de quoi|In fede di che|In witness whereof|"
    r"Geschehen zu|Fait à|Fatto a|Done at|Unterschriften|Signatures?|Firme)\b")

# A section heading between articles: "I. Kapitel:", "Erster Abschnitt:",
# "Zweiter Titel:", "Titre premier:", "Capo I", "Chapter 2", "A. Acquisition
# by Law". Only consulted for SHORT lines, so the word list can be loose.
_SECTION_WORD = re.compile(
    r"(?:Kapitel|Abschnitt|Titel|Teil|Chapitre|Titre|Section|Partie|Capitolo|Capo|"
    r"Titolo|Sezione|Parte|Chapter|Title|Part)\b", re.IGNORECASE)
_SECTION_NUM = re.compile(r"^\s*(?:[IVXLCDM]+|[A-Z]|\d+(?:\.\d+)*)[.):]\s+\S")

# A glued footnote reference inside running text: "faillite4", "SCA)1",
# "Constitution2,3", "19514" (the year 1951 + footnote 4), "…14". Digits
# after a lowercase letter, a closing bracket/quote, an ellipsis or a
# four-digit year, optionally a comma-chain, at a word end.
_NOTE_REF = re.compile(
    r"(?:(?<=[a-zäöüéèàûîçñ»›\"'\)\]…])|(?<=[a-zäöüéèàûîçñ]\.)|(?<=(?:19|20)\d{2}))"
    r"(\d{1,2})(?:,\s?\d{1,2})*(?=[\s.,;:)\]]|$)")


def _strip_note_refs(text: str) -> str:
    return _NOTE_REF.sub("", text)


def _tidy(text: str) -> str:
    return _WS.sub(" ", _strip_note_refs(text)).strip()


def _find_sysnr(lines: list[str]) -> str | None:
    """The SR number printed at the top of page 1: within the first four
    non-blank lines, either right-aligned or alone at column 0."""
    seen = 0
    for line in lines:
        if not line.strip():
            continue
        seen += 1
        candidate = line.strip()
        if _SYSNR.match(candidate) and ("." in candidate or line.startswith(" ")
                                        or seen == 1):
            return candidate
        if seen >= 4:
            break
    return None


def _is_running_header(line: str, sysnr: str) -> bool:
    """Every page after the first opens with title + SR number on one line
    ("281.1   Poursuite pour dettes et faillite", "Swiss Citizenship
    Act   141.0") or the SR number alone."""
    key = _WS.sub(" ", line).strip()
    if key == sysnr:
        return True
    if key.startswith(sysnr + " ") or key.endswith(" " + sysnr):
        # a real gap, not a sentence that happens to end with the number
        stripped = line.strip()
        if stripped.startswith(sysnr):
            rest = stripped[len(sysnr):]
        else:
            rest = stripped[:-len(sysnr)]
        return rest.startswith("  ") or rest.endswith("  ")
    return False


def _strip_page_furniture(lines: list[str]) -> list[str]:
    """Remove running headers, folios and footnote blocks from the single
    stream. Pages are reconstructed at the running-header lines (the only
    page boundary that survived the form-feed strip); each page then loses
    its trailing folio and the footnote block above it."""
    sysnr = _find_sysnr(lines[:8])
    pages: list[list[str]] = [[]]
    for index, line in enumerate(lines):
        if sysnr and index > 0 and _is_running_header(line, sysnr):
            pages.append([])
            continue                    # the header line itself is furniture
        pages[0 if len(pages) == 1 else -1].append(line)
    out: list[str] = []
    for page in pages:
        while page and not page[-1].strip():
            page.pop()
        if page and (_FOLIO.match(page[-1]) or _FOLIO_RIGHT.match(page[-1])):
            page.pop()
        page = _strip_footnote_block(page)
        while page and not page[-1].strip():
            page.pop()
        out.extend(page)
        out.append("")                  # keep a block boundary at the seam
    # page-1 head: drop the SR number line itself
    if sysnr:
        out = [l for i, l in enumerate(out[:6]) if l.strip() != sysnr] + out[6:]
    return out


def _strip_footnote_block(page: list[str]) -> list[str]:
    """Cut the footnote block at the foot of a reconstructed page: from the
    topmost footnote-start (or publication) line of the trailing region --
    footnote starts, their indented continuations (2-8 spaces: less than
    any body column of the marginal layout, more than column 0), blanks --
    to the end."""
    cut = None
    for index in range(len(page) - 1, -1, -1):
        line = page[index]
        if not line.strip():
            continue
        if _FOOTNOTE_START.match(line) or _PUBLICATION.match(line):
            cut = index
            continue
        indent = len(line) - len(line.lstrip(" "))
        if 2 <= indent <= 8:
            # possibly a continuation of the footnote start ABOVE it (the
            # scan runs bottom-up, so continuations come first); only a
            # start line found later confirms the cut
            continue
        break
    return page[:cut] if cut is not None else page


def _resolve_number(token: str, last: int) -> tuple[str, int] | None:
    """The article number the heading token means, with any glued footnote
    reference removed, or None when no reading continues the sequence.

    "12" after article 1 reads as 1 + footnote 2 (expected next = 2, and 12
    is not it) but after article 11 as article 12. Preference order: the
    reading equal to last+1; then the same number again (an "Art. 6a" run);
    then the smallest forward jump. Roman tokens: trailing digits are
    always a footnote reference (Roman numbers carry none of their own).
    Returns (token to store, integer value for the sequence)."""
    if token in ("premier", "1er"):
        return ("1", 1) if last <= 1 else None
    if _ROMAN.match(token.rstrip("0123456789")) and not token[0].isdigit():
        return (token.rstrip("0123456789"), last)          # sequence not arabic
    range_match = re.match(r"^(.+?)(?:\s?[-–—]\s?|\s[àa]\s)(.+)$", token)
    if range_match:
        left = _resolve_number(range_match.group(1), last)
        if left is None:
            return None
        right = _resolve_number(range_match.group(2), left[1])
        if right is None or right[1] < left[1]:
            return None
        # one combined article, the way Fedlex's own AKN numbers a
        # together-repealed run (art_21_23, article_number "21-23")
        return (f"{left[0]}-{right[0]}", right[1])
    pair_match = re.match(r"^(.+?)\s(?:et|und|e|and)\s(.+)$", token)
    if pair_match:
        left = _resolve_number(pair_match.group(1), last)
        if left is None:
            return None
        right = _resolve_number(pair_match.group(2), left[1])
        if right is None or right[1] < left[1]:
            return None
        # "Art. 15 et 16": two articles repealed together; the caller emits
        # one per number, so hand back the pair joined with "+"
        return (f"{left[0]}+{right[0]}", right[1])
    decimal = re.match(r"^(\d+)\.(\d+)$", token)
    if decimal:
        # "0.01", "1.14": the part-dot-article numbering of the technical
        # ordinances; the sequence value is the integer part
        return (token, int(decimal.group(1)))
    tail = re.match(r"^(\d+)([a-z]{1,10})(\d{0,3})$", token)
    if tail and not _NUMBER_SUFFIXES.match(tail.group(2)):
        return None                                        # "Art. 3d)" junk shapes
    candidates: list[tuple[str, int]] = []
    if tail:
        digits, suffix, glued = tail.group(1), tail.group(2), tail.group(3)
        if glued:
            # "1bis5", "30bis97", "4a8": the letters end the article number,
            # so every trailing digit is a footnote reference
            candidates.append((digits + suffix, int(digits)))
        else:
            candidates.append((digits + suffix, int(digits)))
    else:
        m = _ARABIC.match(token)
        if not m or m.group(2):
            return None
        digits = m.group(1)
        # candidate readings: as printed, then with 1-3 trailing digits
        # peeled off as a glued footnote reference ("Art. 12" is article 1
        # + note 2 when the sequence stands at 0, article 12 after 11;
        # "Art. 33103" is article 33 + note 103)
        candidates.append((digits, int(digits)))
        for peel in (1, 2, 3):
            if len(digits) > peel:
                candidates.append((digits[:-peel], int(digits[:-peel])))
    best: tuple[str, int] | None = None
    for text, value in candidates:
        if value == last + 1:
            return (text, value)
    for text, value in candidates:
        # same integer, new suffix: the "Art. 30" -> "Art. 30bis" step. A
        # PURE digit reading equal to last would duplicate the previous
        # article outright, which no act does -- prefer a forward jump.
        if value == last and not text.isdigit():
            return (text, value)
    for text, value in candidates:
        if value > last and (best is None or value < best[1]):
            best = (text, value)
    return best


def _e_id(number: str, seen: dict[str, int]) -> str:
    """Fedlex's own convention, so the resplit rows key like AKN rows:
    art_1, art_1_a (for 1a), art_I; a repeat gets #2, #3 like
    akn._articles_of."""
    m = re.match(r"^(\d+)([a-z]+)$", number)
    base = (f"art_{m.group(1)}_{m.group(2)}" if m
            else "art_" + re.sub(r"[^0-9A-Za-z]", "_", number))
    count = seen.get(base, 0) + 1
    seen[base] = count
    return base if count == 1 else f"{base}#{count}"


def _is_section(line: str) -> bool:
    text = line.strip()
    if not text or len(text) > 90:
        return False
    if _SECTION_NUM.match(text) and (_SECTION_WORD.search(text) or len(text) < 60):
        return True
    return bool(_SECTION_WORD.search(text.split(":")[0]) and len(text.split()) <= 6)


def _margin_continues(last_fragment: str) -> bool:
    """Is a wrapped marginal title still open after this fragment? Yes on a
    hyphenated break ("A. Arrondisse-") and after a short lowercase function
    word ("Offices des", "suite et de"); a completed noun ends it."""
    fragment = last_fragment.rstrip()
    if not fragment:
        return False
    if fragment.endswith("-"):
        return True
    word = fragment.split()[-1]
    return word.islower() and len(word) <= 4


def split_fedlex_text(raw: str) -> tuple[list[akn.Article], str]:
    """Stored fedlex_pdf full_text -> (articles, text). The text return is
    the article run re-joined (headings + prose); the caller keeps the
    stored full_text and discards it -- it exists so tests and the gate can
    see what the splitter read."""
    lines = _strip_page_furniture(raw.splitlines())

    # layout: where do the headings sit? Column 0, or one indented body
    # column with a marginal column to its left?
    heading_indents = [len(m.group(1)) for l in lines
                       if (m := _HEADING.match(l)) and not _TOC_TAIL.search(l)]
    marginal_layout = (len(heading_indents) >= 2
                       and min(heading_indents) >= 8)
    body_col = min(heading_indents) if marginal_layout else 0

    articles: list[akn.Article] = []
    seen: dict[str, int] = {}
    text_lines: list[str] = []
    current: dict | None = None
    last_number = 0
    pending_blank = False

    def close() -> None:
        nonlocal current
        if current is None:
            return
        body = _tidy(_join(current["body"]))
        marginal = _tidy(_join(current["margin"]))
        # "15+16" (an "Art. 15 et 16" repeal): one article per number, the
        # shared body (usually empty or "...") on each. An integer range
        # ("Art. 47 à 64", "Art. 21-23") expands the same way -- Fedlex's
        # own AKN mostly numbers the repealed run one article per number,
        # and per-number rows are what ch_get_act_article can reach.
        numbers = current["number"].split("+")
        range_match = re.match(r"^(\d+)-(\d+)$", current["number"])
        if range_match:
            low, high = int(range_match.group(1)), int(range_match.group(2))
            if low < high <= low + 60:
                numbers = [str(n) for n in range(low, high + 1)]
        for number in numbers:
            articles.append(akn.Article(
                e_id=_e_id(number, seen),
                article_number=(number if "." in number
                                else akn.normalise_number("Art. " + number)),
                marginal_note=marginal or None,
                text=body,
                ordinal=len(articles),
                parent_e_id=None))
        if body:
            text_lines.append(body)
        current = None

    for line in lines:
        if not line.strip():
            pending_blank = True
            continue
        if marginal_layout:
            left, body_part = line[:body_col].rstrip(), line[body_col - 1:]
            # a line living entirely in the marginal column
            left_only = not body_part.strip()
        else:
            left, body_part, left_only = "", line, False
        heading = _HEADING.match(body_part if marginal_layout else line)
        if heading and (marginal_layout or not heading.group(1)) \
                and not _CITATION_TAIL.match((heading.group(3) or "")) \
                and not _TOC_TAIL.search(line):
            resolved = _resolve_number(heading.group(2), last_number)
            if resolved is not None:
                close()
                number, value = resolved
                if not _ROMAN.match(number):
                    last_number = value
                margin: list[str] = []
                if marginal_layout and left:
                    margin.append(left)
                if heading.group(3):
                    margin.append(heading.group(3))
                current = {"number": number, "margin": margin, "body": [],
                           "margin_open": marginal_layout}
                label = (body_part if marginal_layout else line).strip().split()[0]
                title_margin = _tidy(_join(margin))
                text_lines.append(f"{label} {number}"
                                  + (f" {title_margin}" if title_margin else ""))
                pending_blank = False
                continue
        if current is not None:
            if _TAIL_BREAK.match(line):
                close()
                pending_blank = False
                continue
            if pending_blank and _is_section(line) and not left_only:
                close()
                text_lines.append(_tidy(line))
                pending_blank = False
                continue
            if marginal_layout:
                fragment = line.strip() if left_only else left
                if fragment and current["margin_open"]:
                    # the left column under the heading: the marginal keeps
                    # wrapping while its last fragment is visibly unfinished
                    # (a hyphen, or a short lowercase function word); a
                    # fragment after that -- the "1. Organisation"
                    # sub-marginal mid-article -- is layout, not marginal
                    if not current["margin"] and not current["body"]:
                        current["margin"].append(fragment)
                    elif current["margin"] and _margin_continues(current["margin"][-1]):
                        current["margin"].append(fragment)
                    else:
                        current["margin_open"] = False
                if left_only:
                    pending_blank = False
                    continue
                current["body"].append(body_part)
            else:
                current["body"].append(line)
        elif _is_section(line):
            text_lines.append(_tidy(line))
        pending_blank = False
    close()
    return articles, "\n".join(text_lines)
