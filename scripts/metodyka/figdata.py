"""Export what the figures plot, so the R scripts read a file rather than a database."""
import csv
import json

NAMES = {"yes": "застосовує", "no": "суперечить", "cite": "лише переказує", "off": "не про це"}


def load(path, rename=False):
    out = {}
    for r in map(json.loads, open(path, encoding="utf-8")):
        if r.get("label"):
            out[(r["number"], r["doc_id"], r["ord"])] = (
                NAMES.get(r["label"], r["label"]) if rename else r["label"])
    return out


human = load("/data/amcu/human-labels.jsonl", rename=True)
a = load("/data/amcu/judge-sonnet46-v2.jsonl")
b = load("/data/amcu/judge-deepseek-v2.jsonl")
packet = json.load(open("/data/amcu/packet.json", encoding="utf-8"))
cov = {p["number"]: p for p in
       json.load(open("/data/amcu/coverage.json", encoding="utf-8"))["propositions"]}

rows = []
for p in packet:
    labels, read = set(), 0
    for s in p["passages"]:
        k = (p["number"], s["doc_id"], s["ord"])
        if k in human:
            labels.add(human[k]); read += 1
        elif k in a and k in b and a[k] == b[k]:
            labels.add(a[k])
        elif k in a:
            labels.add(a[k])
    c = cov[p["number"]]
    rows.append({
        "number": p["number"], "section": c["rozdil"],
        "amcu": c["amcu"], "court": c["court"], "citations": c["amcu"] + c["court"],
        "applied": int("застосовує" in labels), "read": read,
        "fresh": sum(1 for s in p["passages"] if not s.get("recital")),
    })

with open("/data/amcu/paper/figures/provisions.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
print(f"{len(rows)} provisions, {sum(1 for r in rows if not r['applied'])} with no application")
