"""WEKO's vertical-restraints notice, cut into the propositions the audit
labels, and aligned across its versions (2002 -> 2022).

The instrument has two parts and they are not alike:

  * a preamble of recitals numbered in roman ("I. Gemäss Artikel 6 des
    Bundesgesetzes ..."), which is where the agency says what it is doing and
    why -- the part a codification claim lives in;
  * an operative part of numbered units, called "Ziffer" until 2017 and
    "Artikel" from 2022, each with a heading and, usually, subparagraphs
    "(1)", "(2)". A unit without subparagraphs is one proposition.

One proposition is one recital, or one subparagraph, or a whole unit when it
has none. That is the granularity a decision can support or fail to support:
a whole article states several rules at once, and a sentence is too small to
carry the rule it is part of.

Two texts of the same version can differ in their reading order without
differing in content: the journal sets two columns and pdftotext -layout
interleaves them line by line, while the PDFs on weko.admin.ch are single
column (measured: word overlap 0.91-0.93, character similarity 0.18-0.36).
`read_text` therefore reconstructs the columns when the source is the journal.

Usage:
    python3 propositions.py parse --dir /data/ch-corpus/weko-bek
    python3 propositions.py align --dir /data/ch-corpus/weko-bek --out table.json
"""
from __future__ import annotations

import argparse
import difflib
import json
import pathlib
import re
import sys
import unicodedata
from dataclasses import dataclass, field

ROMAN = "I II III IV V VI VII VIII IX X XI XII XIII XIV XV XVI XVII XVIII XIX XX".split()

# A recital opens with a roman numeral ("I.", "VIII.") in 2010 and later, and
# with an arabic one in brackets ("(1)") in 2002 and 2007. Both forms only
# count before the first unit heading: "(1)" inside the operative part is a
# subparagraph, not a recital.
_RECITAL = re.compile(r"^\s{0,12}(?:(" + "|".join(ROMAN) + r")\.|\((\d{1,2})\)|(\?\?|•|■|–))\s+(\S.*)$")
# "Ziffer 8   Geltungsbereich", "Artikel 12   Vermutungstatbestände", and --
# 2002, where the journal sets the heading on the next line -- a bare
# "Ziffer 1".
# A heading is a short line that names the unit and stops: no closing period,
# no running prose. Without that, "Artikel 6 KG auch andere Grundsätze der
# Rechtsanwendung ..." inside a recital reads as the heading of article 6 and
# swallows the preamble.
_UNIT = re.compile(r"^\s{0,12}(Ziffer|Artikel)\s+(\d{1,2})"
                   r"(?:\s+([A-ZÄÖÜ][^.]{2,58}))?\s*$")
# A subparagraph opens as "(1)" until 2017 and as a bare "1" from 2022.
_SUBPARA = re.compile(r"^\s{0,12}(?:\((\d{1,2})\)|(\d{1,2}))\s+([A-ZÄÖÜ].*)$")
# The lettered points inside a subparagraph: "a) Festsetzung von Mindest-...".
# They carry the rules an audit is most interested in (the hardcore list), so
# each is a proposition of its own.
_LETTER = re.compile(r"^\s{0,12}([a-h])\)\s+(\S.*)$")
# A footnote under the rule: "1 SR 251", "2 Vgl. RPW 2010/1, S. 1". Same
# shape as a 2022 subparagraph, so the two are told apart by what follows:
# a citation opener, not a sentence.
_FOOTNOTE = re.compile(r"^\s{0,8}\d{1,3}\s+(SR\b|Vgl\.|Siehe|ABl\.|RPW\b|BBl\b|Verordnung\b|Mitteilung\b|Bekanntmachung der Kommission\b|\[)")
_PAGE_FOOT = re.compile(r"^\s*(Seite|Page|\d+/\d+|\d{1,3})\s*$")
# The Erläuterungen have no articles: they run as flat numbered paragraphs
# ("1.  Nachfolgende Erläuterungen dienen als Auslegehilfe ..."), the
# Randziffern the practice cites them by.
_MARGIN_NUMBER = re.compile(r"^\s{0,6}(\d{1,3})\.\s+(\S.*)$")


def dehyphenate(text: str) -> str:
    """"Wettbewerbsabre-\\nden" -> "Wettbewerbsabreden". German legal PDFs
    break words across lines constantly; a proposition compared with a
    hyphen in it matches nothing."""
    return re.sub(r"(\w)-\n(\w)", r"\1\2", text)


def columns(text: str, min_hits: int = 5) -> str:
    """Two-column page -> reading order (left column, then right). The split
    is the character position where the right column most often starts; a
    single-column text has no such position and comes back unchanged. Same
    rule as chpipe.rpw.reading_order, applied to a whole document."""
    lines = text.splitlines()
    starts: dict[int, int] = {}
    for line in lines:
        for m in re.finditer(r"\S\s{3,}(?=\S)", line):
            if 30 <= m.end() <= 95:
                starts[m.end()] = starts.get(m.end(), 0) + 1
    if not starts:
        return text
    best = max(starts, key=lambda p: sum(starts.get(p + d, 0) for d in (-2, -1, 0, 1, 2)))
    if sum(starts.get(best + d, 0) for d in (-2, -1, 0, 1, 2)) < min_hits:
        return text
    split = best - 2
    left = [ln[:split].rstrip() for ln in lines]
    right = [ln[split:].rstrip() for ln in lines]
    return "\n".join(left) + "\n" + "\n".join(right)


@dataclass
class Proposition:
    version: str
    part: str                  # "preamble" | "operative"
    unit: str                  # "I" ... or "12"
    sub: str                   # "" or "1", "2"
    heading: str
    text: str
    order: int = 0

    @property
    def pid(self) -> str:
        return f"{self.unit}({self.sub})" if self.sub else self.unit


def _clean(lines: list[str], keep_notes: bool = False) -> str:
    keep = [ln for ln in lines
            if ln.strip() and not _PAGE_FOOT.match(ln)
            and (keep_notes or not _FOOTNOTE.match(ln))]
    return re.sub(r"\s+", " ", " ".join(keep)).strip()


def parse(text: str, version: str, keep_notes: bool = False) -> list[Proposition]:
    """The propositions of one version, in document order.

    The preamble is what stands before the first unit heading. That boundary
    decides how a numbered paragraph reads: "(1)" before it opens a recital,
    "(1)" after it opens a subparagraph of a rule.

    `keep_notes` keeps the footnotes with the proposition they hang under.
    The audit's own text should not carry them, but the citations live there
    -- the Erläuterungen name the decisions in footnotes, not in the body --
    so the gold set is built with them in.
    """
    text = dehyphenate(text)
    lines = text.splitlines()
    first_unit = next((i for i, ln in enumerate(lines) if _UNIT.match(ln)), len(lines))
    if first_unit == len(lines) and sum(1 for ln in lines if _MARGIN_NUMBER.match(ln)) >= 5:
        return _parse_margin_numbers(lines, version, keep_notes)
    out: list[Proposition] = []
    buf: list[str] = []
    cur: Proposition | None = None
    unit_heading = ""

    def flush():
        nonlocal buf, cur
        if cur is not None:
            cur.text = _clean(buf, keep_notes)
            if cur.text:
                cur.order = len(out)
                out.append(cur)
        buf, cur = [], None

    for i, line in enumerate(lines):
        if i < first_unit:
            m = _RECITAL.match(line)
            if m:
                flush()
                # 2002 bullets its recitals with a glyph pdftotext renders as
                # "??"; they are numbered here in the order they are printed.
                number = m.group(1) or m.group(2) or str(
                    sum(1 for p in out if p.part == "preamble") + 1)
                cur = Proposition(version, "preamble", number, "", "", "")
                buf = [m.group(4)]
                continue
            if cur is not None:
                buf.append(line)
            continue
        m = _UNIT.match(line)
        if m:
            flush()
            unit_heading = (m.group(3) or "").strip()
            cur = Proposition(version, "operative", m.group(2), "", unit_heading, "")
            buf = []
            continue
        if cur is not None and cur.part == "operative" and not cur.sub and not unit_heading \
                and not buf and line.strip():
            # 2002 sets the unit's heading on the line after "Ziffer 1".
            unit_heading = cur.heading = line.strip()
            continue
        m = _SUBPARA.match(line)
        if m and cur is not None and cur.part == "operative" and not _FOOTNOTE.match(line):
            unit, sub = cur.unit, (m.group(1) or m.group(2))
            flush()
            cur = Proposition(version, "operative", unit, sub, unit_heading, "")
            buf = [m.group(3)]
            continue
        m = _LETTER.match(line)
        if m and cur is not None and cur.part == "operative":
            # b) follows a), so the letter replaces the previous one rather
            # than joining it: "1a" then "b" is 12(1b), never 12(1ab).
            unit, sub = cur.unit, cur.sub.rstrip("abcdefgh")
            flush()
            cur = Proposition(version, "operative", unit, f"{sub}{m.group(1)}" if sub else m.group(1),
                              unit_heading, "")
            buf = [m.group(2)]
            continue
        if cur is not None:
            buf.append(line)
    flush()
    # A unit whose subparagraphs were captured keeps no text of its own, and
    # neither does a subparagraph whose lettered points were: the chapeau
    # ("... wenn sie Folgendes zum Gegenstand haben:") states no rule alone.
    lettered = {(p.unit, p.sub[:-1]) for p in out if p.sub and p.sub[-1].isalpha()}
    with_subs = {p.unit for p in out if p.part == "operative" and p.sub}
    return [p for p in out
            if p.text
            and not (p.part == "operative" and not p.sub and p.unit in with_subs)
            and not (p.part == "operative" and p.sub and not p.sub[-1].isalpha()
                     and (p.unit, p.sub) in lettered)]


def _parse_margin_numbers(lines: list[str], version: str, keep_notes: bool) -> list[Proposition]:
    """A document numbered straight through, one proposition per paragraph.

    The numbers are the Randziffern the courts and the agency cite the
    Erläuterungen by ("Erl. Rz. 12"), so they are the natural unit here, and
    the audit can hold a citation against the paragraph it points at."""
    out: list[Proposition] = []
    cur: Proposition | None = None
    buf: list[str] = []
    for line in lines:
        m = _MARGIN_NUMBER.match(line)
        if m and not _FOOTNOTE.match(line):
            if cur is not None:
                cur.text = _clean(buf, keep_notes)
                if cur.text:
                    cur.order = len(out)
                    out.append(cur)
            cur = Proposition(version, "note", m.group(1), "", "", "")
            buf = [m.group(2)]
            continue
        if cur is not None:
            buf.append(line)
    if cur is not None:
        cur.text = _clean(buf, keep_notes)
        if cur.text:
            cur.order = len(out)
            out.append(cur)
    return out


def read_text(path: pathlib.Path, journal: bool) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    return columns(raw) if journal else raw


def norm(t: str) -> list[str]:
    t = unicodedata.normalize("NFKD", t.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.findall(r"\w+", t)


def similarity(a: str, b: str) -> float:
    """Word-level ratio, autojunk off.

    Both matter. Character-level comparison with difflib's default
    autojunk=True scored two texts of the SAME recital at 0.178 (2017 vs 2022
    recital V): over 200 characters the heuristic treats every frequent
    character as junk, which is most of German. On words, with the heuristic
    off, the same pair scores what a reader would call it."""
    return difflib.SequenceMatcher(None, norm(a), norm(b), autojunk=False).ratio()


@dataclass
class Aligned:
    pid: str
    part: str
    heading: str
    per_version: dict = field(default_factory=dict)      # version -> {text, status, similarity}


def align(by_version: dict[str, list[Proposition]], order: list[str],
          same: float = 0.98, reworded: float = 0.55) -> list[Aligned]:
    """Track each proposition across versions, oldest first.

    Matching is by position first (same unit and subparagraph number) and by
    text second: the instrument renumbered itself in 2022 (Ziffer 12 became
    Artikel 14), so a proposition that keeps its wording under a new number
    must not read as one removed and one added.
    """
    tracks: list[Aligned] = []
    for version in order:
        props = by_version.get(version, [])
        taken: set[int] = set()
        for t in tracks:
            previous = next((t.per_version[v]["text"] for v in reversed(order)
                             if v in t.per_version), None)
            if previous is None:
                continue
            best_i, best_s = None, 0.0
            for i, p in enumerate(props):
                if i in taken:
                    continue
                s = similarity(previous, p.text)
                if p.pid == t.pid:
                    s += 0.05          # the same place in the instrument, a nudge not a rule
                if s > best_s:
                    best_i, best_s = i, s
            if best_i is not None and best_s >= reworded:
                p = props[best_i]
                taken.add(best_i)
                t.per_version[version] = {
                    "text": p.text, "pid": p.pid, "heading": p.heading,
                    "status": "unchanged" if best_s >= same else "reworded",
                    "similarity": round(min(best_s, 1.0), 3)}
        for i, p in enumerate(props):
            if i in taken:
                continue
            t = Aligned(p.pid, p.part, p.heading)
            t.per_version[version] = {"text": p.text, "pid": p.pid, "heading": p.heading,
                                      "status": "added", "similarity": None}
            tracks.append(t)
    return tracks


# version key -> (file, is a journal text with two columns)
SOURCES = {
    # The journal-only versions, re-extracted from the issue PDF in reading
    # order (pdftotext WITHOUT -layout): the layout mode keeps the journal's
    # two columns side by side and cuts words at the column edge.
    "2002-02-18": ("rpw_2002_bek.txt", False),
    "2007-07-02": ("rpw_2007_bek.txt", False),
    "2010-06-28": ("vertbek_2010.txt", False),
    "2017-05-22": ("vertbek_2010_stand2017.txt", False),
    "2019-04-09": ("erl_2017_stand2019.txt", False),
    "2022-12-12": ("vertbek_2022.txt", False),
    "2022-12-12-erl": ("erl_2022.txt", False),
}


def load(directory: pathlib.Path, keys: list[str]) -> dict[str, list[Proposition]]:
    out: dict[str, list[Proposition]] = {}
    for key in keys:
        name, journal = SOURCES[key]
        path = directory / name
        if not path.exists():
            print(f"  ! {key}: {name} not present", file=sys.stderr)
            continue
        out[key] = parse(read_text(path, journal), key)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["parse", "align"])
    ap.add_argument("--dir", type=pathlib.Path, default=pathlib.Path("/data/ch-corpus/weko-bek"))
    ap.add_argument("--versions", default="2010-06-28,2017-05-22,2022-12-12")
    ap.add_argument("--out", type=pathlib.Path)
    args = ap.parse_args()

    keys = [k.strip() for k in args.versions.split(",") if k.strip()]
    by_version = load(args.dir, keys)

    if args.command == "parse":
        for key in keys:
            props = by_version.get(key, [])
            pre = sum(1 for p in props if p.part == "preamble")
            print(f"{key}: {len(props)} propositions ({pre} recitals, {len(props) - pre} operative)")
            for p in props[:4]:
                print(f"    {p.part[:4]} {p.pid:8} {p.heading[:28]:28} {p.text[:70]}")
        return 0

    tracks = align(by_version, keys)
    rows = [{"pid": t.pid, "part": t.part, "heading": t.heading,
             "versions": {v: {k: x for k, x in d.items() if k != "text"} | {"chars": len(d["text"])}
                          for v, d in t.per_version.items()}} for t in tracks]
    if args.out:
        args.out.write_text(json.dumps(
            [{"pid": t.pid, "part": t.part, "heading": t.heading, "versions": t.per_version}
             for t in tracks], ensure_ascii=False, indent=1), encoding="utf-8")
    counts: dict[str, dict[str, int]] = {}
    for t in tracks:
        for v, d in t.per_version.items():
            counts.setdefault(v, {}).setdefault(d["status"], 0)
            counts[v][d["status"]] += 1
    print(f"tracked propositions: {len(tracks)}")
    for v in keys:
        if v in counts:
            c = counts[v]
            print(f"  {v}: " + ", ".join(f"{k} {n}" for k, n in sorted(c.items())))
    gone = [t.pid for t in tracks if keys[-1] not in t.per_version]
    print(f"  not carried into {keys[-1]}: {len(gone)}" + (f" ({', '.join(gone[:8])})" if gone else ""))
    print(json.dumps(rows[:2], ensure_ascii=False)[:400])
    return 0


if __name__ == "__main__":
    sys.exit(main())
