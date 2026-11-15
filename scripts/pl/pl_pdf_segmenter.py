#!/usr/bin/env python3
"""Split a PDF-only Polish act (Dziennik Ustaw) into articles and headings.

No database, no network: pdf path in, articles + headings + verdict out, so it can
be tested on fixtures and re-run over the cached PDFs.

Why this is safe now when harvest_eli_pdf.py refused to do it. pdftotext flattens
superscripts, so "Art. 304(4)" and "Art. 3044" read the same. PyMuPDF does not:
every span carries its font flags, and the Dziennik Ustaw typesetting is regular
enough to read the article number exactly. Measured on DU/2026/1245 (Kodeks pracy,
tekst jednolity 2026) and DU/2026/795 (Kodeks cywilny 2026):

  * an article heading is a bold span (flags & 16) at the start of a line:
    "Art. 3" + superscript "[1]" + "."  ->  3^1
    "Art. 18" + superscript "[3a]" + "." ->  18^3a
  * superscripts are flagged (flags & 1); article/paragraph number superscripts
    are printed in brackets ("[1]"), footnote markers are not ("5)")
  * footnotes are set a point smaller than the body (9 pt vs 10 pt) at the foot
    of the page; the running head is "Dziennik Ustaw / – 3 – / Poz. 1245"

The output is then checked against the previous, HTML+struct-segmented edition
of the same act, because consolidations do not renumber: an article number the
previous edition had must still be there (repealed ones stay as "(uchylony)").
Anything that fails the checks is rejected whole - an unsegmented text is a
nuisance, a wrong article number is a wrong answer.
"""
import collections
import re

OK = 200
NO_ANNEX = 911            # a consolidation PDF without "Załącznik do obwieszczenia"
NO_ARTICLES = 912
NONMONOTONIC = 913        # article numbers go backwards
COVERAGE = 914            # too few of the previous edition's articles found
EMPTY_ARTICLES = 915      # too many articles with no text

MIN_COVERAGE = 0.97       # share of the previous edition's article numbers found
MAX_EMPTY = 0.02
MAX_BACKWARDS = 2         # only with a previous edition, see validate()

BOLD, SUPER = 16, 1
HEADER_RE = re.compile(r"^(Dziennik Ustaw|Monitor Polski|[–-]\s*\d+\s*[–-]|Poz\.\s*\d+)$")
ANNEX_RE = re.compile(r"^Za[łl][aą]cznik do obwieszczenia", re.IGNORECASE)
# The whole bold prefix of a heading line after superscript rendering: "Art. 18^3a."
ART_HEAD_RE = re.compile(r"^Art\.\s*(\d+)([a-z]{0,3})(?:\^([0-9]+[a-z]{0,3}|[a-z]{1,3}))?"
                         r"(?:\s*[–‒—-]\s*(\d+)([a-z]{0,3})(?:\^([0-9]+[a-z]{0,3}))?)?\s*\.")
BRACKET_SUP_RE = re.compile(r"^\[([0-9a-z]{1,6})\]$")
FOOTNOTE_MARK_RE = re.compile(r"^\d{1,3}\)$")
# Heading keyword -> (unit_type, rank). Rank orders the levels; depth is the rank
# among the levels this act actually uses, matching how struct nests them.
HEADINGS = {
    "księga": ("book", 0), "część": ("part", 1), "tytuł": ("titl", 2),
    "dział": ("bran", 3), "rozdział": ("chpt", 4), "oddział": ("schp", 5),
}
HEADING_RE = re.compile(
    r"^(KSIĘGA|Księga|CZĘŚĆ|Część|TYTUŁ|Tytuł|DZIAŁ|Dział|ROZDZIAŁ|Rozdział|ODDZIAŁ|Oddział)"
    r"\s+((?:[0-9IVXLC]+[a-z]{0,3}|[A-ZĄĆĘŁŃÓŚŹŻ]{3,}(?:_[a-z])?)(?:\^[0-9a-z]{1,4})?)\s*$")
PARA_BREAK_RE = re.compile(r"^(§\s*\d+[a-z]*(\^\w+)?\.|\d+[a-z]*(\^\w+)?\)|[a-z]{1,2}\)|[–-]\s)")


def _line_text(spans, markers=None):
    """Spans -> text, rendering bracketed superscripts as ^X and dropping footnote markers.

    Footnote marker numbers are appended to `markers` when a list is given.
    """
    out = []
    for s in spans:
        t = s["text"]
        if s["flags"] & SUPER:
            st = t.strip()
            m = BRACKET_SUP_RE.match(st)
            if m:
                out.append("^" + m.group(1) + (" " if t.endswith(" ") else ""))
            elif FOOTNOTE_MARK_RE.match(st):
                if markers is not None:
                    markers.append(st[:-1])
                out.append(" " if t.endswith(" ") else "")
            elif st:
                out.append("^" + st)
            continue
        out.append(t)
    return re.sub(r"[ \t]+", " ", "".join(out)).strip()


FOOTNOTE_DEF_RE = re.compile(r"^(\d{1,3})\)\s*(.*)$")


def _footnotes(small_spans):
    """Small-print spans of one page -> {number: text}.

    The marker column and the text column of a footnote are separate blocks in
    the PDF, so lines are rebuilt from the baseline instead of from PyMuPDF's
    line grouping (pdftotext prints "5)\n6)\nW tym brzmieniu..." for the same reason).
    """
    rows = collections.defaultdict(list)
    for s in small_spans:
        rows[round(s["origin"][1])].append(s)
    notes, cur = {}, None
    for y in sorted(rows):
        text = re.sub(r"[ \t]+", " ", "".join(
            s["text"] for s in sorted(rows[y], key=lambda s: s["origin"][0]))).strip()
        if not text:
            continue
        m = FOOTNOTE_DEF_RE.match(text)
        if m:
            cur = m.group(1)
            notes[cur] = m.group(2)
        elif cur is not None:
            prev = notes[cur]
            notes[cur] = (prev[:-1] + text if prev.endswith("-") and text[:1].islower()
                          else (prev + " " + text).strip())
    return notes


def read_lines(doc):
    """PDF -> (lines, footnotes).

    lines: [(text, bold_prefix, is_bold_start, footnote_markers)] for the body, with
    footnotes and running heads dropped; footnotes: {number: text}, later pages
    winning (the annex numbers its footnotes after the obwieszczenie's).
    """
    sizes, head_sizes = collections.Counter(), collections.Counter()
    pages = []
    for page in doc:
        lines = []
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                spans = [s for s in ln["spans"] if s["text"]]
                if spans:
                    lines.append(spans)
                    for s in spans:
                        if not s["flags"] & SUPER:
                            sizes[round(s["size"], 1)] += len(s["text"].strip())
                            if s["flags"] & BOLD and s["text"].startswith("Art."):
                                head_sizes[round(s["size"], 1)] += 1
        pages.append(lines)
    if not sizes:
        return [], {}
    # Body size = the size article headings are set in; the character mode only as a
    # fallback, since a short act with a long footnote has more small print than body.
    body = (head_sizes or sizes).most_common(1)[0][0]
    out, footnotes = [], {}
    for lines in pages:
        small = []
        for i, spans in enumerate(lines):
            normal = [s for s in spans if not s["flags"] & SUPER and s["text"].strip()]
            if not normal:
                continue
            markers = []
            text = _line_text(spans, markers)
            if not text:
                continue
            # Footnotes and other small print go - except the annex marker, set small
            # in the top corner, which is where the consolidated text begins.
            if max(s["size"] for s in normal) < body - 0.4 and not ANNEX_RE.match(text):
                small += normal
                continue
            if i < 4 and HEADER_RE.match(text):
                continue
            # The bold run at the start of the line: where an article heading lives.
            bold = []
            for s in spans:
                if s["flags"] & BOLD or (s["flags"] & SUPER and bold):
                    bold.append(s)
                elif s["text"].strip():
                    break
            out.append((text, _line_text(bold) if bold else "", bool(bold), markers))
        footnotes.update(_footnotes(small))
    return out, footnotes


def art_key(no):
    """Sort key for an article number: 18^3a -> (18, '', 3, 'a')."""
    m = re.match(r"^(\d+)([a-z]*)(?:\^(\d*)([a-z]*))?", no)
    if not m:
        return (0, "", 0, "")
    return (int(m.group(1)), m.group(2), int(m.group(3) or 0), m.group(4) or "")


def steps_back(nos):
    """Adjacent pairs that go backwards, judged on the digits only.

    Letter suffixes follow the amendment history, not an alphabet: one act has
    13da before 13e, another 9z before 9aa, 22^1 before 22a. So the base number
    must not fall, and the superscript must not fall within one base+letters.
    The digits are what a misread superscript would corrupt.
    """
    out = []
    for x, y in zip(nos, nos[1:]):
        kx, ky = art_key(x), art_key(y)
        if ky[0] < kx[0] or (ky[0] == kx[0] and ky[1] == kx[1] and ky[2] < kx[2]):
            out.append((x, y))
    return out


def _join(lines):
    """Article body lines -> text: undo line-end hyphenation, blank line before §/points."""
    parts = []
    for ln in lines:
        if parts and parts[-1].endswith("-") and not parts[-1].endswith(" -") \
                and ln[:1].islower():
            parts[-1] = parts[-1][:-1] + ln
            continue
        if parts and PARA_BREAK_RE.match(ln):
            parts.append("")
        parts.append(ln)
    return "\n".join(parts).strip()


NOTE_REF_RE = re.compile(r"odnośnik(?:u|ach|iem)?\s+(\d{1,3})")


def _with_references(markers, footnotes):
    """Footnote numbers plus the ones they cite: "ustawy, o której mowa w odnośniku 6"
    is only readable next to footnote 6, which names the act and its entry into force."""
    seen, queue = [], list(dict.fromkeys(markers))
    while queue:
        n = queue.pop(0)
        if n in seen or not footnotes.get(n) or len(seen) >= 8:
            continue
        seen.append(n)
        queue += NOTE_REF_RE.findall(footnotes[n])
    return seen


def segment(lines, consolidation, footnotes=None):
    """Body lines -> (verdict, articles, headings).

    An article whose text carries footnote markers gets those footnotes appended:
    in a consolidated text they are what says which of two printed versions of
    an article is in force ("W tym brzmieniu obowiązuje do wejścia w życie zmiany...").
    """
    footnotes = footnotes or {}
    start = 0
    if consolidation:
        idx = next((i for i, ln in enumerate(lines) if ANNEX_RE.match(ln[0])), None)
        if idx is None:
            return NO_ANNEX, [], []
        start = idx + 1
    articles, headings = [], []
    cur = None
    for text, bold, is_bold, markers in lines[start:]:
        hm = HEADING_RE.match(text)
        if hm:
            headings.append({"kind": hm.group(1).lower(), "name": hm.group(2), "title": [],
                             "article_ord": len(articles)})
            cur = None
            continue
        # The bold run can stop short of the number ("Art. 12" bold, "‒14. (pominięte)" not),
        # so the heading is read from the line once the line starts with a bold "Art.".
        m = ART_HEAD_RE.match(text) if is_bold and bold.startswith("Art.") else None
        if m:
            no = m.group(1) + m.group(2)
            if m.group(3):
                no += "^" + m.group(3)
            if m.group(4):
                no += "-" + m.group(4) + m.group(5) + ("^" + m.group(6) if m.group(6) else "")
            rest = text[len(m.group(0)):] if text.startswith(m.group(0)) else ""
            cur = {"art_no": no, "lines": [rest.strip()] if rest.strip() else [], "notes": list(markers)}
            articles.append(cur)
            continue
        if cur is not None:
            cur["lines"].append(text)
            cur["notes"] += markers
        elif headings and headings[-1]["article_ord"] == len(articles):
            headings[-1]["title"].append(text)  # lines between a heading and its first article
    if not articles:
        return NO_ARTICLES, [], []
    for a in articles:
        a["text"] = _join(a.pop("lines"))
        notes = [f"{n}) {footnotes[n]}" for n in _with_references(a.pop("notes"), footnotes)]
        if notes and a["text"]:
            a["text"] += "\n\nPrzypisy:\n" + "\n".join(notes)
    for h in headings:
        h["title"] = " ".join(h["title"]) or None
    return OK, articles, headings


REPEALED_RE = re.compile(r"\(uchylon[ya]?\)|\buchylon[ey]\b", re.IGNORECASE)


def _explained_gaps(articles, headings, previous):
    """Previous-edition articles that are missing because a whole unit was repealed.

    "DZIAŁ JEDENASTY (uchylony)" replaces the 30-odd articles of that division
    with one heading (Kodeks pracy, 2026). A missing run is explained when the
    articles either side of it are adjacent in the new text and a heading marked
    repealed sits between them.
    """
    pos = {}
    for i, a in enumerate(articles):
        pos.setdefault(a["art_no"], i)
    repealed_at = {h["article_ord"] for h in headings
                   if REPEALED_RE.search(h.get("title") or "")}
    # "Art. 80a–85d. (pominięte)" stands for every article in between.
    ranges = [(art_key(a), art_key(b)) for a, b in
              (r["art_no"].split("-", 1) for r in articles if "-" in r["art_no"])]
    explained = {no for no in previous if no not in pos and
                 any(lo <= art_key(no) <= hi for lo, hi in ranges)}
    run, before = [], None
    for no in list(previous) + [None]:
        if no is not None and no not in pos:
            run.append(no)
            continue
        if run:
            after = pos.get(no) if no is not None else len(articles)
            start = pos[before] + 1 if before is not None else 0
            if after == start and start in repealed_at:
                explained.update(run)
            run = []
        before = no
    return explained


def validate(articles, previous, headings=()):
    """previous: art_no list (document order) of the last struct-segmented edition, or None."""
    back = steps_back([a["art_no"] for a in articles])
    # With a previous edition to check against, a step or two back is the source's own
    # ordering (the HTML pass stores these too, counted in `nonmonotonic`); without one,
    # a step back is the only sign of a misread or quoted article, so none is allowed.
    if back and (not previous or len(back) > MAX_BACKWARDS):
        return NONMONOTONIC, {"backwards": len(back), "at": back[:3]}
    empty = sum(1 for a in articles if not a["text"])
    if empty > max(2, MAX_EMPTY * len(articles)):
        return EMPTY_ARTICLES, {"empty": empty}
    if previous:
        found = {a["art_no"] for a in articles}
        prev = set(previous)
        repealed = _explained_gaps(articles, headings, previous)
        cov = len(prev & found) / len(prev - repealed)
        if cov < MIN_COVERAGE:
            return COVERAGE, {"coverage": round(cov, 4),
                              "missing": sorted(prev - found - repealed, key=art_key)[:15]}
        return OK, {"coverage": round(cov, 4), "new": len(found - prev), "backwards": len(back),
                    **({"repealed_units": len(repealed)} if repealed else {})}
    if art_key(articles[0]["art_no"])[0] != 1:
        return NONMONOTONIC, {"first": articles[0]["art_no"]}
    return OK, {}


def heading_units(headings, articles):
    """Headings + articles -> pl_act_units-shaped dicts in document order."""
    ranks = sorted({HEADINGS[h["kind"]][1] for h in headings})
    depth_of = {r: i for i, r in enumerate(ranks)}
    art_depth = len(ranks)
    units, stack = [], []
    hi = 0
    for ai in range(len(articles) + 1):
        while hi < len(headings) and headings[hi]["article_ord"] == ai:
            h = headings[hi]
            utype, rank = HEADINGS[h["kind"]]
            depth = depth_of[rank]
            while stack and stack[-1][0] >= depth:
                stack.pop()
            label = h["kind"].capitalize() + " " + h["name"]
            units.append({"depth": depth, "unit_type": utype, "name": h["name"],
                          "title": label + (" - " + h["title"] if h["title"] else ""),
                          "parent": stack[-1][1] if stack else None, "article_ord": None})
            stack.append((depth, len(units) - 1))
            hi += 1
        if ai < len(articles):
            a = articles[ai]
            units.append({"depth": art_depth, "unit_type": "arti",
                          "name": a["art_no"].replace("^", "_"),
                          "title": "Art. " + a["art_no"] + ".",
                          "parent": stack[-1][1] if stack else None, "article_ord": ai + 1})
    return units
