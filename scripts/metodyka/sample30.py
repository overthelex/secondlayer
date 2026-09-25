"""The thirty propositions a reader is asked to judge, and why those thirty.

A full reading is 528 judgements. Thirty propositions at eight passages is 240,
enough to measure agreement with the judge, and the judge then covers the rest.
Which thirty is not a matter of convenience: the sample has to carry the claims
the paper makes, and it has to carry material the claims do not depend on, or
agreement is measured only where the answer is already known.

Five strata:

  1. never cited by anyone           the dead-letter claim rests on these
  2. розділ 10, the dominance test   the agency cites it almost never
  3. market definition               the agency leans on it heavily
  4. recitation-only                 the record can only repeat these
  5. the rest, drawn at random       so the sample is not all hand-picked

Usage:
    python3 sample30.py --packet packet.json --out packet30.json
"""
from __future__ import annotations

import argparse
import json
import random

NEVER = ["4.2.4", "10.1.6.1", "10.1.6.3", "10.2.4"]
DOMINANCE = ["10.1", "10.2", "10.2.1", "10.2.2", "10.3"]
MARKET = ["1.3", "2.1", "2.2", "3.1", "5.1", "6.1", "7.1"]
SEED = 30


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packet", default="/data/amcu/packet.json")
    ap.add_argument("--out", default="/data/amcu/packet30.json")
    ap.add_argument("--n", type=int, default=30)
    args = ap.parse_args()

    packet = json.load(open(args.packet, encoding="utf-8"))
    by_number = {p["number"]: p for p in packet}

    picked: list[str] = []
    reason: dict[str, str] = {}

    def add(numbers, why):
        for n in numbers:
            if n in by_number and n not in picked and len(picked) < args.n:
                picked.append(n)
                reason[n] = why

    add(NEVER, "ніхто не цитував")
    add(DOMINANCE, "розділ 10: тест домінування")
    add(MARKET, "визначення ринку: те, чим орган користується")
    add([p["number"] for p in packet if p.get("recital_only")][:4],
        "у записі лише переказ")

    rest = sorted(n for n in by_number if n not in picked)
    random.Random(SEED).shuffle(rest)
    add(rest, "випадково, seed 30")

    out = []
    for n in picked:
        p = dict(by_number[n])
        p["why"] = reason[n]
        out.append(p)
    out.sort(key=lambda p: [int(x) for x in p["number"].split(".")])

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)

    passages = sum(len(p["passages"]) for p in out)
    amcu = sum(1 for p in out for s in p["passages"] if s["corpus"] == "amcu")
    recital = sum(1 for p in out for s in p["passages"] if s.get("recital"))
    print(f"{len(out)} пунктів, {passages} уривків "
          f"(АМКУ {amcu}, переказів {recital}) -> {args.out}")
    for why in dict.fromkeys(reason.values()):
        names = [n for n in picked if reason[n] == why]
        print(f"  {why:<42} {len(names):>2}: {', '.join(names)}")


if __name__ == "__main__":
    main()
