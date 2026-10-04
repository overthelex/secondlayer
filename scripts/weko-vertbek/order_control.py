"""Does the order of the passages move the labels? (PAPER-236)

60 propositions of the full run, stratified by label (15 supported, 20
fragment, 10 recites, 15 absent; seed 236), read again by both judges twice:
once with the passages in a seeded random order (judge.py --shuffle 7) and
once in the original order. The original-order re-read measures how often a
judge changes its own label anyway; the shuffled read is compared with it.

    python3 judge.py --provider claude --model opus --packet order-control/packet_perm.json \\
        --shuffle 7 --out order-control/shuffled_claude-opus.jsonl
    python3 judge.py ... --out order-control/retest_claude-opus.jsonl      # no --shuffle
    python3 order_control.py
"""
from __future__ import annotations

import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
OC = DATA / "order-control"
SUP = {"supported", "fragment"}


def labels(path: pathlib.Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if r.get("label"):
            out[(r["version"], r["pid"])] = r["label"]
    return out


def main() -> int:
    out = {}
    for who in ("claude-opus", "gemini-3.1-pro"):
        o = labels(DATA / "judges-v3" / f"{who}.jsonl")
        sh, rt = labels(OC / f"shuffled_{who}.jsonl"), labels(OC / f"retest_{who}.jsonl")
        ks = [k for k in sh if k in o and k in rt]
        same = lambda a, b: sum(a[k] == b[k] for k in ks)
        binary = lambda a, b: sum((a[k] in SUP) == (b[k] in SUP) for k in ks)
        out[who] = {"n": len(ks), "retest_same_label": same(o, rt), "retest_same_binary": binary(o, rt),
                    "shuffled_same_label": same(o, sh), "shuffled_same_binary": binary(o, sh)}
        print(who, out[who])
    (OC / "order_control.json").write_text(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
