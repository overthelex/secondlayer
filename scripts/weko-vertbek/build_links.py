"""The verified links between versions (PAPER-239).

A link joins a proposition to the one that carries its rule in the next
version. Chains are the connected components of the links, so a rule that
two earlier propositions fed (a merge) or that split into two keeps its
earliest date. Sources:

  - align_global's assignment (measure1_step1_v4.json): word-for-word links
    stand; links the wording does not carry were read by the judges under
    link_check.md -- "different" (both judges) breaks the link, "same" and
    "modified" keep it;
  - rules that left their chain, read against their three nearest
    propositions of the next version: a candidate both judges call "same" or
    "modified" is a link the assignment missed;
  - the reader on the two disputes (chat, 2026-10-04).

Only the chains of norms were checked; the links of other propositions
stand as aligned and are marked unverified.

    python3 build_links.py
"""
from __future__ import annotations

import collections
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
CHAINS = [["2002-02-18", "2007-07-02", "2010-06-28", "2017-05-22", "2022-12-12"], ["2019-04-09", "2022-12-12-erl"]]
OK = ("same", "modified")
READER = {"2007-07-02:10(3)>2010-06-28:IX": "different",       # a recital is not the operative rule (protocol)
          "2017-05-22:15(1)>2022-12-12:12(3)": "modified"}     # price recommendations moved into Art. 12(3)


def jsonl(p: pathlib.Path) -> dict[str, dict]:
    return {r["id"]: r for r in (json.loads(x) for x in p.read_text().splitlines() if x.strip())}


def main() -> int:
    step1 = json.loads((DIR / "measure1_step1_v4.json").read_text())
    pairs = {p["id"]: p for p in json.loads((DIR / "link_pairs.json").read_text())}
    c, g = jsonl(DATA / "links" / "claude-opus.jsonl"), jsonl(DATA / "links" / "gemini-3.1-pro.jsonl")

    def verdict(i: str) -> tuple[str, str]:
        if i in READER:
            return READER[i], "reader"
        a, b = c[i]["answer"], g[i]["answer"]
        if a == b:
            return a, "judges"
        if a in OK and b in OK:
            return "same-or-modified", "judges"
        return "disputed", "judges"

    links, broken = [], []
    for t in step1:
        chain = next(ch for ch in CHAINS if t["first_version"] in ch)
        present = [v for v in chain if v in t["versions"]]
        for a, b in zip(present, present[1:]):
            A, B = t["versions"][a]["pid"], t["versions"][b]["pid"]
            i = f"{a}:{A}>{b}:{B}"
            if t["versions"][b]["status"] == "unchanged":
                rel, src = "same", "wording"
            elif i in pairs:
                rel, src = verdict(i)
            else:
                rel, src = "unverified", "aligned"          # not a norm's chain
            if rel == "different":
                broken.append(i)
                continue
            assert rel != "disputed", i
            links.append({"a": [a, A], "b": [b, B], "relation": rel, "source": src})
    recovered = collections.Counter()
    unsure: list[str] = []
    for i, p in pairs.items():
        if p["kind"] != "drop":
            continue
        rel, src = verdict(i)
        if rel in OK or rel == "same-or-modified":
            links.append({"a": [p["a_version"], p["a_pid"]], "b": [p["b_version"], p["b_pid"]],
                          "relation": rel, "source": src + ":recovered"})
            recovered[rel] += 1
        elif rel == "disputed":
            # a second candidate for a rule that already has an agreed
            # successor, or a split the judges do not agree on: not linked
            unsure.append(i)
    out = {"links": links, "broken": broken, "not_linked_disputed": unsure,
           "note": "chains = connected components of links; see build_links.py"}
    (DATA / "links_v4.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("links", len(links), dict(collections.Counter(l["relation"] for l in links)),
          "| broken", broken, "| recovered", dict(recovered), "| disputed, not linked", len(unsure))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
