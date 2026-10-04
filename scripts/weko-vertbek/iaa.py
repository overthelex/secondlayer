"""Agreement between the two human readers on the gold test set (PAPER-237).

The first reader's labels are gold_set_2026-10-02.json (set "test", 33
propositions). The second reader's come from their own page
(https://claude.ai/artifact/W4TPxGmYFmJ4nP9jB5m6kp, collection `labels`),
exported to data/weko-vertbek/human_labels_second.json as soon as they are
in. Cohen's kappa on the four labels and on supported-or-not, and each
judge's agreement with each reader, so the judges' scores can be read
against the agreement two people reach.

    python3 iaa.py
"""
from __future__ import annotations

import collections
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
LABELS = ("supported", "fragment", "recites", "absent")
SUP = {"supported", "fragment"}


def kappa(pairs: list[tuple[str, str]]) -> float:
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = collections.Counter(a for a, _ in pairs), collections.Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def score(a: dict, b: dict) -> dict:
    ks = sorted(set(a) & set(b))
    four = [(a[k], b[k]) for k in ks]
    two = [(a[k] in SUP, b[k] in SUP) for k in ks]
    return {"n": len(ks), "agree": sum(x == y for x, y in four), "kappa": round(kappa(four), 3),
            "agree_binary": sum(x == y for x, y in two), "kappa_binary": round(kappa(two), 3)}


def main() -> int:
    first = {(r["version"], r["pid"]): r["label"]
             for r in json.loads((HERE / "gold_set_2026-10-02.json").read_text())["labels"] if r["set"] == "test"}
    sf = DATA / "human_labels_second.json"
    if not sf.exists():
        print("no labels from the second reader yet:", sf)
        return 1
    second = {(r["version"], r["pid"]): r["label"] for r in json.loads(sf.read_text())["labels"]
              if r.get("label") in LABELS and (r["version"], r["pid"]) in first}
    out = {"readers": score(first, second)}
    for who in ("claude-opus", "gemini-3.1-pro"):
        j = {}
        for line in (DATA / "judges-gold" / f"{who}.jsonl").read_text().splitlines():
            r = json.loads(line)
            if r.get("label") and (r["version"], r["pid"]) in first:
                j[(r["version"], r["pid"])] = r["label"]
        out[who] = {"vs_first": score(first, j), "vs_second": score(second, j)}
    out["confusion"] = {f"{a}|{b}": n for (a, b), n in collections.Counter(
        (first[k], second[k]) for k in second).items()}
    (DATA / "iaa.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
