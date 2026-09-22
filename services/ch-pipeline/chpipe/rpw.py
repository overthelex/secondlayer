"""RPW/DPC -- "Recht und Politik des Wettbewerbs", the journal in which the
Swiss competition authorities publish their decisions -- cut into one
document per decision.

Why this exists: entscheidsuche.ch carries 117 WEKO files (CH_WEKO), all
from 2009 on. Measured against the RPW chronological index for 2016-2025
(weko.admin.ch, "Chronologisches Verzeichnis aller RPW ab 2016"), that is
~57 of 73 investigations, under 7% of the 282 merger decisions and none of
the Secretariat's preliminary investigations or advice. RPW has all of it,
every issue since 1997, as one PDF per issue.

An issue is not a list of files but one PDF of a few hundred pages, so a
document is a run of pages inside it. Two things in the text make the cut
reliable in every era of the journal (checked on 1999/1, 2008/1, 2024/2):

  * every page carries a running header with the issue and the journal's
    own page number -- "RPW/DPC   1999/1   94", "2024/2   372". Arabic
    numbers are content; the front matter and the index use roman ones.
  * every document opens with a heading that names its place in the
    journal's fixed systematics -- "B 2.3   1.   Post CH AG/Quickmail
    Holding AG": part B, chapter 2 (the Commission), section 3 (mergers),
    item 1. A chapter-level heading ("B2   3.   Unternehmenszusammenschlüsse")
    or one from another part ("B 3   1.", "C1", "D 2   Bibliographie")
    ends the document before it.

The table of contents is not parsed at all: its wrapped titles and its
numbering changed over the years (1999 numbers items "3.1", later issues
"1."), while the body headings did not.

Pure functions only; rpw_stage does the downloading and the writing.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date

import difflib

from .portals.common import parse_date, safe_doc_id

SPIDER = "CH_WEKO_RPW"
# Not the spider: ch_search_court_decisions treats a court_code filter as a
# prefix ("CH_WBK" matches "CH_WBK_%"), and entscheidsuche's WEKO rows carry
# CH_WBK_001 -- so one filter reaches both copies of WEKO's practice.
COURT_CODE = "CH_WBK_RPW"
COURT_NAME = "Wettbewerbskommission WEKO (RPW/DPC)"

# Part B, chapters 1 and 2: what the Secretariat and the Commission decided.
# Chapters 3-7 of part B and part C are court judgments RPW reprints (the
# Federal Administrative Court and Federal Court ones are already in the
# corpus from their own spiders), A is the annual report, D the notices and
# the bibliography.
DEFAULT_CHAPTERS = ("B1", "B2")

CHAPTER_NAMES = {
    "B1": "Sekretariat der Wettbewerbskommission",
    "B2": "Wettbewerbskommission",
    "B3": "Bundesverwaltungsgericht",
    "B4": "Bundesgericht",
    "B5": "Bundesrat",
    "B7": "Kantonale Gerichte",
    "C1": "Kantonale Gerichte",
    "C2": "Bundesgericht",
    "D1": "Erlasse, Bekanntmachungen",
}

# The section numbers of chapters B1 and B2 as the systematics page listed
# them in 2008/1 and 2024/2. ONLY A FALLBACK: the journal renumbered its
# sections over the years -- B 2.8 is "Diverses" in this table and "BGBM" in
# the 2016 issues -- so the label the issue itself prints above its items
# wins (see _SECTION and Document.section_name). Reading it from here alone
# mislabelled 59 rows.
SECTION_NAMES = {
    ("B1", "1"): "Vorabklärungen",
    ("B1", "2"): "Empfehlungen",
    ("B1", "3"): "Stellungnahmen",
    ("B1", "4"): "Beratungen",
    ("B1", "5"): "BGBM",
    ("B2", "1"): "Vorsorgliche Massnahmen",
    ("B2", "2"): "Untersuchungen",
    ("B2", "3"): "Unternehmenszusammenschlüsse",
    ("B2", "4"): "Sanktionen",
    ("B2", "5"): "Andere Entscheide",
    ("B2", "6"): "Gutachten",
    ("B2", "7"): "Stellungnahmen",
    ("B2", "8"): "Diverses",
    ("B2", "9"): "BGBM",
}

# The section names the journal uses, for spelling only: RPW prints
# "Stehlungnahmen", "Stellungsnahmen" and "Vorabklärung" for sections whose
# name is settled. A printed name close to one of these is recorded as that
# one; a name that is close to none of them is kept exactly as printed.
CANONICAL_SECTIONS = (
    "Vorabklärungen", "Empfehlungen", "Stellungnahmen", "Beratungen", "BGBM",
    "Untersuchungen", "Unternehmenszusammenschlüsse", "Vorsorgliche Massnahmen",
    "Sanktionen", "Andere Entscheide", "Gutachten", "Diverses",
)


def canonical_section(label: str) -> str:
    match = difflib.get_close_matches(label, CANONICAL_SECTIONS, n=1, cutoff=0.85)
    return match[0] if match else label


# "rpw_2001-3.pdf", "RPW 2018-4.pdf", "rpw_2021_4.pdf", "rpw_dpc_2024_2.pdf",
# "RPW 2025_4a.pdf", "DPC 2024-1.pdf", "RPW 2020-3b.pdf"
_ISSUE_FILE = re.compile(r"(?:rpw|dpc)[^0-9]*((?:19|20)\d\d)[-_ ]([1-6])([a-e])?\.pdf$", re.I)

# The running header: "RPW/DPC   1999/1   94", "2024/2   372", "2020/3a   877"
# (an issue printed in parts carries the part letter), optionally with the
# page number first on even pages.
_HEADER = re.compile(r"^\s*(?:RPW\s*/\s*DPC\s+)?((?:19|20)\d\d)\s*/\s*(\d)[a-e]?\s+([0-9]+|[IVXLC]+)\s*$")
_HEADER_NUM_FIRST = re.compile(r"^\s*([0-9]+|[IVXLC]+)\s+(?:RPW\s*/\s*DPC\s+)?((?:19|20)\d\d)\s*/\s*(\d)[a-e]?\s*$")

# A document's opening heading: part letter, chapter digit, ".", section
# number, then the item number. Title after a run of spaces.
_ITEM = re.compile(r"^\s*([A-E])\s?(\d)\s?\.\s?(\d{1,2})\s{2,}(\d{1,3})\.\s+(\S.*?)\s*$")
# The section heading the issue prints above its items: "B2   3.
# Unternehmenszusammenschlüsse", "B 2.   8.   BGBM". Chapter, then the
# section number as its own item number, then the section's German name --
# never a case name, so a trailing page number or a lower-case start rules
# it out.
_SECTION = re.compile(r"^\s*([A-E])\s?(\d)\.?\s{2,}(\d{1,2})\.\s{2,}([A-ZÄÖÜ][^\d]{2,60}?)\s*$")
# The same shape carries the DOCUMENTS of a chapter that has no sections:
# "D1   1.   Bekanntmachung über die wettbewerbsrechtliche Behandlung ...",
# "B3   1.   Urteil vom 12. Dezember 2023 ...". Which reading applies is
# decided per issue in split(): a chapter that numbers its items with a
# section ("B 2.3   1.") is sectioned, and there the same line is a section
# heading; a chapter that never does is not, and there it is a document.
_CHAPTER_ITEM = re.compile(r"^\s*([A-E])\s?(\d)\.?\s{2,}(\d{1,3})\.\s+(\S.*?)\s*$")
# "D1    Erlasse, Bekanntmachungen" -- the chapter's own name, no number.
_CHAPTER = re.compile(r"^\s*([A-E])\s?(\d)\s{2,}([A-ZÄÖÜ][^\d]{3,60}?)\s*$")
# Anything that closes the previous document: a chapter or section heading
# of any part, with or without an item number ("B2   3.   Untersuchungen",
# "B 3   1.   Urteil ...", "C1   1.", "D 2   Bibliographie", "E2   1.").
_BOUNDARY = re.compile(r"^\s*[A-E]\s?\d(?:\s?\.\s?\d{1,2})?\.?\s{2,}(?:\d{1,3}\.\s+)?[A-ZÄÖÜÀ-Ý0-9«\"„(]")
# Two-column pages: the right column starts after a wide gap. A heading
# line is full width, but a wrapped title continuation can share its line
# with the other column's text.
_COLUMN_GAP = re.compile(r"\s{4,}")

# Nouns that name the document itself. Not "Schreiben", "Bericht" or
# "Eingabe": those open the recital ("Mit Schreiben vom 3. März 2024 meldete
# ...") and date a letter, not the decision.
_DATE_CUE = re.compile(
    r"(?:Verfügung|Entscheid|Beschluss|Stellungnahme|Gutachten|Empfehlung|Schlussbericht|"
    r"Zwischenverfügung|"
    r"[Dd]écision|[Pp]réavis|[Aa]vis|[Rr]ecommandation|[Rr]apport final|[Dd]écision incidente|"
    r"[Dd]ecisione|[Pp]arere|[Rr]accomandazione|[Rr]apporto finale)"
    r"[^.\n]{0,60}?\b(?:vom|du|del|dell['’])\s+")


@dataclass(frozen=True)
class Issue:
    year: int
    number: int
    part: str            # "" or "a"/"b"/"c": 2020/3 came as 2020-3a and 2020-3b

    @property
    def label(self) -> str:               # as the journal prints it: "2024/2", "2020/3a"
        return f"{self.year}/{self.number}{self.part}"

    @property
    def key(self) -> str:                 # as ids use it
        return f"{self.year}-{self.number}{self.part}"


# The link text on the RPW page: "RPW 2019-3a", "DPC 2024-1". Seven issues
# have file names that say nothing (rpw.pdf is 2019/3a, rpw20193.pdf 2019/3b,
# rpw_2013-1.1.pdf ...), and the per-issue indexes ("Index 2008-1") and an
# annual report ("Jahresbericht 1999") sit in the same list.
_ISSUE_LABEL = re.compile(r"^\s*(?:RPW|DPC)\s+((?:19|20)\d\d)[-/ ]([1-6])([a-e])?\b", re.I)


def issue_of(filename: str) -> Issue | None:
    m = _ISSUE_FILE.search(filename)
    if not m:
        return None
    return Issue(int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower())


def issue_of_link(text: str | None, filename: str) -> Issue | None:
    """The issue a link on the RPW page is: its text when that names one
    (authoritative), else its file name. None for an index or a report."""
    m = _ISSUE_LABEL.match(text or "")
    if m:
        return Issue(int(m.group(1)), int(m.group(2)), (m.group(3) or "").lower())
    if re.match(r"^\s*(?:index|jahresbericht|verzeichnis)", text or "", re.I):
        return None
    return issue_of(filename)


@dataclass
class Page:
    index: int                  # 1-based page of the PDF file
    number: str | None          # the journal's own page number, as printed
    lines: list[str]            # the text lines, running header removed

    @property
    def arabic(self) -> int | None:
        return int(self.number) if self.number and self.number.isdigit() else None


def pages_of(text_pages: list[str], issue: Issue | None = None) -> list[Page]:
    """pdftotext output split on form feeds -> pages with their journal page
    number read off the running header (and the header line dropped)."""
    out: list[Page] = []
    for i, raw in enumerate(text_pages, start=1):
        lines = raw.splitlines()
        number = None
        for j, line in enumerate(lines[:4]):
            if not line.strip():
                continue
            m = _HEADER.match(line)
            if m and (issue is None or (int(m.group(1)), int(m.group(2))) == (issue.year, issue.number)):
                number = m.group(3)
                lines = lines[:j] + lines[j + 1:]
                break
            m = _HEADER_NUM_FIRST.match(line)
            if m and (issue is None or (int(m.group(2)), int(m.group(3))) == (issue.year, issue.number)):
                number = m.group(1)
                lines = lines[:j] + lines[j + 1:]
                break
            break           # the first non-empty line is not a header: none on this page
        out.append(Page(i, number, lines))
    return out


@dataclass
class Document:
    chapter: str                # "B2"
    section: str                # "3", or "" in a chapter that has no sections (D1)
    item: int                   # 1
    title: str
    start_page: Page
    text: str
    journal_pages: tuple[int | None, int | None] = (None, None)
    extra: dict = field(default_factory=dict)
    # Set by split() when the journal printed the same systematics number
    # twice in one issue (2010/3, 2016/1 and 2018/3 each do): the journal page
    # tells the two apart, and without it the second row overwrote the first.
    id_suffix: str = ""
    # The section name as THIS issue prints it above the items, when it does.
    section_label: str | None = None

    @property
    def section_name(self) -> str | None:
        """What the journal calls the part of itself this document sits in.
        The issue's own heading first, because the numbering moved over the
        years; the tables only when the issue prints no heading. For a
        chapter without sections (D1) that is the chapter's own name."""
        if not self.section:
            return self.section_label or CHAPTER_NAMES.get(self.chapter)
        return self.section_label or SECTION_NAMES.get((self.chapter, self.section))


def _heading_title(lines: list[str], at: int) -> str:
    """The title of the heading on line `at`, with the continuation lines a
    long title wraps onto (up to two, stopping at a blank line or at the
    next heading), each cut at the column gap."""
    m = _ITEM.match(lines[at])
    if m:
        first = m.group(5)
    else:
        flat = _CHAPTER_ITEM.match(lines[at])      # a chapter without sections: D1, B3
        first = flat.group(4) if flat else None
    parts = [_COLUMN_GAP.split(first.strip())[0]] if first else []
    for nxt in lines[at + 1: at + 3]:
        s = nxt.strip()
        if not s or _BOUNDARY.match(nxt):
            break
        # A continuation is indented like the title, not a body paragraph
        # starting in the left margin with a paragraph number ("1.  Die ...").
        lead = len(nxt) - len(nxt.lstrip())
        if lead < 4 or re.match(r"^\d{1,3}\.\s", s):
            break
        parts.append(_COLUMN_GAP.split(s)[0])
    title = ""
    for part in parts:
        # "Carrier Corpora-" + "tion": a hyphenated break, not a compound
        # dash ("Hoch- und Tiefbau" keeps its hyphen and space).
        if title.endswith("-") and part[:1].islower() and not part.startswith("und "):
            title = title[:-1] + part
        else:
            title = f"{title} {part}" if title else part
    return re.sub(r"\s+", " ", title).strip(" -–")


def split(pages: list[Page], chapters: tuple[str, ...] = DEFAULT_CHAPTERS) -> list[Document]:
    """The documents of the wanted chapters, each with its text: from its
    heading to the next heading of any kind, across pages. Front matter and
    index pages (roman page numbers, or no header at all) are skipped."""
    # The content runs from the first arabic-numbered page to the last. A
    # page inside that run without a readable header is still content --
    # 2024/2 opens its court chapter (B3) on one, and dropping it glued the
    # Federal Administrative Court's judgments onto the last merger decision.
    # Roman-numbered pages (the index at the back) are not.
    arabic = [i for i, p in enumerate(pages) if p.arabic is not None]
    if not arabic:
        return []
    content = [p for p in pages[arabic[0]: arabic[-1] + 1]
               if p.number is None or p.arabic is not None]
    # Every heading line on the content pages, in reading order. Which
    # chapters number their items with a section is read off the issue
    # itself, because that is what decides how "D1   1.   ..." reads.
    raw: list[tuple[int, int, str]] = []
    sectioned: set[str] = set()
    for pi, page in enumerate(content):
        for li, line in enumerate(page.lines):
            if not _BOUNDARY.match(line):
                continue
            raw.append((pi, li, line))
            item = _ITEM.match(line)
            if item:
                sectioned.add(f"{item.group(1)}{item.group(2)}")

    marks: list[tuple[int, int, re.Match | None, str]] = []   # + the section number, "" at chapter level
    labels: dict[tuple[str, str], str] = {}                   # (chapter, section) -> the issue's own name
    chapter_labels: dict[str, str] = {}
    for pi, li, line in raw:
        item = _ITEM.match(line)
        if item:
            marks.append((pi, li, item, item.group(3)))
            continue
        flat = _CHAPTER_ITEM.match(line)
        chapter = f"{flat.group(1)}{flat.group(2)}" if flat else None
        if flat and chapter not in sectioned:
            # A chapter with no sections in this issue: this is a document.
            marks.append((pi, li, flat, ""))
            continue
        sec = _SECTION.match(line)
        if sec:
            key = (f"{sec.group(1)}{sec.group(2)}", sec.group(3))
            name = canonical_section(re.sub(r"\s+", " ", sec.group(4)).strip())
            # One name per section within an issue: RPW 2017/3 prints
            # "B2 8. Unternehmenszusammenschlüsse" over its BGBM
            # section, which is also the name of its section 3. A name
            # already bound to another section is a misprint, not a
            # second section, and the fallback table answers instead.
            taken = {v: k for k, v in labels.items()}
            if key not in labels and taken.get(name, key) == key:
                labels[key] = name
        else:
            chap = _CHAPTER.match(line)
            if chap:
                chapter_labels.setdefault(f"{chap.group(1)}{chap.group(2)}",
                                          re.sub(r"\s+", " ", chap.group(3)).strip())
        marks.append((pi, li, None, ""))
    docs: list[Document] = []
    for k, (pi, li, m, section) in enumerate(marks):
        if not m:
            continue
        chapter = f"{m.group(1)}{m.group(2)}"
        if chapter not in chapters:
            continue
        end_pi, end_li = (marks[k + 1][0], marks[k + 1][1]) if k + 1 < len(marks) else (len(content) - 1, None)
        chunks: list[str] = []
        for q in range(pi, end_pi + 1):
            lines = content[q].lines
            lo = li if q == pi else 0
            hi = end_li if (q == end_pi and end_li is not None) else len(lines)
            chunks.append("\n".join(lines[lo:hi]))
        text = "\n".join(c for c in chunks if c.strip())
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        last = end_pi if (end_li is None or end_li > 0 or end_pi == pi) else end_pi - 1
        item_no = int(m.group(4)) if section else int(m.group(3))
        docs.append(Document(
            chapter=chapter, section=section, item=item_no,
            title=_heading_title(content[pi].lines, li),
            start_page=content[pi], text=text,
            journal_pages=(_journal_page(content, pi), _journal_page(content, last)),
            section_label=(labels.get((chapter, section)) if section
                           else chapter_labels.get(chapter)),
        ))
    seen: dict[tuple, int] = {}
    for d in docs:
        key = (d.chapter, d.section, d.item)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:            # the first keeps the plain id: rows already loaded stay put
            d.id_suffix = f"_S{d.journal_pages[0] if d.journal_pages[0] is not None else d.start_page.index}"
    return docs


def _journal_page(content: list[Page], at: int) -> int | None:
    """The journal page of content[at]; a header-less page is the one after
    the nearest numbered page before it."""
    for back in range(at, -1, -1):
        n = content[back].arabic
        if n is not None:
            return n + (at - back)
    return None


def reading_order(text: str, max_lines: int = 120) -> str:
    """The opening of a two-column page in reading order: the left column's
    lines, then the right column's. pdftotext -layout prints the columns
    side by side, so "Stellungnahme der Wettbewerbskommission vom 25." and
    "April 2024" sit on two lines with the other column's text between
    them. The split is the character position where the right column most
    often starts (a run of 3+ spaces ending between columns 30 and 95); a
    single-column opening has no such position and comes back unchanged."""
    lines = text.splitlines()[:max_lines]
    starts: dict[int, int] = {}
    for line in lines:
        for m in re.finditer(r"\S\s{3,}(?=\S)", line):
            pos = m.end()
            if 30 <= pos <= 95:
                starts[pos] = starts.get(pos, 0) + 1
    if not starts:
        return "\n".join(lines)
    # Columns wobble by a character or two with justified text: pool neighbours.
    best = max(starts, key=lambda p: sum(starts.get(p + d, 0) for d in (-2, -1, 0, 1, 2)))
    if sum(starts.get(best + d, 0) for d in (-2, -1, 0, 1, 2)) < 5:
        return "\n".join(lines)
    split = best - 2
    left = [ln[:split].rstrip() for ln in lines]
    right = [ln[split:].strip() for ln in lines]
    return "\n".join(left) + "\n" + "\n".join(r for r in right if r)


def decision_date(text: str, window: int = 4000) -> date | None:
    """The decision's own date as its opening states it: "Verfügung vom
    23. Mai 2022", "Décision du 12 décembre 2022", "Parere del ...". The
    first cue with a readable date after it wins; None when the opening
    names none (the stage then leaves decision_date empty rather than
    guessing from the issue)."""
    head = re.sub(r"\s+", " ", reading_order(text[:window]))
    for m in _DATE_CUE.finditer(head):
        # "Mit Verfügung vom ...", "par décision du ...": a recital citing an
        # earlier act of the authority, not this document's own date.
        before = head[max(0, m.start() - 8): m.start()].strip().lower()
        if before.endswith(("mit", "durch", "par", "avec", "con", "gemäss", "selon", "secondo")):
            continue
        d = parse_date(head[m.end(): m.end() + 40])
        if d and 1990 <= d.year <= 2100:
            return d
    return None


def doc_id(issue: Issue, doc: Document) -> str:
    """RPW_2024-2_B2.3.1 -> safe: `RPW_2024-2_B2.3.1`. The systematics
    position is unique within an issue; the issue key keeps 2020-3a and
    2020-3b apart."""
    place = f"{doc.chapter}.{doc.section}.{doc.item}" if doc.section else f"{doc.chapter}.{doc.item}"
    return safe_doc_id(f"RPW_{issue.key}_{place}{doc.id_suffix}")


def citation(issue: Issue, doc: Document) -> str:
    """How the practice cites it: "RPW 2024/2, S. 375"."""
    page = doc.journal_pages[0]
    return f"RPW {issue.label}, S. {page}" if page is not None else f"RPW {issue.label}"


def norm_title(s: str | None) -> str:
    """For matching an RPW document to the same decision among the
    entscheidsuche CH_WEKO rows: accents, case, the "Zusammenschlussvorhaben"
    prefix and punctuation gone."""
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"zusammenschlussvorhaben|operation de concentration|verfugung|"
               r"vorsorgliche massnahmen|[^a-z0-9 ]", " ", s)
    return " ".join(s.split())
