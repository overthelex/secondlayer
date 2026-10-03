"""Measurement 1, final: step 1 plus every step-2 reading that settled a
provisional announcement.

Step 2 ran twice: for the Bekanntmachung against the record before each
version's date, and for the Erläuterungen against the record before their
first issue (12 June 2017) once the chain's date was corrected. A step-2
result decides a track when the judges agree on whether the earlier record
supports it (any support: supported or fragment); where they did not, the
reader's label decides. Later rounds override earlier ones for the same
track.

    python3 measure1_merge.py --step1 measure1_step1_v2.json \\
        --round review_before.json:human_labels_before.json \\
        --round review_before_erl.json:human_labels_before_erl.json \\
        --out measure1_final.json
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib

SUP = ("supported", "fragment")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--step1", type=pathlib.Path, required=True)
    ap.add_argument("--round", action="append", required=True,
                    help="review.json:human_labels.json (the human file may be missing for a round without disputes)")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    args = ap.parse_args()

    step1 = json.loads(args.step1.read_text())
    decided: dict[tuple[str, str], tuple[str, str, str]] = {}
    for spec in args.round:
        rev_path, _, hum_path = spec.partition(":")
        rev = json.loads(pathlib.Path(rev_path).read_text())
        human = {}
        if hum_path and pathlib.Path(hum_path).exists():
            human = {(r["version"], r["pid"]): r.get("label")
                     for r in json.loads(pathlib.Path(hum_path).read_text())["labels"]}
        for r in rev:
            k = (r["version"], r["pid"])
            if r["status"] == "disputed":
                lab = human.get(k)
                if not lab:
                    raise SystemExit(f"{k} disputed in {rev_path} and not labelled by the reader")
                decided[k] = (lab, "human", r.get("before", ""))
            else:
                decided[k] = (r["prelabel"], "judges", r.get("before", ""))

    final = []
    for t in step1:
        cls, how, before = t["class"], "step1", None
        if cls == "announcement?":
            v = t["first_version"]
            k = (v, t["versions"][v]["pid"])
            if k not in decided:
                raise SystemExit(f"{k} provisional and never read against the earlier record")
            lab, how, before = decided[k]
            cls = "codification" if lab in SUP else "announcement"
        final.append(dict(t, final_class=cls, decided_by=how, step2_before=before))
    args.out.write_text(json.dumps(final, ensure_ascii=False, indent=1, default=str))
    print(dict(collections.Counter(f["final_class"] for f in final)))
    print(dict(collections.Counter((f["final_class"], f["decided_by"]) for f in final)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
