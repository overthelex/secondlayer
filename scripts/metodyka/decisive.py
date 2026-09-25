"""The reading packet that actually decides something.

A full reading is 528 judgements and most of them change nothing. Two judges on
the sharpened protocol disagree on 135 passages, but 93 of those are "лише
переказує" against "не про це" -- neither is application, so the outcome is the
same either way. What moves the result is the 38 where one judge sees
application and the other does not: bounded both ways, they decide whether 39 of
the 66 propositions are dead letter or not.

So the packet is two parts, shuffled together and indistinguishable to the
reader:

  * every passage where application itself is in dispute;
  * a random control drawn from the passages both judges agreed on, in the
    proportions of their agreed labels.

The control is what catches the second failure: two judges can agree and both be
wrong, as they were on embedded conclusions before the protocol was sharpened.
Without it the reading only sees hard cases and says nothing about the easy ones.

Usage:
    python3 decisive.py --out /data/amcu/packet-decisive.json
"""
from __future__ import annotations

import argparse
import collections
import json
import random

A = "/data/amcu/judge-sonnet46-v2.jsonl"
B = "/data/amcu/judge-deepseek-v2.jsonl"
SEED = 38


def load(path):
    return {(r["number"], r["doc_id"], r["ord"]): r["label"]
            for r in map(json.loads, open(path, encoding="utf-8")) if r["label"]}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packet", default="/data/amcu/packet.json")
    ap.add_argument("--out", default="/data/amcu/packet-decisive.json")
    ap.add_argument("--control", type=int, default=40)
    args = ap.parse_args()

    packet = json.load(open(args.packet, encoding="utf-8"))
    index = {(p["number"], s["doc_id"], s["ord"]): (p, s)
             for p in packet for s in p["passages"]}
    a, b = load(A), load(B)
    keys = [k for k in a if k in b]

    decisive = [k for k in keys
                if a[k] != b[k] and "застосовує" in (a[k], b[k])]
    agreed = [k for k in keys if a[k] == b[k]]

    # The control mirrors the agreed labels' proportions, so agreement can be
    # measured per label rather than only overall.
    rng = random.Random(SEED)
    by_label = collections.defaultdict(list)
    for k in agreed:
        by_label[a[k]].append(k)
    control: list = []
    for label, group in sorted(by_label.items()):
        want = max(1, round(args.control * len(group) / len(agreed)))
        rng.shuffle(group)
        control.extend(group[:want])

    chosen = {k: "спірний" for k in decisive}
    for k in control:
        chosen.setdefault(k, "контроль")

    out = []
    for number in sorted({k[0] for k in chosen},
                         key=lambda n: [int(x) for x in n.split(".")]):
        prop = next(p for p in packet if p["number"] == number)
        passages = []
        for k in chosen:
            if k[0] != number:
                continue
            _, s = index[k]
            passages.append(dict(s, part=chosen[k],
                                 judges={"a": a[k], "b": b[k]}))
        passages.sort(key=lambda s: -s["score"])
        out.append(dict(prop, passages=passages))

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)

    n = sum(len(p["passages"]) for p in out)
    print(f"{len(out)} пунктів, {n} уривків -> {args.out}")
    print(f"  спірні (де йдеться про застосування): {len(decisive)}")
    print(f"  контроль зі згодних: {len(control)}")
    kinds = collections.Counter(s["corpus"] for p in out for s in p["passages"])
    print(f"  АМКУ {kinds['amcu']}, суд {kinds['court']}")
    print("  контроль за мітками: " + ", ".join(
        f"{lab} {sum(1 for k in control if a[k] == lab)}" for lab in sorted(by_label)))


if __name__ == "__main__":
    main()
