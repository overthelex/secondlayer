"""The citation-anchor test, final (PAPER-233).

One result per (sentence of the Erläuterungen, decision cited for it):

  holds        the decision applies the sentence's rule (protocol v2 "supported")
  states       it lays the rule down in its own reasoning without applying it
               in the passages (a "recites" the addendum calls "states")
  fragment     it applies, or states, only part of the sentence
  quotes       it only reports the notice, the notes or the parties ("recites"/"quotes")
  absent       the passages do not hold the rule

Sources: the first build's labels where the pair is unchanged (anchors_v2_plan
"same"), the re-read pairs after the RPW part-C re-resolution, the judges'
addendum on every "recites", and the reader on every dispute of the three
rounds (human_labels_anchors_2026-10-04.json).

    python3 anchors_final.py
"""
from __future__ import annotations

import collections
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")


def jsonl(p: pathlib.Path) -> dict:
    return {(r["version"], r["pid"]): r for r in (json.loads(x) for x in p.read_text().splitlines() if x.strip())}


def main() -> int:
    plan = json.loads((DIR / "anchors_v2_plan.json").read_text())
    old_rev = {(r["version"], r["pid"]): r for r in json.loads((DIR / "review_anchors.json").read_text())}
    redo = {(r["version"], r["pid"]): r for r in json.loads((DIR / "review_anchors_v2redo.json").read_text())}
    packet = {p["pid"]: p for p in json.loads((DIR / "packet_anchors_v2.json").read_text())}
    human = {(r["version"], r["pid"], r["round"]): r for r in
             json.loads((DATA / "human_labels_anchors_2026-10-04.json").read_text())["labels"]}
    st_c = jsonl(DIR / "judges-anchor-states" / "claude-opus.jsonl")
    st_g = jsonl(DIR / "judges-anchor-states" / "gemini-3.1-pro.jsonl")

    rows = []
    for pid_new, pid_old in plan["same"]:
        p = packet[pid_new]
        r = old_rev[(p["version"], pid_old)]
        h = human.get((p["version"], pid_old, "v1-disputes"))
        lab, by = (h["label"], "reader") if h else (r["prelabel"], "judges")
        rows.append((p, lab, by))
    for pid_new in plan["redo"]:
        p = packet[pid_new]
        r = redo[(p["version"], pid_new)]
        h = human.get((p["version"], pid_new, "v2-disputes"))
        lab, by = (h["label"], "reader") if r["status"] == "disputed" else (r["prelabel"], "judges")
        assert lab, (pid_new, r["status"])
        rows.append((p, lab, by))

    out = []
    for p, lab, by in rows:
        k = (p["version"], p["pid"])
        result = {"supported": "holds", "fragment": "fragment", "absent": "absent"}.get(lab)
        how = by
        if lab == "recites":
            a, b = st_c[k]["answer"], st_g[k]["answer"]
            if a == b:
                result = {"states": "states", "quotes": "quotes", "neither": "absent"}[a]
                how = "judges (addendum)"
            else:
                h = human[(p["version"], p["pid"] + "-S", "states")]
                result = {"supported": "states", "fragment": "fragment", "recites": "quotes", "absent": "absent"}[h["label"]]
                how = "reader (addendum)"
        out.append({"version": p["version"], "pid": p["pid"], "rz": p["rz"], "cited": p["cited_docket"],
                    "cited_ecli": p["cited_ecli"], "pinpoint_found": p["pinpoint_found"],
                    "claim_is_sentence": p["claim_is_sentence"], "label": lab, "result": result, "decided_by": how})
    (DATA / "anchors_final.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    c = collections.Counter(r["result"] for r in out)
    print(len(out), "pairs:", dict(c))
    for v in ("2019-04-09", "2022-12-12-erl"):
        print(" ", v, dict(collections.Counter(r["result"] for r in out if r["version"] == v)))
    court = lambda d: "court" if (d or "").startswith(("BGE", "B-")) or "_" in (d or "") else "WEKO"
    print("  by cited:", dict(collections.Counter((court(r["cited"]), r["result"]) for r in out)))
    print("  decided by:", dict(collections.Counter(r["decided_by"] for r in out)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
