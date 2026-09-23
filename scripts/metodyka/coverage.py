"""What the record actually cites, proposition by proposition.

The first question an audit of a guidance instrument answers is not whether
the instrument is right. It is whether the instrument is used: which of its
propositions the issuing agency and the courts reach for, and which have never
been cited by anyone in twenty four years.

A bare number is resolved the way a reader would resolve it: "п. 5 Методики"
names no пункт 5 (the instrument numbers 5.1 to 5.4), so it is a reference to
розділ 5, and it is counted as one.

Usage:
    python3 coverage.py --goldset goldset.jsonl
    python3 coverage.py --goldset goldset.jsonl --json coverage.json
"""
from __future__ import annotations

import argparse
import collections
import json

import metodyka


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--goldset", default="goldset.jsonl")
    ap.add_argument("--source", default="db")
    ap.add_argument("--json")
    args = ap.parse_args()

    props = metodyka.load(args.source)
    numbers = {p.number for p in props}
    rozdily = {str(p.rozdil) for p in props}

    direct: dict[str, collections.Counter] = {n: collections.Counter() for n in numbers}
    section: dict[str, collections.Counter] = {r: collections.Counter() for r in rozdily}
    unknown: collections.Counter = collections.Counter()
    docs = collections.Counter()
    cited_docs: dict[str, set] = {n: set() for n in numbers}

    for line in open(args.goldset, encoding="utf-8"):
        row = json.loads(line)
        docs[row["corpus"]] += 1
        for cite in row["cites"]:
            number, kind = cite["number"], cite["kind"]
            if kind == "punkt" and number in numbers:
                direct[number][row["corpus"]] += 1
                cited_docs[number].add((row["corpus"], row["doc_id"]))
            elif number in rozdily:
                section[number][row["corpus"]] += 1
            else:
                unknown[number] += 1

    print(f"{sum(docs.values())} documents cite the Методика "
          f"({docs['amcu']} agency, {docs['court']} court)")
    never = [p for p in props if not direct[p.number]]
    print(f"{len(props) - len(never)} of {len(props)} propositions are cited by number, "
          f"{len(never)} never are\n")

    print(f"{'номер':<10} {'amcu':>5} {'court':>6}  розділ / текст")
    for p in props:
        c = direct[p.number]
        flag = "" if c else "  ніколи"
        print(f"{p.number:<10} {c['amcu']:>5} {c['court']:>6}{flag}  "
              f"{p.text[:70]}")

    print(f"\nrозділ-level references (no пункт given):")
    for r in sorted(section, key=lambda x: (len(x), x)):
        c = section[r]
        if sum(c.values()):
            title = next(p.rozdil_title for p in props if str(p.rozdil) == r)
            print(f"  розділ {r:<3} {c['amcu']:>4} {c['court']:>5}  {title[:60]}")

    if unknown:
        print(f"\nnumbers cited that the instrument does not have: "
              + ", ".join(f"{n}({c})" for n, c in unknown.most_common(12)))

    if args.json:
        payload = {
            "documents": dict(docs),
            "propositions": [
                {"number": p.number, "rozdil": p.rozdil, "depth": p.depth,
                 "text": p.text, "rozdil_title": p.rozdil_title,
                 "amcu": direct[p.number]["amcu"], "court": direct[p.number]["court"],
                 "docs": sorted(cited_docs[p.number])}
                for p in props],
            "sections": {r: dict(c) for r, c in section.items()},
            "unknown": dict(unknown),
        }
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        print(f"\n-> {args.json}")


if __name__ == "__main__":
    main()
