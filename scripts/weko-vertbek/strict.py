"""Measurement 1 with full application only (PAPER-235 a).

Measurement 1 counts a decision as support when it applies a rule fully or in
part. A decision that applies a fragment of a rule has not adopted the rule;
here only full application counts:

  judges    a passage Claude labels "applies" (not "partial")
  reader    a passage the reader marked on an item labelled "supported"
            (not "fragment")

over every reading of the audit: the full run, the step-2 readings of the
earlier record, the exhaustive search and the text-lag search. A
codification stays one only if a full application is dated before its first
version; one with partial applications only before it is "fragment-first".
An announcement's lag runs to its first full application.

The searches stopped at the first batch holding any application, so a full
application in a later batch may be unread: the count of full codifications
is a lower bound.

    python3 strict.py --dsn ...
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
SUP = ("supported", "fragment")
STEP2 = ["review_before.json", "review_before_erl.json", "review_before_v3redo.json",
         "review_before_v5.json", "review_before_v6.json"]
HUMAN2 = ["human_labels_before_2026-10-03.json", "human_labels_before_erl_2026-10-03.json"]


def marked(e: dict, marks: list) -> bool:
    return e["ecli"] in marks or f"{e['ecli']}|{e['ord']}" in marks


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    dates = {r["ecli"]: str(r["d"]) for r in conn.execute(
        "SELECT ecli, coalesce(date_exact, date_upper_bound) d FROM ch_weko_audit_corpus").fetchall() if r["d"]}

    # (version, pid) -> [(date, full?)]
    hits: dict = collections.defaultdict(list)

    # the full run
    labels = {(r["version"], r["pid"]): r for r in json.loads((DATA / "labels_full_v3.json").read_text())["labels"]}
    claude = {}
    for line in (DATA / "judges-v3" / "claude-opus.jsonl").read_text().splitlines():
        r = json.loads(line)
        claude[(r["version"], r["pid"])] = r["passages"]
    for k, r in labels.items():
        if r["label"] not in SUP:
            continue
        if r["source"] == "judges":
            for p in claude.get(k, []):
                if p["label"] in ("applies", "partial") and p["ecli"] in dates:
                    hits[k].append((dates[p["ecli"]], p["label"] == "applies"))
        else:
            for e in r.get("evidence_marked") or []:
                ecli = e.split("|")[0]
                if ecli in dates:
                    hits[k].append((dates[ecli], r["label"] == "supported"))

    def reviews(items, human):
        """items of an aggregated review; human: (version, pid[, round]) -> (label, marks)."""
        for x, hk in items:
            k = (x["version"], x["pid"])
            if x["status"] == "disputed":
                h = human.get(hk)
                if not h or h[0] not in SUP:
                    continue
                for e in x["evidence"]:
                    if marked(e, h[1]):
                        hits[k].append((e["date"] or e["date_upper_bound"], h[0] == "supported"))
            elif x["prelabel"] in SUP:
                for e, v in zip(x["evidence"], x.get("judge_passages") or []):
                    lab = (v.get("claude-opus") or {}).get("label")
                    if lab in ("applies", "partial"):
                        hits[k].append((e["date"] or e["date_upper_bound"], lab == "applies"))

    # step 2
    h2 = {}
    for f in HUMAN2:
        for r in json.loads((DATA / f).read_text())["labels"]:
            h2[(r["version"], r["pid"])] = (r["label"], r.get("evidence") or [])
    for f in STEP2:
        reviews([(x, (x["version"], x["pid"])) for x in json.loads((DATA / f).read_text())], h2)
    # exhaustive and text-lag searches
    for stem, hf in (("review_exh_r", "human_labels_exh.json"), ("review_tlag_r", "human_labels_tlag.json")):
        hh = {(r["version"], r["pid"], r["round"]): (r["label"], r.get("evidence_marked") or [])
              for r in json.loads((DATA / hf).read_text())["labels"]}
        for f in sorted(DIR.glob(stem + "*.json")):
            rnd = int(f.stem.split("_r")[-1])
            reviews([(x, (x["version"], x["pid"], rnd)) for x in json.loads(f.read_text())], hh)

    m1 = [t for t in json.loads((DATA / "measure1_final_v9.json").read_text()) if t["type"] == "norm"]
    rows, moves = [], collections.Counter()
    for t in m1:
        keys = {(v, d["pid"]) for v, d in t["versions"].items()}
        keys |= {(v, d["pid"]) for v, ds in (t.get("split") or {}).items() for d in ds}
        hs = sorted(h for k in keys for h in hits.get(k, []))
        first = t["first_date"]
        full = [d for d, f in hs if f]
        if t["final_class"] == "ungrounded":
            cls = "ungrounded"
        elif any(d < first for d in full):
            cls = "codification"
        elif t["final_class"] == "codification":
            cls = "fragment-first"
        elif full:
            cls = "announcement"
        else:
            cls = "fragment-only"
        after = [d for d in full if d >= first]
        lag = round((date.fromisoformat(min(after)) - date.fromisoformat(first)).days / 365.25, 1) \
            if cls in ("announcement", "fragment-first") and after else None
        moves[(t["final_class"], cls)] += 1
        rows.append({"track": t["track"], "version": t["first_version"], "pid": t["versions"][t["first_version"]]["pid"],
                     "first_date": first, "class": t["final_class"], "strict_class": cls, "full_lag_years": lag,
                     "full_dates": full[:5]})
    # the detector first: every codification must show some application before its text,
    # every announcement some application at all, or a reading is missing
    gaps = []
    for t in m1:
        keys = {(v, d["pid"]) for v, d in t["versions"].items()}
        keys |= {(v, d["pid"]) for v, ds in (t.get("split") or {}).items() for d in ds}
        hs = [d for k in keys for d, _ in hits.get(k, [])]
        if t["final_class"] == "codification" and not any(d < t["first_date"] for d in hs):
            gaps.append(("codification", t["track"], t["first_version"]))
        if t["final_class"] == "announcement" and not hs:
            gaps.append(("announcement", t["track"], t["first_version"]))
    print("readings missing for:", gaps)
    (DATA / "strict.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(len(rows), "norms")
    for (a, b), n in sorted(moves.items()):
        print(f"  {a:13} -> {b:15} {n}")
    for c in ("announcement", "fragment-first"):
        lags = [r["full_lag_years"] for r in rows if r["strict_class"] == c and r["full_lag_years"] is not None]
        if lags:
            print(c, "lag to first full application: n", len(lags), "median", statistics.median(lags))
    print("by version:", dict(collections.Counter((r["version"], r["strict_class"]) for r in rows)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
