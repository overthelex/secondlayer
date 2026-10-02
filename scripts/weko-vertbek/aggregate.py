"""Three judges into one reading list for the human.

Per proposition, the judges' derived labels (supported / fragment / recites /
absent) are compared:

    unanimous   the judges agree (all of them, or a strict majority with
                --rule majority): the label is pre-set and the item leaves the
                human's list, except
    check       a seeded, label-stratified sample of the unanimous items that
                the human labels BLIND anyway. Without it nothing measures
                whether unanimous judges are right, and the gold set stops
                being a test of the judges.
    disputed    the judges disagree, or one failed: the human labels it.
    control     fabricated / statute / regime controls: they test the judges
                and never reach the human list.

The human page shows a disputed or check item without the judges' answers;
they appear after the human has set a label (page/labels.html), so the human
label is not anchored on them.

    python3 aggregate.py --judges judges/*.jsonl --out review.json [--check 15]
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random

DIR = pathlib.Path("/data/ch-corpus/weko-bek")


def load(paths: list[pathlib.Path]) -> dict[str, dict]:
    """judge name -> {(version, pid): answer}; the last good answer wins."""
    out: dict[str, dict] = {}
    for path in paths:
        rows = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get("label") and not r.get("error"):
                rows[(r["version"], r["pid"])] = r
        out[path.stem] = rows
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packet", type=pathlib.Path, default=DIR / "packet.json")
    ap.add_argument("--judges", type=pathlib.Path, nargs="+", required=True)
    ap.add_argument("--exclude", type=pathlib.Path,
                    help="human labels (json export) of the development set: left out of the lists")
    ap.add_argument("--check", type=int, default=15, help="at most this many pre-labelled items checked blind")
    ap.add_argument("--check-share", type=float, default=0.25, help="share of pre-labelled items checked blind")
    ap.add_argument("--anchor", default="claude-opus", help="for --rule anchor")
    ap.add_argument("--rule", choices=["unanimous", "majority", "anchor"], default="majority",
                    help="what pre-labels an item: all judges agree, or a strict majority")
    ap.add_argument("--seed", type=int, default=1001)
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "review.json")
    args = ap.parse_args()

    packet = json.loads(args.packet.read_text(encoding="utf-8"))
    judges = load(args.judges)
    # propositions the protocol was revised on: their human labels stand, and
    # they are kept out of the blind check of the revised protocol
    dev = set()
    if args.exclude:
        dev = {(r["version"], r["pid"]) for r in json.loads(args.exclude.read_text())["labels"] if r.get("label")}
    names = sorted(judges)

    items, unanimous = [], collections.defaultdict(list)
    for it in packet:
        key = (it["version"], it["pid"])
        answers = {n: judges[n].get(key) for n in names}
        labels = {n: (a["label"] if a else None) for n, a in answers.items()}
        votes = collections.Counter(v for v in labels.values() if v)
        top, top_n = votes.most_common(1)[0] if votes else (None, 0)
        if args.rule == "anchor":
            # the judge closest to the human reader on the development set,
            # confirmed by at least one other
            a = labels.get(args.anchor)
            decided = a is not None and sum(v == a for n, v in labels.items() if n != args.anchor) >= 1
            top, top_n = (a, sum(v == a for v in labels.values())) if decided else (top, top_n)
        else:
            decided = (top_n == len(names) if args.rule == "unanimous"
                       else top_n * 2 > len(names) and None not in labels.values())
        status = ("control" if it["kind"] != "sample"      # tests the judges, not for the human
                  else "development" if key in dev
                  else "unanimous" if decided
                  else "disputed")
        # passage by passage, for the page and for agreement afterwards
        per_passage = []
        for i, e in enumerate(it["evidence"]):
            votes = {}
            for n, a in answers.items():
                if a:
                    p = next((p for p in a["passages"] if p["ecli"] == e["ecli"]), None)
                    if p:
                        votes[n] = {"label": p["label"], "quote": p["quote"],
                                    "quote_found": p["quote_found"], "why": p["why"]}
            per_passage.append(votes)
        row = {**it, "judges": labels, "judge_passages": per_passage, "status": status,
               "prelabel": top if status == "unanimous" else None,
               "agreement": f"{top_n}/{len(names)}"}
        items.append(row)
        if status == "unanimous":
            unanimous[row["prelabel"]].append(row)
        if status == "control":
            row["prelabel"] = None

    # the blind check: stratified over the unanimous labels, proportional,
    # at least one per label that occurs
    rng = random.Random(args.seed)
    total = sum(len(v) for v in unanimous.values())
    size = min(args.check, max(5, round(args.check_share * total)))
    quota = {k: max(1, round(size * len(v) / total)) for k, v in unanimous.items()} if total else {}
    while sum(quota.values()) > size and quota:
        quota[max(quota, key=lambda k: quota[k])] -= 1
    for label, rows in unanimous.items():
        for row in rng.sample(rows, min(quota.get(label, 0), len(rows))):
            row["status"] = "check"

    count = collections.Counter(r["status"] for r in items)
    print(f"judges: {', '.join(names)}  ({', '.join(f'{n}={len(judges[n])}' for n in names)})")
    print(f"items {len(items)}: " + ", ".join(f"{k} {v}" for k, v in count.most_common()))
    print("unanimous labels:", {k: len(v) for k, v in unanimous.items()})
    pairs = collections.Counter()
    for r in items:
        ls = [r["judges"][n] for n in names]
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                pairs[(names[i], names[j])] += ls[i] is not None and ls[i] == ls[j]
    for (a, b), n in pairs.items():
        print(f"  agree {a} ~ {b}: {n}/{len(items)}")
    controls = [r for r in items if r["kind"] != "sample"]
    for r in controls:
        print(f"  control {r['kind']:8} {r['pid']}: {r['judges']}")
    args.out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {args.out}  (human list: {count['disputed'] + count['check']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
