"""The human reading, against the judges and against the interval it closes.

Three questions, in order of what they settle:

  1. Does the reader agree with the judges where the judges agree with each
     other? That is the control: two models can agree and both be wrong, and
     without this the reading only ever sees hard cases.
  2. How does the reader resolve the 40 passages where the judges split on
     application? Those decide the dead-letter count.
  3. What is the count, with the reading in place of the interval.

The reader's labels are keyed the same way the packet is, so nothing has to be
matched by text.
"""
from __future__ import annotations

import collections
import json

HUMAN = "/data/amcu/human-labels.jsonl"
A = "/data/amcu/judge-sonnet46-v2.jsonl"
B = "/data/amcu/judge-deepseek-v2.jsonl"
PACKET = "/data/amcu/packet.json"
DECISIVE = "/data/amcu/packet-decisive.json"
# the page writes short keys; the judges write the protocol's words
NAMES = {"yes": "застосовує", "no": "суперечить",
         "cite": "лише переказує", "off": "не про це"}
LABELS = ["застосовує", "суперечить", "лише переказує", "не про це"]


def load(path, field="label"):
    return {(r["number"], r["doc_id"], r["ord"]): r[field]
            for r in map(json.loads, open(path, encoding="utf-8")) if r.get(field)}


def kappa(x: list, y: list) -> float:
    """Cohen's kappa: agreement above what the two label distributions would
    produce by chance."""
    n = len(x)
    if not n:
        return float("nan")
    observed = sum(1 for a, b in zip(x, y) if a == b) / n
    cx, cy = collections.Counter(x), collections.Counter(y)
    expected = sum(cx[k] * cy[k] for k in set(cx) | set(cy)) / (n * n)
    return (observed - expected) / (1 - expected) if expected < 1 else 1.0


def main() -> None:
    human = {k: NAMES.get(v, v) for k, v in load(HUMAN).items()}
    a, b = load(A), load(B)
    decisive = {(p["number"], s["doc_id"], s["ord"])
                for p in json.load(open(DECISIVE, encoding="utf-8"))
                for s in p["passages"]}
    read = [k for k in decisive if k in human]
    print(f"прочитано {len(read)} з {len(decisive)}\n")

    print("РОЗПОДІЛ НА ПРОЧИТАНОМУ")
    print(f"{'':10} " + " ".join(f"{l[:14]:>15}" for l in LABELS))
    for name, src in (("людина", human), ("sonnet", a), ("deepseek", b)):
        c = collections.Counter(src[k] for k in read if k in src)
        n = sum(c.values())
        print(f"{name:<10} " + " ".join(f"{100*c[l]/n:>14.1f}%" for l in LABELS))

    agreed = [k for k in read if k in a and k in b and a[k] == b[k]]
    split = [k for k in read if k in a and k in b and a[k] != b[k]]
    print(f"\nКОНТРОЛЬ: {len(agreed)} уривків, де судді згодні між собою")
    for name, src in (("sonnet", a), ("deepseek", b)):
        same = sum(1 for k in agreed if human[k] == src[k])
        print(f"  людина проти {name:<9} {100*same/len(agreed):>5.1f}%  "
              f"kappa {kappa([human[k] for k in agreed], [src[k] for k in agreed]):.2f}")
    print("  де людина не згодна з обома:")
    for k in agreed:
        if human[k] != a[k]:
            print(f"    {k[0]:<9} {k[1]:<18} судді: {a[k]:<16} людина: {human[k]}")

    print(f"\nСПІРНІ: {len(split)} уривків, де судді розійшлися")
    for name, src in (("sonnet", a), ("deepseek", b)):
        same = sum(1 for k in split if human[k] == src[k])
        print(f"  людина підтримала {name:<9} {same:>3} з {len(split)}")
    neither = [k for k in split if human[k] not in (a[k], b[k])]
    print(f"  не підтримала жодного: {len(neither)}")

    app = [k for k in split if "застосовує" in (a[k], b[k])]
    human_app = [k for k in app if human[k] == "застосовує"]
    print(f"\n  із {len(app)} спірних про застосування людина визнала застосуванням "
          f"{len(human_app)}")

    print("\nМЕРТВА БУКВА")
    packet = json.load(open(PACKET, encoding="utf-8"))
    by_prop: dict[str, set] = collections.defaultdict(set)
    for p in packet:
        for s in p["passages"]:
            k = (p["number"], s["doc_id"], s["ord"])
            if k in human:
                by_prop[p["number"]].add(human[k])
            elif k in a and k in b and a[k] == b[k]:
                by_prop[p["number"]].add(a[k])
            elif k in a:
                by_prop[p["number"]].add(a[k])
    dead = sorted(n for n, v in by_prop.items() if "застосовує" not in v)
    print(f"  пропозицій без жодного застосування: {len(dead)} з {len(by_prop)}")
    print("   " + ", ".join(dead))


if __name__ == "__main__":
    main()
