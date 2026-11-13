"""Clean raw ``pdftotext -layout`` text (pure, no I/O).

``clean_pdf_text`` is the entry point; the other functions are its steps and
are public so the federal, cantonal and decision pipelines can reuse them:

1. ``normalise_chars``: ligatures, no-break spaces, soft hyphens.
2. ``strip_page_furniture``: folios, "Seite N", running headers.
3. ``split_columns``: de-interleave two-column runs (left column first).
4. ``unwrap`` (only when ``is_hard_wrapped``): rebuild paragraphs from
   hard-wrapped lines, joining hyphen line-wraps with ``join_hyphen``.
5. Collapse runs of blank lines, strip.

Text that is already reflowed (one paragraph per line, as HTML-source
decisions are) goes through unchanged apart from step 1 and trailing
whitespace on lines.
"""

import re
from statistics import median

from chpipe.text_quality import _wordlist

CLEANER_VERSION: int = 1

# Spiders whose text is reflowed by their own parser (rpw.py); never cleaned here.
OWN_REFLOW_SPIDERS: frozenset[str] = frozenset({"CH_WEKO_RPW", "CH_WEKO"})

# German is left out on purpose (ledger ruling R2): the wordlists hold only the
# 2,000 most common words, so "both parts known, joined form unknown" would keep
# false hyphens in ordinary German compounds. Real German hyphens have an
# uppercase tail and are kept by the uppercase rule instead.
HYPHEN_VOCAB_LANGUAGES = frozenset({"fr", "it", "rm"})

_CHAR_MAP = str.maketrans({
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬀ": "ff",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
    " ": " ",
    " ": " ",
    "­": None,
})

_FOLIO = re.compile(r"^\s*\d{1,3}\s*$")
_PAGE_LABEL = re.compile(r"^\s*(Seite|Page|Pagina)\s+\d+")
_DASH_FOLIO = re.compile(r"^\s*-\s*\d{1,3}\s*-\s*$")
_FOLIO_HEADER = (
    re.compile(r"^(\d{1,3})\s{3,}(\S.{0,99})$"),   # "13     PKG 2001"
    re.compile(r"^(.{0,99}\S)\s{3,}(\d{1,3})$"),   # "PKG 2001       13"
)
REPEAT_MIN = 3
REPEAT_MAX_LEN = 120
# Ruling R14: running headers recur once per page, so their occurrences must be
# at least this many lines apart (median gap). Cost tables repeat "Total 0"
# rows a few lines apart and must survive.
PAGE_GAP_MIN = 15

HARD_WRAP_MIN_LINE = 20
HARD_WRAP_MEDIAN = 100

_PARAGRAPH_MARKER = re.compile(
    r"^(\d{1,3}\.\s|[A-Z]\.\d*(\.\d+)*\s|[a-z]\)\s|[IVX]{1,5}\.\s|Art\.\s|§\s?\d|E\.\s?\d"
    r"|Erwägung|Considérant|Considerando|Sachverhalt|Faits|Fatti|Dispositiv)")
# Ruling R12: words after which a line-final hyphen is a real (suspended) hyphen.
_CONJUNCTION = re.compile(
    r"^(und/oder|und|oder|bzw\.|beziehungsweise|resp\.|respektive|bis|wie|sowie"
    r"|et/ou|et|ou|à|ed|e|od|o|u|ni)(?=[\s,.;/]|$)")
_MARKER_PREV_END = ".:;)"
_TERMINAL = ".:;!?"
_HEAD_WORD = re.compile(r"([^\W\d_]+)-$")
_TAIL_WORD = re.compile(r"[^\W\d_]+")
SHORT_LINE_FACTOR = 0.6

_GAP = re.compile(r" {3,}")
_SOFT_GAP = re.compile(r" {2,}")
GUTTER_SIDE_MIN = 20
COLUMN_RUN_MIN_LINES = 4
COLUMN_RUN_MIN_ANCHORS = 2
COLUMN_FIT_SHARE = 0.6
COLUMN_MAX_MISSES = 8
COLUMN_TAIL_LINES = 3
COLUMN_MAX_BLANKS = 1
SPLIT_SLACK = 6


def normalise_chars(text: str) -> str:
    """Ligatures to letters, U+00A0/U+202F to space, soft hyphens removed.

    U+FFFD is left as is: it marks a lost character that we cannot recover.
    """
    return text.translate(_CHAR_MAP)


def _folio_header(stripped: str) -> tuple[str, int] | None:
    """("title", folio) for a "NNN   title" / "title   NNN" line, else None."""
    m = _FOLIO_HEADER[0].match(stripped)
    if m:
        return " ".join(m.group(2).split()), int(m.group(1))
    m = _FOLIO_HEADER[1].match(stripped)
    if m:
        return " ".join(m.group(1).split()), int(m.group(2))
    return None


def _page_spaced(positions: list[int]) -> bool:
    gaps = [b - a for a, b in zip(positions, positions[1:])]
    return bool(gaps) and median(gaps) >= PAGE_GAP_MIN


def _is_folio_line(line: str) -> bool:
    return bool(_FOLIO.match(line) or _PAGE_LABEL.match(line) or _DASH_FOLIO.match(line))


def _sentence_final(stripped: str) -> bool:
    """True when the line ends like the end of a sentence or clause ("AsylG).")."""
    return stripped[-1] in ".;:!?,)"


def _seam_lines(lines: list[str]) -> set[int]:
    """Indices of non-blank lines that sit at a page seam (linear time).

    A seam is: within 2 non-blank lines of a run of 2+ blank lines (clean_pdf_text
    turns a form feed into such a run); next to a folio / "Seite N" line (blank
    lines between do not count as distance); or in the first or last 2
    non-blank lines of the text.
    """
    nonblank = [i for i, ln in enumerate(lines) if ln.strip()]
    seams: set[int] = set(nonblank[:2]) | set(nonblank[-2:])
    for k, i in enumerate(nonblank):
        for d in (-1, 1):
            if 0 <= k + d < len(nonblank) and _is_folio_line(lines[nonblank[k + d]]):
                seams.add(i)
        if k + 1 < len(nonblank) and nonblank[k + 1] - i >= 3:
            # blank run of 2+ between nonblank[k] and nonblank[k+1]
            seams.update(nonblank[max(0, k - 1):k + 1])
            seams.update(nonblank[k + 1:k + 3])
    return seams


def strip_page_furniture(lines: list[str]) -> list[str]:
    """Drop folios, page labels and running headers.

    Dropped: bare 1-3 digit lines, "Seite/Page/Pagina N", "- N -", and
    (ruling R14, page-like spacing) two kinds of running header:

    - a stripped line of at most 120 chars that occurs at least 3 times with
      a median gap of at least 15 lines between occurrences;
    - a folio header, a title and a 1-3 digit folio separated by 3+ spaces
      ("13     PKG 2001" / "PKG 2001       13"), when its title occurs at
      least 3 times, the folios strictly increase in document order and the
      median gap is at least 15 lines.

    A recurring line is dropped only when no occurrence is content: an
    occurrence off every page seam (see _seam_lines) that ends in sentence or
    clause punctuation is real text ("AsylG)." closing a citation), and then
    all occurrences stay. Running headers do not end that way; a header-shaped
    line with no seam signal at all is still dropped (synthetic page-per-line
    layouts with no blank lines).

    Amount rows ("Total     620", "Gerichtsgebühr   500") and margin-number
    paragraphs ("13     Text") fail these tests and are kept.
    """
    stripped = [ln.strip() for ln in lines]
    seen: dict[str, list[int]] = {}
    titles: dict[str, list[tuple[int, int]]] = {}
    for i, s in enumerate(stripped):
        if s and len(s) <= REPEAT_MAX_LEN:
            seen.setdefault(s, []).append(i)
        header = _folio_header(s) if s else None
        if header:
            titles.setdefault(header[0], []).append((i, header[1]))
    seams = _seam_lines(lines)
    # A recurring line that sits mid-page even once is content ("AsylG)." closing
    # a citation): keep every occurrence. Only all-seam recurrences are headers.
    repeated = {s for s, pos in seen.items()
                if len(pos) >= REPEAT_MIN and _page_spaced(pos)
                and all(i in seams or not _sentence_final(s) for i in pos)}
    header_lines: set[int] = set()
    for occ in titles.values():
        folios = [f for _, f in occ]
        if (len(occ) >= REPEAT_MIN
                and all(a < b for a, b in zip(folios, folios[1:]))
                and _page_spaced([i for i, _ in occ])):
            header_lines.update(i for i, _ in occ)
    out = []
    for i, (line, s) in enumerate(zip(lines, stripped)):
        if s and (
            _FOLIO.match(line)
            or _PAGE_LABEL.match(line)
            or _DASH_FOLIO.match(line)
            or s in repeated
            or i in header_lines
        ):
            continue
        out.append(line)
    return out


def is_hard_wrapped(text: str) -> bool:
    """True when the text is laid out in short lines rather than paragraphs.

    Measured on non-empty lines of at least 20 chars: the character-weighted
    median line length (the length below which half of the text's characters
    sit) is under 100. The plain median would count a reflowed decision as
    hard-wrapped, because its many short header lines (court, parties, date)
    outnumber its few long paragraph lines.
    """
    lengths = sorted(n for n in (len(ln.strip()) for ln in text.split("\n"))
                     if n >= HARD_WRAP_MIN_LINE)
    if not lengths:
        return False
    half = sum(lengths) / 2
    seen = 0
    for n in lengths:
        seen += n
        if seen >= half:
            return n < HARD_WRAP_MEDIAN
    return False  # pragma: no cover


def hyphen_vocabulary(languages: list[str]) -> frozenset[str]:
    """Lowercased wordlist union for the fr/it/rm languages among ``languages``."""
    vocabulary: frozenset[str] = frozenset()
    for lang in languages:
        if lang in HYPHEN_VOCAB_LANGUAGES:
            vocabulary |= _wordlist(lang)
    return vocabulary


# Ruling R26: a conjunction after a line-final hyphen keeps the suspension
# ("ein- und ausreisen", "auf- oder abgerundet", "pré- à post-") for any head,
# EXCEPT when head + conjunction is itself a word. Checked against the
# conjunction list: of sowie/somit/damit/womit/wobei/sodass/soweit/sofern/
# inwie only "sowie" has its right part ("wie") in _CONJUNCTION; the others
# never reach this rule (their tails are not conjunctions) and already join.
JOINED_CONJUNCTION_WORDS = frozenset({"sowie"})


def starts_with_conjunction(text: str) -> bool:
    """Does ``text`` open with a conjunction after which a line-final hyphen is
    a suspended one (ruling R12)? Shared with pdf_text's marginal column."""
    return _CONJUNCTION.match(text) is not None


def _is_word_wrap(head: str, conjunction: str) -> bool:
    m = _HEAD_WORD.search(head)
    return bool(m) and (m.group(1) + conjunction).lower() in JOINED_CONJUNCTION_WORDS


def join_hyphen(head: str, tail: str, vocabulary: frozenset[str]) -> str:
    """Join ``head`` (ending in "-") with the next line ``tail``.

    - tail starts with a conjunction ("Kantons- und ..."): keep the hyphen, add a space,
      unless head + conjunction is a word (``JOINED_CONJUNCTION_WORDS``: "so-" / "wie");
    - tail starts uppercase or with a digit, or head ends "<digit>-": keep the hyphen;
    - both word parts are in ``vocabulary`` but the joined word is not: keep the hyphen;
    - otherwise it is a line-wrap hyphen: drop it and join.
    """
    conjunction = _CONJUNCTION.match(tail)
    if conjunction and not _is_word_wrap(head, conjunction.group(1)):
        return head + " " + tail
    if tail[:1].isupper() or tail[:1].isdigit() or head[-2:-1].isdigit():
        return head + tail
    a = _HEAD_WORD.search(head)
    b = _TAIL_WORD.match(tail)
    if vocabulary and a and b:
        left, right = a.group(1).lower(), b.group(0).lower()
        if left in vocabulary and right in vocabulary and left + right not in vocabulary:
            return head + tail
    return head[:-1] + tail


def _column_width(lines: list[str]) -> int:
    lengths = sorted(len(ln.rstrip()) for ln in lines if ln.strip())
    if not lengths:
        return 0
    return lengths[min(len(lengths) - 1, int(0.9 * len(lengths)))]


def _ends_wrap(paragraph: str) -> bool:
    return paragraph.endswith("-") and paragraph[-2:-1].isalpha()


def _continues(nxt: str) -> bool:
    return nxt[:1].islower() and not _PARAGRAPH_MARKER.match(nxt)


def _is_furniture_shaped(stripped: str) -> bool:
    return bool(_FOLIO.match(stripped) or _folio_header(stripped))


def _bridge(lines: list[str], i: int, paragraph: str, prev_len: int,
            short: float) -> tuple[int, list[str]] | None:
    """Where to continue a paragraph across the blank line at ``i``, or None.

    Bridged only inside a sentence (a page break or a misaligned OCR column):
    the next non-blank line starts lowercase without a marker, and either the
    paragraph ends in a word-wrap hyphen, or its last line was full width and
    ends without terminal punctuation. After a word-wrap hyphen up to two
    folio-shaped lines ("79", "13     PKG 2001") between the halves of the
    word are moved out of the way: running headers are returned to be emitted
    after the paragraph (kept, as R14 does not let us drop them), bare folios
    are dropped as ``strip_page_furniture`` would.
    """
    n = len(lines)
    wrap = _ends_wrap(paragraph)
    if not wrap and (prev_len < short or paragraph[-1] in _TERMINAL):
        return None
    held: list[str] = []
    j = i
    while j < n:
        s = lines[j].strip()
        if not s:
            j += 1
        elif wrap and len(held) < 2 and _is_furniture_shaped(s):
            held.append(s)
            j += 1
        else:
            break
    if j < n and _continues(lines[j].strip()):
        return j, [h for h in held if not _FOLIO.match(h)]
    return None


def unwrap(lines: list[str], vocabulary: frozenset[str]) -> list[str]:
    """Rebuild paragraphs from hard-wrapped lines; one paragraph per output line.

    A line ends its paragraph when the next line is blank, or the line is
    shorter than 0.6 x the column width (90th percentile of non-empty line
    lengths) and the next line starts with an uppercase letter or a digit, or
    the next line starts with a paragraph marker (``_PARAGRAPH_MARKER``) and
    the line ends in . : ; ) or is short (ruling R13: "Urteil vom" /
    "12. Juli 2019" and "gemäss" / "Art. 8 EMRK" stay one sentence).
    Blank lines are bridged only inside a sentence, see ``_bridge``.
    Blank lines that end a paragraph are kept as "".
    """
    short = SHORT_LINE_FACTOR * _column_width(lines)
    out: list[str] = []
    held: list[str] = []
    paragraph = ""
    prev_len = 0
    prev_end = ""
    i = 0
    n = len(lines)

    def flush() -> None:
        nonlocal paragraph
        if paragraph:
            out.append(paragraph)
            paragraph = ""
        out.extend(held)
        held.clear()

    while i < n:
        s = lines[i].strip()
        if not s:
            bridge = _bridge(lines, i, paragraph, prev_len, short) if paragraph else None
            if bridge:
                i = bridge[0]
                held.extend(bridge[1])
                continue
            j = i
            while j < n and not lines[j].strip():
                j += 1
            flush()
            out.extend([""] * (j - i))
            i = j
            continue
        is_short = prev_len < short
        if not paragraph:
            paragraph = s
        elif (_PARAGRAPH_MARKER.match(s) and (is_short or prev_end in _MARKER_PREV_END)) or (
                is_short and (s[0].isupper() or s[0].isdigit())):
            flush()
            paragraph = s
        elif _ends_wrap(paragraph):
            paragraph = join_hyphen(paragraph, s, vocabulary)
        else:
            paragraph = paragraph + " " + s
        prev_len = len(lines[i].rstrip())
        prev_end = s[-1]
        i += 1
    flush()
    return out


def _gaps(line: str) -> list[tuple[int, int, bool]]:
    """Runs of 3+ spaces between text: (start, end, is_anchor).

    An anchor gap has at least 20 chars of text on each side.
    """
    out = []
    for m in _GAP.finditer(line):
        left = line[:m.start()].strip()
        right = line[m.end():].strip()
        if left and right:
            out.append((m.start(), m.end(),
                        len(left) >= GUTTER_SIDE_MIN and len(right) >= GUTTER_SIDE_MIN))
    return out


def _fits(lead: int, rlen: int, gaps: list[tuple[int, int, bool]], g: int) -> bool:
    """The line has right-column text and splits cleanly at column g.

    ``lead``/``rlen``: index of the first non-space char and rstripped length.
    """
    if rlen <= g:
        return False
    if lead >= g:
        return True
    return any(s <= g <= e for s, e, _ in gaps)


def _is_anchor(gaps: list[tuple[int, int, bool]], g: int) -> bool:
    return any(a and s <= g <= e for s, e, a in gaps)


def _split_line(line: str, g: int) -> tuple[str, str]:
    if not line[g:].strip():
        return line[:g].rstrip(), ""
    if not line[:g].strip():
        return "", line.strip()
    best = None
    for m in _SOFT_GAP.finditer(line):
        s, e = m.start(), m.end()
        dist = 0 if s <= g <= e else min(abs(g - s), abs(g - e))
        if dist <= SPLIT_SLACK and (best is None or dist < best[0]):
            best = (dist, s, e)
    lead = len(line) - len(line.lstrip())
    if lead and abs(g - lead) <= SPLIT_SLACK and (best is None or abs(g - lead) < best[0]):
        return "", line.strip()
    if best is None:
        return line.strip(), ""     # text straddles the gutter: keep the line whole
    p = min(max(g, best[1]), best[2])
    return line[:p].rstrip(), line[p:].strip()


def _runs_at(lines, gaps, leads, rlens, g):
    """Maximal two-column runs at gutter column g: [(start, end, fits)].

    Linear: the scan stops after 8 non-fitting non-empty lines since the run
    last qualified, and a failed run resumes after the last line it scanned.
    """
    runs = []
    n = len(lines)
    i = 0
    while i < n:
        if not gaps[i] or not _is_anchor(gaps[i], g):
            i += 1
            continue
        nonempty = fits = anchors = misses = blanks = 0
        best = None
        j = i
        while j < n:
            if not rlens[j]:
                blanks += 1
                if blanks > COLUMN_MAX_BLANKS:
                    break
            else:
                blanks = 0
                nonempty += 1
                if _fits(leads[j], rlens[j], gaps[j], g):
                    fits += 1
                    anchors += _is_anchor(gaps[j], g)
                    if fits >= COLUMN_FIT_SHARE * nonempty:
                        best = (j, fits, anchors)
                        misses = 0
                else:
                    misses += 1
                    if misses > COLUMN_MAX_MISSES:
                        break
            j += 1
        if best and best[2] >= COLUMN_RUN_MIN_ANCHORS and best[0] - i + 1 >= COLUMN_RUN_MIN_LINES:
            end = best[0]
            # Left-column lines just below the run (right column ended first).
            k = end + 1
            while (k < n and k - end <= COLUMN_TAIL_LINES and lines[k].strip()
                   and len(lines[k].rstrip()) <= g):
                end = k
                k += 1
            runs.append((i, end, best[1]))
            i = end + 1
        else:
            i = max(i + 1, j + 1)
    return runs


def split_columns(lines: list[str]) -> list[str]:
    """De-interleave two-column runs: left column first, then right column.

    Rule (adjusted from the plan after reading the CH_VB and CH_UNIBE
    fixtures, where the left column's right edge is ragged by 15+ chars, so
    gutters do not *start* at a common column; they *end* at one):

    - An anchor line has a run of 3+ spaces with at least 20 chars of text on
      each side. Each distinct anchor gap end (the column where the right
      column's text starts) is a candidate gutter column g.
    - A line fits g when it has text right of g and either nothing left of g
      (a right-column-only line) or a 3+ space run covering g. Right parts may
      be short ("Mehrheit"), so they need not be 20 chars.
    - A run at g starts at an anchor, has at least 4 lines and 2 anchors, ends
      on a fitting line, and at least 60 % of its non-empty lines fit g; it
      stops after 8 non-fitting non-empty lines since it last qualified, or at 2
      consecutive blank lines (both columns empty at once: a page header or
      the end of the two-column block, as in CH_VB "title  924  N  date"). Up to 3 directly
      following non-empty lines that end left of g are added (left column
      running longer than the right one).
    - Runs from all candidate columns compete: the run with the most fitting
      lines wins, ties go to the rightmost g, overlapping runs are dropped.
    - Inside a run each line is split at g (or at the nearest 2+ space gap
      within 6 chars of g, or at its indentation; a line whose text straddles
      g with no gap stays whole on the left). Emitted: all left parts, then all
      right parts; blank parts stay as blank lines. Lines outside runs pass
      through unchanged.
    """
    gaps = [_gaps(line) for line in lines]
    candidates = sorted({e for gs in gaps for _, e, a in gs if a})
    if not candidates:
        return list(lines)
    leads = [len(ln) - len(ln.lstrip()) for ln in lines]
    rlens = [len(ln.rstrip()) for ln in lines]
    found = []
    for g in candidates:
        for start, end, fits in _runs_at(lines, gaps, leads, rlens, g):
            found.append((fits, g, start, end))
    found.sort(key=lambda r: (-r[0], -r[1], r[2]))
    taken: list[tuple[int, int, int]] = []
    for _, g, start, end in found:
        if all(end < s or start > e for s, e, _ in taken):
            taken.append((start, end, g))
    taken.sort()
    out: list[str] = []
    pos = 0
    for start, end, g in taken:
        out.extend(lines[pos:start])
        parts = [_split_line(line, g) for line in lines[start:end + 1]]
        out.extend(left for left, _ in parts)
        out.extend(right for _, right in parts)
        pos = end + 1
    out.extend(lines[pos:])
    return out


def clean_pdf_text(raw: str, languages: list[str]) -> str:
    """Clean raw pdftotext-layout text; see the module docstring for the steps."""
    text = normalise_chars(raw).replace("\r\n", "\n").replace("\f", "\n\n\n")  # form feed = page seam
    lines = [ln.rstrip() for ln in text.split("\n")]
    lines = strip_page_furniture(lines)
    lines = split_columns(lines)
    if is_hard_wrapped("\n".join(lines)):
        lines = unwrap(lines, hyphen_vocabulary(languages))
    out: list[str] = []
    for line in lines:
        if not line.strip():
            if out and out[-1] == "":
                continue
            line = ""
        out.append(line)
    return "\n".join(out).strip()
