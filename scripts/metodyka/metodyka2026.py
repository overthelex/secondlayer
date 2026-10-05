"""The 2026 Методика, cut into the propositions the audit labels (PAPER-243).

The successor to z0317-02 is the Методика визначення товарного ринку та
монопольного (домінуючого) становища суб'єктів господарювання на ньому,
approved by AMCU розпорядження N 2-рп of 11 June 2026, registered with the
Ministry of Justice on 14 July 2026 under N 1043/46437 (z1043-26), in force
from 1 August 2026. harvest_successor.py fetched it from the register.

Its structure differs from the 2002 text: eleven розділи numbered in roman
numerals, with arabic пункти restarting at 1 inside each, and enumerations in
the "1) 2)" form or as unnumbered lines under a lead-in. A proposition is one
numbered пункт, carrying the text from its number down to the next number or
розділ heading -- the granularity metodyka.py uses for 2002, so the two texts
are cut alike. The one exception is the list of terms in I.4: each definition
there is a proposition of its own (I.4.1, I.4.2, ...), since each defines a
different term and the 2002 text spreads its definitions over several items;
the closing line that adopts the statute's definitions by reference is I.4.ref.

Roman numerals are typed with a mix of Latin and Cyrillic letters (І, Х):
both are accepted and normalised to Latin. The act ends at the signature
block; the portal's page chrome after it is cut off.

Usage:
    python3 metodyka2026.py dump --out ../../data/metodyka/propositions_2026.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
from dataclasses import asdict, dataclass

NREG = "z1043-26"
SOURCE = pathlib.Path("/data/amcu/z1043-26.txt")
CYR = str.maketrans({"І": "I", "Х": "X"})
_ROZDIL = re.compile(r"^([IVXІХ]{1,5})\.\s+(\S.*)$")
_ITEM = re.compile(r"^(\d{1,2})\.\s+(\S.*)$")
_TERM = re.compile(r"^([^—]{2,120}?)\s+—\s+(\S.*)$")
# a term whose meaning follows as a list ("регіональний товарний ринок:")
_TERM_LIST = re.compile(r"^([^—:]{2,80}):$")
# the closing reference to the statute's own definitions, a statement of its own
_BY_REFERENCE = re.compile(r"^Терміни\s+«")
_START = re.compile(r"^І\.\s+Загальні положення")
_END = re.compile(r"^Заступник начальника\s*$")


@dataclass
class Proposition:
    number: str          # "V.15", "I.4.3"
    rozdil: str          # "V"
    rozdil_title: str
    kind: str            # "item" or "definition"
    term: str            # the defined term, for a definition
    text: str


def lines(path: pathlib.Path) -> list[str]:
    out, on = [], False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not on:
            on = bool(_START.match(line))
        if on:
            if _END.match(line):
                return out
            if line:
                out.append(line)
    raise SystemExit("no end of the act found")


def parse(path: pathlib.Path = SOURCE) -> list[Proposition]:
    props: list[Proposition] = []
    rozdil = title = ""
    cur: list[str] | None = None
    num = ""

    def flush():
        if cur is None:
            return
        if num == "I.4":
            # the list of terms: a lead-in, then one "term — meaning" per line
            lead, defs = cur[0], cur[1:]
            props.append(Proposition(num, rozdil, title, "item", "", lead))
            k = 0
            for d in defs:
                m = _TERM.match(d) or _TERM_LIST.match(d)
                if _BY_REFERENCE.match(d):
                    props.append(Proposition("I.4.ref", rozdil, title, "item", "", d))
                elif m:
                    k += 1
                    props.append(Proposition(f"I.4.{k}", rozdil, title, "definition", m.group(1).strip(), d))
                elif props and props[-1].kind == "definition":
                    props[-1].text += " " + d       # a definition running on to further lines
                else:
                    raise SystemExit(f"stray line in the list of terms: {d[:80]}")
            return
        props.append(Proposition(num, rozdil, title, "item", "", " ".join(cur)))

    for line in lines(path):
        m = _ROZDIL.match(line)
        if m:
            flush(); cur = None
            rozdil, title = m.group(1).translate(CYR), m.group(2).strip()
            continue
        m = _ITEM.match(line)
        if m and rozdil:
            flush()
            num, cur = f"{rozdil}.{m.group(1)}", [line]
            continue
        if cur is not None:
            cur.append(line)
    flush()
    return props


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dump")
    d.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()
    props = parse()
    # the numbering must run 1, 2, 3 ... inside every розділ, or a line was missed
    seen: dict[str, list[int]] = {}
    for p in props:
        if p.kind == "item":
            if p.number.count(".") == 1:
                seen.setdefault(p.rozdil, []).append(int(p.number.split(".")[1]))
    for r, ns in seen.items():
        assert ns == list(range(1, len(ns) + 1)), (r, ns)
    args.out.write_text(json.dumps({"nreg": NREG, "propositions": [asdict(p) for p in props]},
                                   ensure_ascii=False, indent=1))
    by = {r: len(ns) for r, ns in seen.items()}
    print(f"{len(props)} propositions: {sum(p.kind == 'item' for p in props)} items in {len(by)} розділи {by}, "
          f"{sum(p.kind == 'definition' for p in props)} definitions; {sum(len(p.text) for p in props)} characters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
