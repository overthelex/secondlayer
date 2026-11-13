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

split_fedlex_text() returns (articles, text) like pdf_text.split_text().
The text is the whole clean document (preamble, headings, bodies, sections,
footnotes, annexes; see _TextProduct); clean_fedlex_text() returns it alone.
It is built beside the article split and never feeds back into it: the
articles are byte-identical to what the splitter produced before the text
product existed.
"""
from __future__ import annotations

import re

from . import akn, text_clean
from .pdf_text import _join_legacy as _join      # ruling R27: byte-identical output

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
# The number column is four characters wide, so a three-digit footnote is
# followed by ONE space ("100 Fassung gemäss ..."), a one- or two-digit one
# by two or more; a paragraph number ("1 Alle Schweizer ...") never reaches
# three digits, so the single space is safe there.
_FOOTNOTE_START = re.compile(r"^(?:\d{1,2}\s{2,}|\d{3}\s+)[^\W\d_«»„\"'(\[]|^(?:\d{1,2}\s{2,}|\d{3}\s+)[«»„\"'(\[]")
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
# Also: after an enumeration number ("gefordert: 1.223 Adoption" is item 1
# with footnote 223), after an abbreviation's full stop ("AHVG.309"), after
# an ellipsis, and a space-separated chain of three-digit numbers
# ("AHVG.309 310") -- a paragraph number never has three digits, so the
# chain cannot eat one.
# Up to three digits: the ZGB, SchKG and AHVV number their footnotes past
# 100 ("Rechtsstillstand.102", "Tagessätzen102", "rententabellen201"), and a
# two-digit cap left every one of those glued to the word in front of it --
# the source of most "changes" between two pdf-a editions of those acts
# (measured 2026-09-04 on a 400-pair sample: 187 of 340 differed by a
# renumbered footnote or a layout slip, not an amendment).
_NOTE_REF = re.compile(
    # never inside an SR / RS / RU number ("SR 173.110", "RS 0.211.230.02")
    r"(?<!SR \d{3}\.)(?<!RS \d{3}\.)(?<!RU \d{3}\.)(?<![\d.]{5}\.)"
    r"(?:(?<=[a-zäöüéèàûîçñ»›\"'\)\]…])|(?<=[A-Za-zÄÖÜäöüéèàûîçñ\)\]][.:;,])|(?<=\.\.\.)"
    r"|(?<=(?:19|20)\d{2})"
    # after an enumeration or article number: "1.223 Adoption", "10.180 i diritti",
    # "Artikel 72.272 2 L'office" -- only when whitespace or the end follows
    r"|(?<=\s\d\.)(?=\d{3}(?:\s|$))|(?<=\s\d\d\.)(?=\d{3}(?:\s|$))|(?<=\d{3}\.)(?=\d{3}(?:\s|$))"
    r"|(?<=^\d\.))"
    r"(\d{1,3})(?:,\s?\d{1,3}|\s\d{3})*(?=[\s.,;:)\]]|$)", re.MULTILINE)

# A footnote line anywhere in the stream: its number at column 0, two or
# more spaces, then text that starts with a letter, a quote or a bracket --
# never a digit, so a table row ("31  70,46 72,73") is not one. The text of
# a real footnote almost always opens with the amendment / citation
# vocabulary below; a lone numbered line without it is left in place (a
# paragraph number set with two spaces would otherwise be eaten).
_FOOTNOTE_LINE = re.compile(r"^(\d{1,2}(?=\s{2,})|\d{3}(?=\s))\s+(?=[^\W\d_«»„\"'(\[]|[«»„\"'(\[])")
_FOOTNOTE_VOCAB = re.compile(
    r"^(?:\d{1,2}\s{2,}|\d{3}\s+)(?:"
    r"Fassung|Eingefügt|Aufgehoben|Bereinigt|Berichtigt|Ursprünglich|Angenommen|Siehe|"
    r"Heute|Die Bezeichnung|Ausdruck|Term|Gemäss|Nach|Bis|Ab |Im |In Kraft|"
    r"Nouvelle teneur|Introduit|Abrogé|Rectifi|Actuellement|Anciennement|Voir|"
    r"Nuovo testo|Introdott|Abrogat|Correzione|Attualmente|Vedi|"
    r"SR |AS |BS |BBl |RS |RO |FF |RU |CS |"
    r"Verordnung|Règlement|Regolamento|Richtlinie|Directive|Direttiva"
    r")", re.IGNORECASE)
_FOOTNOTE_CONT_MAX_INDENT = 14


def _strip_footnote_runs(lines: list[str], notes: list | None = None,
                         where: list[int] | None = None) -> list[str]:
    """Remove footnote blocks WHEREVER they sit, not only at a page tail.

    _strip_page_furniture reconstructs pages at running-header lines and
    cuts the footnote block above each folio; where the header of a page
    was not recognised (the marginal-column prints in particular), two
    pages merge and the first page's footnotes end up mid-stream, glued
    into the article they happen to interrupt -- and in the marginal
    layout the column slice then splits each footnote line at the body
    column, so its tail ("mäss Ziff. I des BG vom 16. Dez. 1994, in Kraft
    seit ...") reads as article prose. Measured on the 2003 ZGB print:
    56 of 1,093 articles carried footnote bodies, 73 a glued 3-digit
    reference.

    A block starts at a footnote line (see _FOOTNOTE_LINE) that follows a
    blank line, a publication line or the start of the text, AND either
    opens with footnote vocabulary or is followed by another footnote line
    with the next number. It continues through indented continuation
    lines (2-14 spaces, not a heading) and further footnote lines whose
    numbers ascend, across blank lines when the next non-blank line is a
    numbered continuation. A publication line ("AS 1952 1087") right
    before the block goes with it.

    The text product keeps the footnotes: with ``notes`` given, every block
    removed is appended to it as (index in the returned list where the block
    stood, its lines); with ``where`` given, it is filled with the returned
    list's index of every input line (plus one entry for the end), so a
    position into ``lines`` can be carried over. Neither changes the return.
    """
    out: list[str] = []
    i, n = 0, len(lines)
    if where is not None:
        where[:] = [0] * (n + 1)

    def next_nonblank(k: int) -> int:
        while k < n and not lines[k].strip():
            k += 1
        return k

    while i < n:
        line = lines[i]
        if where is not None:
            where[i] = len(out)
        m = _FOOTNOTE_LINE.match(line)
        preceded = not out or not out[-1].strip() or bool(_PUBLICATION.match(out[-1]))
        if m and preceded:
            number = int(m.group(1))
            k = next_nonblank(i + 1)
            sibling = k < n and (m2 := _FOOTNOTE_LINE.match(lines[k])) and number < int(m2.group(1)) <= number + 3
            if _FOOTNOTE_VOCAB.match(line) or sibling:
                if out and _PUBLICATION.match(out[-1]):
                    out.pop()
                last = number
                j = i + 1
                while j < n:
                    nxt = lines[j]
                    if not nxt.strip():
                        k = next_nonblank(j)
                        m2 = _FOOTNOTE_LINE.match(lines[k]) if k < n else None
                        if m2 and last < int(m2.group(1)) <= last + 3:
                            j = k
                            continue
                        break
                    m2 = _FOOTNOTE_LINE.match(nxt)
                    if m2:
                        num2 = int(m2.group(1))
                        if last < num2 <= last + 3:
                            last = num2
                            j += 1
                            continue
                        break
                    indent = len(nxt) - len(nxt.lstrip(" "))
                    if 2 <= indent <= _FOOTNOTE_CONT_MAX_INDENT and not _HEADING.match(nxt):
                        j += 1
                        continue
                    break
                if notes is not None:
                    notes.append((len(out), lines[i:j]))
                if where is not None:
                    for k in range(i, j):
                        where[k] = len(out)
                i = j
                continue
        out.append(line)
        i += 1
    if where is not None:
        where[n] = len(out)
    return out


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


def _strip_page_furniture(lines: list[str], notes: list | None = None) -> list[str]:
    """Remove running headers, folios and footnote blocks from the single
    stream. Pages are reconstructed at the running-header lines (the only
    page boundary that survived the form-feed strip); each page then loses
    its trailing folio and the footnote block above it.

    With ``notes`` given, each footnote block cut is appended to it as
    (index in the returned list of the page seam it stood before, its
    lines) -- for the text product, which keeps them; the return is the
    same either way."""
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
        kept = _strip_footnote_block(page)
        cut = page[len(kept):]
        page = kept
        while page and not page[-1].strip():
            page.pop()
        out.extend(page)
        if notes is not None and cut:
            notes.append((len(out), cut))
        out.append("")                  # keep a block boundary at the seam
    # page-1 head: drop the SR number line itself
    if sysnr:
        dropped = [i for i, l in enumerate(out[:6]) if l.strip() == sysnr]
        out = [l for i, l in enumerate(out[:6]) if l.strip() != sysnr] + out[6:]
        if notes is not None and dropped:
            notes[:] = [(a - sum(1 for d in dropped if d < a), block) for a, block in notes]
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


def split_fedlex_text(raw: str, lang: str | None = None) -> tuple[list[akn.Article], str]:
    """Stored fedlex_pdf full_text -> (articles, text).

    ``text`` is the whole clean document in reading order (see _TextProduct):
    title and preamble lines, each article as an "Art. N <marginal note>"
    heading paragraph followed by its body paragraphs, section lines, and
    everything after the tail break (in-force date, annexes, signatures).
    ``lang`` picks the hyphen vocabulary (text_clean.hyphen_vocabulary; no
    language, or German, means no vocabulary). The footnotes the furniture
    strips take out of the article stream stay in the text, one per
    paragraph after the article the page ended in (see _TextProduct). The
    articles do not depend on ``lang`` or on anything the text product
    does."""
    # the footnotes leave the article stream but not the document: both
    # strips hand what they cut to the text product, anchored where it stood
    page_notes: list = []
    run_notes: list = []
    where: list[int] = []
    lines = _strip_footnote_runs(_strip_page_furniture(raw.splitlines(), page_notes),
                                 run_notes, where)
    notes = sorted([(where[a], block) for a, block in page_notes] + run_notes,
                   key=lambda note: note[0])

    # layout: where do the headings sit? Column 0, or one indented body
    # column with a marginal column to its left?
    heading_indents = [len(m.group(1)) for l in lines
                       if (m := _HEADING.match(l)) and not _TOC_TAIL.search(l)]
    marginal_layout = (len(heading_indents) >= 2
                       and min(heading_indents) >= 8)
    body_col = min(heading_indents) if marginal_layout else 0

    vocabulary = text_clean.hyphen_vocabulary([lang]) if lang else frozenset()
    product = _TextProduct(lines, marginal_layout, body_col, vocabulary,
                           _find_sysnr(raw.splitlines()[:8]), notes)

    articles: list[akn.Article] = []
    seen: dict[str, int] = {}
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
        product.end_article()
        current = None

    for index, line in enumerate(lines):
        product.reach(index)
        if not line.strip():
            pending_blank = True
            if current is None:
                product.blank()
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
                product.start_article(index, heading,
                                      body_part if marginal_layout else line, number)
                pending_blank = False
                continue
        if current is not None:
            if _TAIL_BREAK.match(line):
                close()
                product.tail(index)
                pending_blank = False
                continue
            if pending_blank and _is_section(line) and not left_only:
                close()
                product.section(line)
                pending_blank = False
                continue
            product.article_line(index)
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
        else:
            product.outside(index)
        pending_blank = False
    close()
    return articles, product.text()


def clean_fedlex_text(raw: str, lang: str | None = None) -> str:
    """The text product alone: split_fedlex_text(raw, lang)[1]."""
    return split_fedlex_text(raw, lang)[1]


# --- the text product -------------------------------------------------------

# A running header the page strip missed (no SR number learnt at the head):
# the act title and the SR number one wide gap apart. The same shape is a fee
# or table row ("Grundgebühr für ...      300"), so a line of this shape is
# dropped only with corroboration (see _TextProduct._is_header).
_HEADER_SHAPE = re.compile(
    r"^(?P<a>\S.{0,110}?)\s{6,}(?P<an>\d{1,4}(?:\.\d{1,3})*[a-z]?)$"
    r"|^(?P<bn>\d{1,4}(?:\.\d{1,3})*[a-z]?)\s{6,}(?P<b>\S.{0,110})$")
# A bare folio. Fedlex prints paragraph numbers inline, so outside an
# article body a line holding only a 1-3 digit number is a page number.
_BARE_NUMBER = re.compile(r"^\d{1,3}$")
# The translation flag at the head of page 1 ("Übersetzung1", "Traduction2"):
# it only points at a footnote, which the furniture strip removed.
_TRANSLATION_FLAG = re.compile(r"^(?:Übersetzung|Traduction|Traduzione|Translation)\d{0,3}$")
# A paragraph number opening a body line: "2 Ist die ...", "3bis Les ...".
_PARAGRAPH_START = re.compile(
    r"^\d{1,2}(?:bis|ter|quater|quinquies|sexies|septies|octies|novies|decies|[a-z])?\s+\S")
_SENTENCE_END = (".", ":", ";", "…", "!", "?")
# A marginal fragment that opens a new title level: "2. Auf Grund",
# "a. Beschränkung", "B. Offices", "IV. Titel", "a) ...", "2 Rémunération".
_TITLE_START = re.compile(
    r"^(?:(?:[A-Z]{1,2}|[a-z]{1,2}|\d{1,2}|[IVXLC]+)\.\s|[a-z]\)\s|\d{1,2}[a-z]{0,10}\s+[A-ZÄÖÜÉÈÀ])")
_PAIR_CONNECTOR = re.compile(r"\s(?:et|und|e|and)\s")
_RANGE_CONNECTOR = re.compile(r"\s?[-–—]\s?|\s[àa]\s")

# --- the marginal column, line by line --------------------------------------
# pdftotext -layout does not keep the body column of the marginal layout in
# one place: measured on the SchKG prints (SR 281.1, de/fr/it, 2026-11) the
# article headings sit anywhere from column 15 to 22 -- between pages AND
# within one page ("E. Protokolle    1 Die ..." at 17, the next line at 19).
# One document-wide cut (the old body_col = the leftmost heading) put the
# cut inside every marginal fragment longer than it ("oder Wertsachen" at a
# cut of 15) and spliced the fragment into the body. So the column is read
# per line, from the line's neighbours: the start of the body on the
# nearest line above (an indented body line, a heading, or a line already
# split), else below. A line that opens at column 0 is cut at the gap whose
# end lies near that column; a line no cut fits stays whole (ruling R28:
# text no column owns is never discarded, nor guessed apart).
_COLUMN_LOOK = 8            # lines looked at, up and down, for the column
_BODY_INDENT = 6            # a line indented this far is body (the margin starts at 0)
_CUT_BEFORE, _CUT_AFTER = 5, 4   # where a cut may fall around that column
_SINGLE_CUT_BODY = 20       # a body piece cut off by ONE space is at least this long
# the body's first word is a paragraph number ("1 Vor Ablauf", "2bis Les")
_PARAGRAPH_HEAD = re.compile(
    r"\d{1,2}(?:bis|ter|quater|quinquies|sexies|septies|octies|novies|decies|[a-z])?"
    r"\s+[A-ZÄÖÜÉÈÀÂÊÎÔÛÇ«„\"(]")
_ENDS_NUMBER = re.compile(r"(?:^|\s)\d{1,3}$")
# a footnote's first line inside a cut footnote block: "13    Eingefügt ...",
# "538 SR 220", "2   [BS 1 3]. Der ..."
_NOTE_HEAD = re.compile(r"^(\d{1,3})\s+(\S.*)$")


def _header_title(match: re.Match) -> str:
    return _WS.sub(" ", match.group("a") or match.group("b")).strip()


class _TextProduct:
    """Builds the whole-document text beside the article split.

    Kept apart from the article state on purpose: nothing here feeds back
    into an Article, so the articles stay what they were before the text
    product existed (tests/test_fedlex_split.py holds golden captures).

    Outside article bodies, lines stay separate (each through _tidy, a
    trailing-hyphen wrap joined with text_clean.join_hyphen) and a blank line
    in the source starts a new paragraph. In the marginal layout a line keeps
    its body-column part, and its marginal-column part is collected as a
    title (ruling R15: no marginal title is lost). An article is a heading
    paragraph -- the printed heading ("Art. 9 ...", "Art. 3 et 4", ruling
    R16) with glued footnotes stripped, then every marginal title from the
    heading to the next heading, one title level per line -- and body
    paragraphs, one per numbered paragraph. From a tail break on (annexes,
    in-force date, signatures) lines are read whole, not column-sliced.

    The marginal column is cut line by line (see _COLUMN_LOOK and _cut):
    the body column drifts by several characters across a pdftotext print.

    Footnotes are kept (they are the act's amendment history). The furniture
    strips hand every footnote block they cut over as ``notes`` (anchor
    index into ``lines``, block lines); once the splitter has passed an
    anchor, the block's footnotes wait for the next paragraph boundary
    outside an article -- the end of the article the page ended in, or the
    next blank line outside articles -- and follow there, one footnote per
    paragraph, number first ("13 Eingefügt durch Ziff. I ... (AS 1995 1227;
    BBl 1991 III 1)."), continuation lines joined, wrap hyphens rejoined.
    The publication line above footnote 1 ("AS 11 529 und BS 3 3") stays
    furniture. The in-text footnote references glued to words are still
    stripped (_tidy): a reference set loose ("werden. 322") would read as a
    paragraph number or an amount, and the footnote keeps its number."""

    def __init__(self, lines: list[str], marginal_layout: bool, body_col: int,
                 vocabulary: frozenset[str], sysnr: str | None,
                 notes: list | None = None) -> None:
        self.lines = lines
        self.notes = list(notes or [])     # (anchor, block lines), anchor-ordered
        self.pending_notes: list[str] = []
        self._cuts: dict[int, tuple[str, str | None, str | None, int | None]] = {}
        self.marginal = marginal_layout
        self.body_col = body_col
        self.vocabulary = vocabulary
        self.sysnr = sysnr
        self.paragraphs: list[str] = []
        self.open: list[str] = []          # lines of the outside paragraph being built
        self.open_fragments: list[str] = []  # marginal fragments met outside articles
        self.head = True                   # nothing emitted yet
        self.after_tail = False
        self.art: dict | None = None
        titles: dict[str, int] = {}
        for line in lines:
            m = _HEADER_SHAPE.match(line.strip())
            if m:
                key = _header_title(m)
                titles[key] = titles.get(key, 0) + 1
        self.header_titles = titles
        if marginal_layout:
            # top-down, so each line's look upward (_column) meets memoised
            # cuts only -- no recursion through long column-0 runs
            for index, line in enumerate(lines):
                if line.strip():
                    self._cut(index)

    # -- line shapes --

    def _kind(self, index: int) -> str:
        """'body' (body column only), 'two' (marginal fragment + body),
        'full' (a line no column cut fits, or any line outside the marginal
        layout) or 'left' (marginal column only)."""
        if not self.marginal or self.after_tail:
            return "full"
        return self._cut(index)[0]

    def _cut(self, index: int) -> tuple[str, str | None, str | None, int | None]:
        """(kind, marginal fragment, body piece, body start column) of a line
        in the marginal layout. Memoised: the column of a line is read from
        the lines above it, which are cut first."""
        if index in self._cuts:
            return self._cuts[index]
        line = self.lines[index]
        indent = len(line) - len(line.lstrip(" "))
        if indent >= _BODY_INDENT:
            result = ("body", None, line.strip(), indent)
        elif _HEADER_SHAPE.match(line.strip()) and self._is_header(index):
            result = ("full", None, line.strip(), None)
        else:
            column = self._column(index)
            result = ("full", None, line.strip(), None)
            if column is not None:
                best, best_score = None, None
                for gap in re.finditer(r"\s+", line.rstrip()):
                    start, end = gap.start(), gap.end()
                    if not line[:start].strip():
                        continue
                    left, right = line[:start].strip(), line[end:]
                    wide = end - start >= 2
                    if wide:
                        # a wide gap after a fragment that fits the margin:
                        # the body may start further right (an enumeration,
                        # "teur                       débiteur;")
                        if start > column + 1 or end < column - _CUT_BEFORE:
                            continue
                    elif not column - _CUT_BEFORE <= end <= column + _CUT_AFTER:
                        continue
                    score = -abs(end - column) if end <= column + _CUT_AFTER else -_CUT_AFTER
                    paragraph = bool(_PARAGRAPH_HEAD.match(right))
                    if wide:
                        score += 10
                    elif len(right.strip()) < _SINGLE_CUT_BODY or not (
                            paragraph or self._continues_body(index, right)
                            or (abs(end - column) <= 1
                                and self._continues_margin(index, left))):
                        # one space is also every gap of a full-width line
                        # ("Grundgebühr für die Erteilung ..."): a cut there
                        # needs evidence of its own, and a body line runs
                        # long ("du concordat à" is all margin)
                        continue
                    if paragraph:
                        score += 6
                    if _ENDS_NUMBER.search(left):
                        score -= 6       # "D. Umwandlung 1" | "Forderungen": the 1 is body
                    if best_score is None or score > best_score:
                        best, best_score = (left, right.strip(), end), score
                if best is not None:
                    result = ("two", best[0], best[1], best[2])
                elif len(line.rstrip()) <= column + 2:
                    result = ("left", line.strip(), None, None)
        self._cuts[index] = result
        return result

    def _continues_body(self, index: int, right: str) -> bool:
        """Does ``right`` finish a word the body broke on the line above
        ("... das Konkurs-" / "gericht auf Antrag")?"""
        k = index - 1
        while k >= 0 and not self.lines[k].strip():
            k -= 1
        if k < 0:
            return False
        piece = self._cut(k)[2]
        return bool(piece and re.search(r"[^\W\d_]-$", piece) and right[:1].islower())

    def _continues_margin(self, index: int, left: str) -> bool:
        """Is ``left`` a marginal fragment by its own shape -- it opens a
        title level ("1. Schriftlich und") -- or because the fragment above
        is visibly unfinished ("a. Annotation au" / "registre foncier")?"""
        if _TITLE_START.match(left):
            return True
        k = index - 1
        while k >= 0 and not self.lines[k].strip():
            k -= 1
        fragment = self._cut(k)[1] if k >= 0 else None
        return bool(fragment and _margin_continues(fragment))

    def _column(self, index: int) -> int | None:
        """The body column at ``index``: where the body starts on the nearest
        line above (within _COLUMN_LOOK non-blank lines) that has a body, else
        on the nearest indented line below. None: no evidence near."""
        seen, k = 0, index - 1
        while k >= 0 and seen < _COLUMN_LOOK:
            if self.lines[k].strip():
                seen += 1
                start = self._cut(k)[3]
                if start is not None:
                    return start
            k -= 1
        seen, k = 0, index + 1
        while k < len(self.lines) and seen < _COLUMN_LOOK:
            line = self.lines[k]
            if line.strip():
                seen += 1
                indent = len(line) - len(line.lstrip(" "))
                if indent >= _BODY_INDENT:
                    return indent
            k += 1
        return None

    def _has_body_neighbour(self, index: int) -> bool:
        for step in (-1, 1):
            k = index + step
            while 0 <= k < len(self.lines) and not self.lines[k].strip():
                k += step
            if 0 <= k < len(self.lines) and self._kind(k) in ("body", "two"):
                return True
        return False

    def _beside_folio(self, index: int) -> bool:
        """Right next to a folio line (a bare page number)."""
        for step in (-1, 1):
            k = index + step
            if 0 <= k < len(self.lines) and _BARE_NUMBER.match(self.lines[k].strip()):
                return True
        return False

    def _is_header(self, index: int) -> bool:
        """A running header the page strip missed: the header shape AND one
        of: its number is the learnt SR number, its title recurs (on two
        pages or more), or a folio stands right beside it. Nothing else
        makes such a line furniture (ruling R28): a fee or table row
        ("Gebühr für eine Kopie      10", "c. pour les autocars   650",
        "Turquie   12 juin   1907   12 juin   1907") has the shape, and the
        last row of a table sits at a page seam -- above the footnote block,
        blank lines on either side -- exactly where a missed header would.
        A seam of blank lines alone is therefore no evidence (the 2026-11
        prod gate lost those rows to it: 560289, 560210)."""
        m = _HEADER_SHAPE.match(self.lines[index].strip())
        if not m:
            return False
        number = m.group("an") or m.group("bn")
        if self.sysnr and number == self.sysnr:
            return True
        if self.header_titles.get(_header_title(m), 0) >= 2:
            return True
        return self._beside_folio(index)

    def _split(self, index: int) -> tuple[str | None, str | None]:
        """(marginal fragment, body piece) of the line at ``index``; either
        is None when absent. A missed running header yields neither."""
        kind = self._kind(index)
        if kind == "full":
            if self._is_header(index):
                return None, None
            return None, self.lines[index].strip()
        _, fragment, piece, _ = self._cut(index)
        return fragment, piece

    # -- joining --

    def _append(self, out: str, piece: str) -> str:
        if not out:
            return piece
        if out.endswith("-") and out[-2:-1].isalpha():
            return text_clean.join_hyphen(out, piece, self.vocabulary)
        return out + " " + piece

    def _titles(self, fragments: list[str]) -> list[str]:
        """Marginal fragments -> titles, one per level: a fragment that
        opens with a level marker starts a title, any other continues it."""
        out: list[str] = []
        for fragment in fragments:
            fragment = fragment.strip()
            if not fragment or _BARE_NUMBER.match(fragment):
                continue
            if out and not _TITLE_START.match(fragment):
                out[-1] = self._append(out[-1], fragment)
            else:
                out.append(fragment)
        return [t for t in (_tidy(t) for t in out) if t]

    def _flush(self) -> None:
        titles = self._titles(self.open_fragments)
        self.open_fragments = []
        if titles:
            self.paragraphs.append("\n".join(titles))
        if self.open:
            self.paragraphs.append("\n".join(self.open))
            self.open = []
        if self.art is None:
            self._emit_notes()

    def _emit_line(self, piece: str) -> None:
        tidy = _tidy(piece)
        if not tidy or _BARE_NUMBER.match(tidy):
            return
        if self.head and _TRANSLATION_FLAG.match(piece):
            return
        self.head = False
        # a wrap hyphen joins into the open line; anything else is a new line
        if self.open and self.open[-1].endswith("-") and self.open[-1][-2:-1].isalpha():
            self.open[-1] = _tidy(text_clean.join_hyphen(self.open[-1], piece, self.vocabulary))
        else:
            self.open.append(tidy if not piece.endswith("-") else _tidy(piece[:-1]) + "-")

    # -- footnotes --

    def _footnotes(self, block: list[str]) -> list[str]:
        """A cut footnote block -> one paragraph per footnote, "N text". A
        line that opens no footnote continues the one before it; the
        publication line ("AS 11 529 und BS 3 3") is dropped. Text before
        the first footnote (an indented line the cut took along) is kept as
        its own paragraph -- never dropped."""
        out: list[str] = []
        for line in block:
            if not line.strip() or _PUBLICATION.match(line):
                continue
            head = _NOTE_HEAD.match(line)
            if head and not line.startswith(" "):
                out.append(f"{head.group(1)} {head.group(2).strip()}")
            elif out:
                out[-1] = self._append(out[-1], line.strip())
            else:
                out.append(line.strip())
        return [t for t in (_WS.sub(" ", t).strip() for t in out) if t]

    def reach(self, index: int) -> None:
        """The splitter is at ``index``: footnote blocks anchored at or
        before it are due at the next paragraph boundary."""
        while self.notes and self.notes[0][0] <= index:
            self.pending_notes.extend(self._footnotes(self.notes.pop(0)[1]))

    def _emit_notes(self) -> None:
        if self.pending_notes:
            self.paragraphs.extend(self.pending_notes)
            self.pending_notes = []
            self.head = False

    # -- events from the splitter --

    def blank(self) -> None:
        self._flush()

    def outside(self, index: int) -> None:
        if _TAIL_BREAK.match(self.lines[index]):
            self.tail(index)
            return
        fragment, piece = self._split(index)
        if fragment is not None and piece is None and not self._has_body_neighbour(index):
            piece, fragment = fragment, None     # a title line of the act, not a margin
        if fragment is not None:
            self.open_fragments.append(fragment)
        if piece is not None:
            self._emit_line(piece)

    def tail(self, index: int) -> None:
        """The tail-break line ("Anhang", "Datum des Inkrafttretens", ...),
        emitted whole whatever its column; lines after it are read whole."""
        self._flush()
        self.after_tail = True
        self._emit_line(self.lines[index].strip())

    def section(self, line: str) -> None:
        self._flush()
        tidy = _tidy(line)
        if tidy:
            self.paragraphs.append(tidy)
            self.head = False

    def start_article(self, index: int, heading: re.Match, text: str, number: str) -> None:
        self._flush()
        self.head = False
        self.after_tail = False
        fragments: list[str] = []
        if self.marginal:
            # the heading's line may carry a marginal fragment left of it;
            # cut where the heading starts, not at a document-wide column
            line = self.lines[index]
            label = line.find(text.strip()[:4], max(0, self.body_col - 1))
            left = line[:label].strip() if label > 0 else ""
            if left:
                fragments.append(left)
        if heading.group(3):
            fragments.append(heading.group(3))
        self.art = {"heading": self._printed_heading(heading, text, number),
                    "fragments": fragments, "body": []}

    def article_line(self, index: int) -> None:
        if self.art is None:
            return
        fragment, piece = self._split(index)
        if fragment is not None:
            self.art["fragments"].append(fragment)
        if piece is not None:
            self.art["body"].append(piece)

    def end_article(self) -> None:
        art, self.art = self.art, None
        if art is None:
            return
        titles = self._titles(art["fragments"])
        heading = art["heading"] + (f" {titles[0]}" if titles else "")
        self.paragraphs.append("\n".join([heading] + titles[1:]))
        paragraph = ""
        for piece in art["body"]:
            if paragraph and _PARAGRAPH_START.match(piece) and _tidy(paragraph).endswith(_SENTENCE_END):
                self.paragraphs.append(_tidy(paragraph))
                paragraph = ""
            paragraph = self._append(paragraph, piece)
        if _tidy(paragraph):
            self.paragraphs.append(_tidy(paragraph))
        self._emit_notes()

    @staticmethod
    def _printed_heading(heading: re.Match, text: str, number: str) -> str:
        """The heading as printed, its number token swapped for the
        resolved (footnote-free) number: "Art. 3 et 4", "Art. 5 à 8",
        "Art. 2–3", "Art. 9 ...", "Art. 2" for a printed "Art. 25"."""
        label = text.strip().split()[0]
        token = heading.group(2)
        shown = number
        if "+" in number:
            conn = _PAIR_CONNECTOR.search(token)
            if conn:
                left, right = number.split("+", 1)
                shown = left + conn.group(0) + right
        elif "-" in number:
            conn = _RANGE_CONNECTOR.search(token)
            if conn:
                left, right = number.split("-", 1)
                shown = left + conn.group(0) + right
        rest = text[heading.end(2):heading.start(3) if heading.group(3) else len(text)]
        for marker in ("...", "…"):
            if marker in rest:
                shown += " " + marker
                break
        return f"{label} {shown}"

    def text(self) -> str:
        self.reach(len(self.lines))
        if self.art is not None:
            self.end_article()
        self._flush()
        return text_clean.normalise_chars("\n\n".join(p for p in self.paragraphs if p))
