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
from collections import Counter

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
    re.compile(r"^\d{1,3}\s{3,}(\S.{0,99})$"),   # "13     PKG 2001"
    re.compile(r"^(.{0,99}\S)\s{3,}\d{1,3}$"),   # "PKG 2001       13"
)
REPEAT_MIN = 3
REPEAT_MAX_LEN = 120
FOLIO_HEADER_MIN = 2

HARD_WRAP_MIN_LINE = 20
HARD_WRAP_MEDIAN = 100

_PARAGRAPH_MARKER = re.compile(
    r"^(\d{1,3}\.\s|[A-Z]\.\d*(\.\d+)*\s|[a-z]\)\s|[IVX]{1,5}\.\s|Art\.\s|§\s?\d|E\.\s?\d"
    r"|Erwägung|Considérant|Considerando|Sachverhalt|Faits|Fatti|Dispositiv)")
_CONJUNCTION = re.compile(r"^(und|oder|bzw\.|sowie|et|ou|e|ed|o|od|u|ni)(?=[\s,.;]|$)")
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


def _folio_header_text(stripped: str) -> str | None:
    for pattern in _FOLIO_HEADER:
        m = pattern.match(stripped)
        if m:
            return " ".join(m.group(1).split())
    return None


def strip_page_furniture(lines: list[str]) -> list[str]:
    """Drop folios, page labels and running headers.

    Dropped: bare 1-3 digit lines, "Seite/Page/Pagina N", "- N -", any
    stripped line of at most 120 chars that occurs at least 3 times, and
    folio headers (a running title and a 1-3 digit folio separated by 3+
    spaces, e.g. "13     PKG 2001" / "PKG 2001       13") whose title occurs
    in at least 2 such lines. The title must recur so that a paragraph with a
    margin number ("13     Text") is never taken for a header.
    """
    stripped = [ln.strip() for ln in lines]
    counts = Counter(s for s in stripped if s and len(s) <= REPEAT_MAX_LEN)
    headers = [_folio_header_text(s) for s in stripped]
    header_counts = Counter(h for h in headers if h)
    out = []
    for line, s, header in zip(lines, stripped, headers):
        if s and (
            _FOLIO.match(line)
            or _PAGE_LABEL.match(line)
            or _DASH_FOLIO.match(line)
            or (len(s) <= REPEAT_MAX_LEN and counts[s] >= REPEAT_MIN)
            or (header and header_counts[header] >= FOLIO_HEADER_MIN)
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


def join_hyphen(head: str, tail: str, vocabulary: frozenset[str]) -> str:
    """Join ``head`` (ending in "-") with the next line ``tail``.

    - tail starts with a conjunction ("Kantons- und ..."): keep the hyphen, add a space;
    - tail starts uppercase or with a digit, or head ends "<digit>-": keep the hyphen;
    - both word parts are in ``vocabulary`` but the joined word is not: keep the hyphen;
    - otherwise it is a line-wrap hyphen: drop it and join.
    """
    if _CONJUNCTION.match(tail):
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


def _can_bridge(paragraph: str, nxt: str) -> bool:
    """A blank-line gap inside a sentence (page break, misaligned OCR column)."""
    last = paragraph[-1:]
    return (nxt[:1].islower() and not _PARAGRAPH_MARKER.match(nxt)
            and (last.isalpha() or last in ",-"))


def unwrap(lines: list[str], vocabulary: frozenset[str]) -> list[str]:
    """Rebuild paragraphs from hard-wrapped lines; one paragraph per output line.

    A line ends its paragraph when the next line is blank, or the next line
    starts with a paragraph marker (``_PARAGRAPH_MARKER``), or the line is
    shorter than 0.6 x the column width (90th percentile of non-empty line
    lengths) and the next line starts with an uppercase letter or a digit.
    Exception: blank lines are bridged when the paragraph ends in a letter,
    comma or hyphen and the next non-blank line starts lowercase without a
    marker (a page break in mid-sentence, e.g. "For-" / folio / "derungen").
    Blank lines that end a paragraph are kept as "".
    """
    short = SHORT_LINE_FACTOR * _column_width(lines)
    out: list[str] = []
    paragraph = ""
    prev_len = 0
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s:
            j = i
            while j < n and not lines[j].strip():
                j += 1
            if paragraph and j < n and _can_bridge(paragraph, lines[j].strip()):
                i = j
                continue
            if paragraph:
                out.append(paragraph)
                paragraph = ""
            out.extend([""] * (j - i))
            i = j
            continue
        if not paragraph:
            paragraph = s
        elif _PARAGRAPH_MARKER.match(s) or (
                prev_len < short and (s[0].isupper() or s[0].isdigit())):
            out.append(paragraph)
            paragraph = s
        elif _ends_wrap(paragraph):
            paragraph = join_hyphen(paragraph, s, vocabulary)
        else:
            paragraph = paragraph + " " + s
        prev_len = len(lines[i].rstrip())
        i += 1
    if paragraph:
        out.append(paragraph)
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


def _fits(line: str, gaps: list[tuple[int, int, bool]], g: int) -> bool:
    """The line has right-column text and splits cleanly at column g."""
    if not line[g:].strip():
        return False
    if not line[:g].strip():
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


def _runs_at(lines, gaps, g):
    """Maximal two-column runs at gutter column g: [(start, end, fits)]."""
    runs = []
    n = len(lines)
    i = 0
    while i < n:
        if not _is_anchor(gaps[i], g):
            i += 1
            continue
        nonempty = fits = anchors = misses = blanks = 0
        best = None
        j = i
        while j < n:
            line = lines[j]
            if not line.strip():
                blanks += 1
                if blanks > COLUMN_MAX_BLANKS:
                    break
            else:
                blanks = 0
                nonempty += 1
                if _fits(line, gaps[j], g):
                    fits += 1
                    misses = 0
                    anchors += _is_anchor(gaps[j], g)
                    if fits >= COLUMN_FIT_SHARE * nonempty:
                        best = (j, fits, anchors)
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
            i += 1
    return runs


def split_columns(lines: list[str]) -> list[str]:
    """De-interleave two-column runs: left column first, then right column.

    Rule (adjusted from the plan after reading the CH_VB and CH_UNIBE
    fixtures, where the left column's right edge is ragged by 15+ chars, so
    gutters do not *start* at a common column; they *end* at one):

    - An anchor line has a run of 3+ spaces with at least 20 chars of text on
      each side. Each column covered by an anchor's gap (start..end
      inclusive) is a candidate gutter column g.
    - A line fits g when it has text right of g and either nothing left of g
      (a right-column-only line) or a 3+ space run covering g. Right parts may
      be short ("Mehrheit"), so they need not be 20 chars.
    - A run at g starts at an anchor, has at least 4 lines and 2 anchors, ends
      on a fitting line, and at least 60 % of its non-empty lines fit g; it
      stops after 8 consecutive non-fitting non-empty lines or at 2
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
    candidates = sorted({c for gs in gaps for s, e, a in gs if a for c in range(s, e + 1)})
    if not candidates:
        return list(lines)
    found = []
    for g in candidates:
        for start, end, fits in _runs_at(lines, gaps, g):
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
    text = normalise_chars(raw).replace("\r\n", "\n").replace("\f", "\n")
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
