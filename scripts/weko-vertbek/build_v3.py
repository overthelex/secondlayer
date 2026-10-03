"""Labels, judge answers and typology after the parser fix of 2026-10-03 (PAPER-232).

The fix renumbered nine 2017 points (same text, same passages), removed five
footnotes read as propositions, and changed the text of eleven propositions
and added three, which were read again (judges-redo14, one dispute settled by
the reader). This writes the v3 files every later step reads.

    python3 build_v3.py
"""
from __future__ import annotations

import collections
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")

RENAME = {("2017-05-22", "10(9b)"): "10(1b)", ("2017-05-22", "15(14d)"): "15(3d)",
          **{("2017-05-22", f"12(12{c})"): f"12(2{c})" for c in "cdefgh"}}
GONE = {("2017-05-22", "3(4)"), ("2017-05-22", "3(6)"), ("2017-05-22", "10(7)"),
        ("2017-05-22", "10(8)"), ("2022-12-12", "21(5)")}
# the reader on the one re-read dispute (labels page, 2026-10-03)
READER = {("2017-05-22", "X"): {"label": "supported", "evidence_marked": ["ECLI:CH:CH_WEKO_RPW:RPW_2011-2_B1.1.2"],
                                "note": "Hörgeräte (RPW 2011/2) wendet den Kumulativteil an: kumulativer "
                                        "Abschottungseffekt, tiefere Marktanteilsschwelle von 5 % massgebend."}}
# the reader on the typology disputes (chat, 2026-10-03): norm where the two
# judges split between norm and something else; housekeeping where neither said norm
TYPE_READER = {("2002-02-18", "E3"): "norm", ("2019-04-09", "5"): "norm", ("2019-04-09", "7"): "norm",
               ("2019-04-09", "8"): "norm", ("2022-12-12-erl", "11"): "norm", ("2022-12-12-erl", "12"): "norm",
               ("2010-06-28", "V"): "housekeeping", ("2010-06-28", "VII"): "housekeeping",
               ("2017-05-22", "VII"): "housekeeping"}


def key(v: str, pid: str) -> tuple[str, str]:
    return v, RENAME.get((v, pid), pid)


def jsonl(p: pathlib.Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]


def main() -> int:
    old = json.loads((DATA / "labels_full_2026-10-03.json").read_text())
    review = {(r["version"], r["pid"]): r for r in json.loads((DIR / "review_redo14.json").read_text())}
    packet = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())
              if p["version"] != "control"}

    labels = {}
    for r in old["labels"]:
        k0 = (r["version"], r["pid"])
        if k0 in GONE:
            continue
        k = key(*k0)
        labels[k] = dict(r, pid=k[1])
    for k, r in review.items():
        prev = labels.get(k)
        if prev and prev["source"] == "human_gold":
            continue                                  # the gold label stands (and agrees, see the log)
        row = {"version": k[0], "pid": k[1], "part": r["part"], "claude": r["judges"]["claude-opus"],
               "gemini": r["judges"]["gemini-3.1-pro"], "evidence_marked": None, "note": ""}
        if k in READER:
            row.update(source="human_disputed", **READER[k])
        else:
            assert r["status"] == "unanimous", k
            row.update(source="judges", label=r["prelabel"])
        labels[k] = row
    assert set(labels) == set(packet), (set(labels) ^ set(packet))
    out = {"exported": "2026-10-03", "protocol": old["protocol"], "rule": old["rule"],
           "changes": "v3: parser fix (PAPER-232); 9 renumbered, 5 removed, 14 re-read",
           "labels": sorted(labels.values(), key=lambda r: (r["version"], r["pid"]))}
    (DATA / "labels_full_v3.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("labels", len(labels), dict(collections.Counter(r["label"] for r in labels.values())),
          dict(collections.Counter(r["source"] for r in labels.values())))

    # judge answers: the full run renamed and pruned, the re-read replacing its rows
    jdir = DATA / "judges-v3"
    jdir.mkdir(exist_ok=True)
    for n in ("claude-opus", "gemini-3.1-pro"):
        redo = {(r["version"], r["pid"]): r for r in jsonl(DIR / "judges-redo14" / f"{n}.jsonl")}
        rows = []
        for r in jsonl(DATA / "judges-full" / f"{n}.jsonl"):
            k0 = (r["version"], r["pid"])
            if k0 in GONE:
                continue
            k = key(*k0)
            if k in redo:
                continue
            rows.append(dict(r, pid=k[1]))
        rows += list(redo.values())
        (jdir / f"{n}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        print(n, len(rows))

    # typology: the judges where they agree, the reader where they do not
    t = {n: {(r["version"], r["pid"]): r for r in jsonl(DIR / "typology" / f"{n}.jsonl")}
         for n in ("claude-opus", "gemini-3.1-pro")}
    types = []
    for k in sorted(packet):
        c, g = t["claude-opus"][k]["type"], t["gemini-3.1-pro"][k]["type"]
        if c == g:
            types.append({"version": k[0], "pid": k[1], "type": c, "source": "judges", "claude": c, "gemini": g})
        else:
            types.append({"version": k[0], "pid": k[1], "type": TYPE_READER[k], "source": "reader",
                          "claude": c, "gemini": g})
    (DATA / "typology_v3.json").write_text(json.dumps({"protocol": "scripts/weko-vertbek/typology.md",
                                                       "types": types}, ensure_ascii=False, indent=1))
    print("types", dict(collections.Counter(x["type"] for x in types)),
          dict(collections.Counter(x["source"] for x in types)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
