"""Did the 2026 Methodology write down practice, or announce? (PAPER-244)

Every passage read for the 39 new or modified norms -- first reading,
date-ordered search, and judgments outside the record found in the full
EDRSR -- with the answers that stand:

  the reader's label where there is one (human_labels_practice2026.json);
  otherwise the two judges' answer where they agree; the read again with
  every 2002 predecessor (rejudge2026.py) replaces the first answer for the
  passages it covers.

A passage shows the 2026 rule applied when its label is "застосовує" and,
for a modified norm, what is applied is what 2026 changed. A norm is
codified when some decision before 1 August 2026 shows it; the earliest
such decision dates the practice, and the text lag is the time from it to
1 August 2026 (a lower bound: the record read is not exhaustive). A norm no
decision shows is an announcement in Schrepel and Jenny's ex ante sense --
new to the record, not yet tested by it.

    python3 codify2026.py
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import pathlib
from zoneinfo import ZoneInfo

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "metodyka"
PACKETS = pathlib.Path("/data/amcu")
CUTOFF = dt.date(2026, 8, 1)
STAGES = (("packet2026.json", "judges2026", "first reading"),
          ("packet2026_exh.json", "judges2026_exh", "date-ordered search"),
          ("packet2026_ext.json", "judges2026_ext", "outside the record"))


def kyiv(s: str) -> str:
    return s if len(s) <= 10 else dt.datetime.fromisoformat(s).astimezone(ZoneInfo("Europe/Kyiv")).date().isoformat()


def answers(folder: str) -> dict:
    out = collections.defaultdict(dict)
    p = DATA / folder
    if not p.exists():
        return out
    for who in ("claude-opus", "gemini-3.1-pro"):
        for line in (p / f"{who}.jsonl").read_text().splitlines():
            r = json.loads(line)
            out[(r["number"], r["doc_id"], r["ord"])][who] = r
    return out


def main() -> int:
    human = {(r["number"], r["doc_id"], r["ord"]): r
             for r in json.loads((DATA / "human_labels_practice2026.json").read_text())["labels"]}
    again = answers("judges2026_rejudge")
    found = json.loads((DATA / "fullsearch2026.json").read_text())["norms"]
    norms: dict[str, dict] = {}
    unresolved = []
    for packet, folder, stage in STAGES:
        said = answers(folder)
        for item in json.loads((PACKETS / packet).read_text()):
            n = item["number"]
            row = norms.setdefault(n, {"number": n, "origin": item["origin"], "from_2002": item.get("from_2002"),
                                       "read": 0, "applied": [], "applied_old_part": 0, "contradicted": []})
            for s in item["passages"]:
                k = (n, s["doc_id"], s["ord"])
                row["read"] += 1
                if k in human:
                    lab, new, by = human[k]["label"], human[k]["new"], "reader"
                else:
                    pair = again.get(k) or said[k]
                    c, g = pair["claude-opus"], pair["gemini-3.1-pro"]

                    def shows(r):
                        return r["label"] == "застосовує" and (item["origin"] == "new" or r.get("new") == "так")
                    if shows(c) != shows(g):
                        unresolved.append(k)
                        continue
                    lab = c["label"] if c["label"] == g["label"] else ("застосовує" if shows(c) else "—")
                    new = "так" if shows(c) else c.get("new")
                    by = "judges, again" if k in again else "judges"
                date = kyiv(s["date"])
                ev = {"doc_id": s["doc_id"], "doc_ref": s.get("doc_ref"), "date": date, "stage": stage, "by": by}
                if lab == "застосовує" and (item["origin"] == "new" or new == "так"):
                    row["applied"].append(ev)
                elif lab == "застосовує":
                    row["applied_old_part"] += 1
                elif lab == "суперечить":
                    row["contradicted"].append(ev)
    assert not unresolved, f"{len(unresolved)} decisive splits without a reader label: {unresolved[:5]}"
    for row in norms.values():
        row["applied"].sort(key=lambda e: e["date"])
        first = row["applied"][0] if row["applied"] else None
        row["verdict"] = "codifies" if first else "announces"
        row["first_applied"] = first
        row["text_lag_years"] = round((CUTOFF - dt.date.fromisoformat(first["date"])).days / 365.25, 1) if first else None
        row["edrsr_term_hits"] = found.get(row["number"], {}).get("hits", 0)
    order = [p["number"] for p in json.loads((DATA / "propositions_2026.json").read_text())["propositions"]]
    rows = sorted(norms.values(), key=lambda r: order.index(r["number"]))
    out = {"cutoff": CUTOFF.isoformat(), "norms": rows,
           "summary": {f"{o} {v}": sum(r["origin"] == o and r["verdict"] == v for r in rows)
                       for o in ("new", "modified") for v in ("codifies", "announces")}}
    (DATA / "codify_2026.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for r in rows:
        f = r["first_applied"]
        print(f"  {r['number']:<8} {r['origin']:<9} {r['verdict']:<9} read {r['read']:>3}  "
              + (f"first {f['date']} {f['doc_ref'] or f['doc_id']} ({f['by']}), lag {r['text_lag_years']}y, "
                 f"{len(r['applied'])} decisions" if f else f"old part applied {r['applied_old_part']}, EDRSR hits {r['edrsr_term_hits']}")
              + (f"  CONTRADICTED {len(r['contradicted'])}" if r["contradicted"] else ""))
    print(out["summary"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
