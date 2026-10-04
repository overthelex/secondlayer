"""Robustness of measurement 1 (PAPER-236): aggregation rules and the bootstrap.

Measurement 1 is rebuilt from every passage the audit read -- the full run,
the step-2 readings of the earlier record, the exhaustive search and the
text-lag search -- with each passage's two judge labels and, where the
reader settled the proposition, the reader's marks. A passage supports a
rule under

  published  the reader's marks where the reader decided; else Claude's
             label (applies or partial) on a proposition the judges agree
             is supported
  claude     Claude's label alone
  gemini     Gemini's label alone
  both       both judges' labels
  either     either judge's label

and a norm is a codification if a supporting passage is dated before its
first version, an announcement if one is dated after, ungrounded otherwise.
The published rule must reproduce measurement 1 (measure1_final_v9.json)
exactly; the others say how much of the result is the aggregation rule.
The searches ran only where the published rule left a question open, so the
other rules read the same passages, not the passages they would have
searched for: an upper bound on how far the result moves.

The bootstrap resamples the 79 norms (10,000 draws) for intervals on the
class shares and the median announcement lag.

    python3 robust.py --dsn ...
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random
import statistics
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
SUP = ("supported", "fragment")
ON = ("applies", "partial")
STEP2 = ["review_before.json", "review_before_erl.json", "review_before_v3redo.json",
         "review_before_v5.json", "review_before_v6.json"]
HUMAN2 = ["human_labels_before_2026-10-03.json", "human_labels_before_erl_2026-10-03.json"]
RULES = ("published", "claude", "gemini", "both", "either")


def supports(rule: str, p: dict) -> bool:
    c, g = p["claude"] in ON, p["gemini"] in ON
    if rule == "published":
        return p["reader"] if p["reader"] is not None else (p["item_sup"] and c)
    return {"claude": c, "gemini": g, "both": c and g, "either": c or g}[rule]


def collect(dates: dict) -> dict:
    """(version, pid) -> passages {date, claude, gemini, reader, item_sup}."""
    out = collections.defaultdict(list)

    # the full run
    labels = {(r["version"], r["pid"]): r for r in json.loads((DATA / "labels_full_v3.json").read_text())["labels"]}
    judge = {}
    for who in ("claude-opus", "gemini-3.1-pro"):
        for line in (DATA / "judges-v3" / f"{who}.jsonl").read_text().splitlines():
            r = json.loads(line)
            judge[(who, r["version"], r["pid"])] = r["passages"]
    for k, r in labels.items():
        cs, gs = judge.get(("claude-opus",) + k, []), judge.get(("gemini-3.1-pro",) + k, [])
        if [p["ecli"] for p in cs] != [p["ecli"] for p in gs]:
            raise SystemExit(f"{k}: the judges read different passages")
        reader = r["source"] != "judges"
        marks = {m.split("|")[0] for m in (r.get("evidence_marked") or [])}
        for c, g in zip(cs, gs):
            if c["ecli"] not in dates:
                continue
            out[k].append({"date": dates[c["ecli"]], "claude": c["label"], "gemini": g["label"],
                           "reader": (r["label"] in SUP and c["ecli"] in marks) if reader else None,
                           "item_sup": r["label"] in SUP})
        # a gold-set mark on a decision the v3 packet no longer shows (the
        # reader read the earlier packet): measurement 1 takes the marks as
        # they stand, and so does the published rule here
        shown = {c["ecli"] for c in cs}
        for e in marks - shown if reader and r["label"] in SUP else ():
            if e in dates:
                out[k].append({"date": dates[e], "claude": None, "gemini": None, "reader": True, "item_sup": True})

    def review(items, human):
        for x, hk in items:
            k = (x["version"], x["pid"])
            h = human.get(hk) if x["status"] == "disputed" else None
            # a dispute in a later batch of a search the reader never saw:
            # the rule was settled in an earlier batch, and the published
            # result does not use it
            unseen = x["status"] == "disputed" and not h
            for e, v in zip(x["evidence"], x.get("judge_passages") or []):
                on = None
                if h:
                    on = h[0] in SUP and (e["ecli"] in h[1] or f"{e['ecli']}|{e['ord']}" in h[1])
                elif unseen:
                    on = False
                out[k].append({"date": e["date"] or e["date_upper_bound"],
                               "claude": (v.get("claude-opus") or {}).get("label"),
                               "gemini": (v.get("gemini-3.1-pro") or {}).get("label"),
                               "reader": on, "item_sup": x["prelabel"] in SUP})

    h2 = {}
    for f in HUMAN2:
        for r in json.loads((DATA / f).read_text())["labels"]:
            h2[(r["version"], r["pid"])] = (r["label"], r.get("evidence") or [])
    for f in STEP2:
        review([(x, (x["version"], x["pid"])) for x in json.loads((DATA / f).read_text())], h2)
    for stem, hf in (("review_exh_r", "human_labels_exh.json"), ("review_tlag_r", "human_labels_tlag.json")):
        hh = {(r["version"], r["pid"], r["round"]): (r["label"], r.get("evidence_marked") or [])
              for r in json.loads((DATA / hf).read_text())["labels"]}
        for f in sorted(DIR.glob(stem + "*.json")):
            rnd = int(f.stem.split("_r")[-1])
            review([(x, (x["version"], x["pid"], rnd)) for x in json.loads(f.read_text())], hh)
    return out


def classify(t: dict, passages: list, rule: str) -> tuple[str, float | None]:
    ds = sorted(p["date"] for p in passages if supports(rule, p))
    first = t["first_date"]
    if any(d < first for d in ds):
        return "codification", None
    if ds:
        return "announcement", round((date.fromisoformat(ds[0]) - date.fromisoformat(first)).days / 365.25, 1)
    return "ungrounded", None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--draws", type=int, default=10000)
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    dates = {r["ecli"]: str(r["d"]) for r in conn.execute(
        "SELECT ecli, coalesce(date_exact, date_upper_bound) d FROM ch_weko_audit_corpus").fetchall() if r["d"]}
    hits = collect(dates)

    m1 = [t for t in json.loads((DATA / "measure1_final_v9.json").read_text()) if t["type"] == "norm"]
    rows, res = [], {}
    for t in m1:
        keys = {(v, d["pid"]) for v, d in t["versions"].items()}
        keys |= {(v, d["pid"]) for v, ds in (t.get("split") or {}).items() for d in ds}
        ps = [p for k in keys for p in hits.get(k, [])]
        row = {"track": t["track"], "version": t["first_version"], "class_v8": t["final_class"], "lag_v8": t["lag_years"]}
        for r in RULES:
            row[r], row[r + "_lag"] = classify(t, ps, r)
        rows.append(row)

    # the detector first: the published rule must give measurement 1
    off = [(r["track"], r["class_v8"], r["published"]) for r in rows if r["published"] != r["class_v8"]]
    print("published rule vs measurement 1, class mismatches:", off)
    lag_off = [(r["track"], r["lag_v8"], r["published_lag"]) for r in rows
               if r["class_v8"] == "announcement" and r["lag_v8"] != r["published_lag"]]
    print("announcement lags that differ:", lag_off)

    for r in RULES:
        c = collections.Counter(x[r] for x in rows)
        lags = [x[r + "_lag"] for x in rows if x[r] == "announcement"]
        moved = sum(x[r] != x["class_v8"] for x in rows)
        res[r] = {"codification": c["codification"], "announcement": c["announcement"], "ungrounded": c["ungrounded"],
                  "lag_median": statistics.median(lags) if lags else None, "differs_from_published": moved,
                  "erl_codification": sum(x[r] == "codification" for x in rows if x["version"] in ("2019-04-09", "2022-12-12-erl")),
                  "early_announcement": sum(x[r] == "announcement" for x in rows if x["version"] in ("2002-02-18", "2007-07-02"))}
        print(f"{r:10}", res[r])

    # bootstrap over the norms, on the published result
    rng = random.Random(236)
    n = len(m1)
    share = collections.defaultdict(list); med = []
    for _ in range(args.draws):
        s = [m1[rng.randrange(n)] for _ in range(n)]
        c = collections.Counter(t["final_class"] for t in s)
        for k in ("codification", "announcement", "ungrounded"):
            share[k].append(c[k] / n)
        lags = [t["lag_years"] for t in s if t["final_class"] == "announcement" and t["lag_years"] is not None]
        if lags:
            med.append(statistics.median(lags))

    def ci(xs):
        xs = sorted(xs)
        return [round(xs[int(0.025 * len(xs))], 3), round(xs[int(0.975 * len(xs)) - 1], 3)]
    boot = {k: ci(v) for k, v in share.items()}
    boot["lag_median"] = ci(med)
    print("bootstrap 95%:", boot)
    (DATA / "robustness.json").write_text(json.dumps({"rules": res, "bootstrap": boot, "draws": args.draws,
                                                      "norms": rows}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
