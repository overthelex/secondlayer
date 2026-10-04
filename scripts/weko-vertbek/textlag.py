"""Text lag: how long the text took to codify practice that existed (PAPER-240).

The mirror of the announcement lag. For a codification, the years from the
earliest application in the record to the version that first stated the
rule. Measurement 1 found *an* application before the text; the earliest one
may lie further back, so the lag found so far is a lower bound. As for the
announcements (exhaustive.py), the decisions dated before that application
are searched in date order, nearest by meaning first:

  base    the earliest application known per codification: the full run's
          support, the step-2 readings (judges' agreed passages, the reader's
          marks) and the exhaustive search; where the reader decided a step-2
          dispute without marking a passage, the latest passage read stands
          in, which can only shorten the lag;
  plan    the 24 decisions nearest to the rule dated before that application,
          less those already read, in date order, in batches of eight;
  next    the batches (the judges read all; the first batch with an agreed
          application, or the reader on an earlier dispute, settles a rule);
  result  the text lag per codification.

    python3 textlag.py base
    python3 textlag.py plan --dsn ...
    python3 textlag.py next --dsn ... --round 1
    python3 textlag.py result
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys
from datetime import date

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import exhaustive as ex  # noqa: E402
import packet as pk  # noqa: E402
from retrieve import dense_index, embed  # noqa: E402

DATA = ex.DATA
DIR = ex.DIR
TOP = 24
STEP2 = ["review_before.json", "review_before_erl.json", "review_before_v3redo.json",
         "review_before_v5.json", "review_before_v6.json"]
HUMAN2 = ["human_labels_before_2026-10-03.json", "human_labels_before_erl_2026-10-03.json"]


def codifications() -> list[dict]:
    return [t for t in json.loads((DATA / "measure1_final_v8.json").read_text())
            if t["type"] == "norm" and t["final_class"] == "codification"]


def cmd_base(args) -> int:
    human = {}
    for f in HUMAN2:
        for r in json.loads((DATA / f).read_text())["labels"]:
            human[(r["version"], r["pid"])] = r
    found, read_any = collections.defaultdict(list), collections.defaultdict(list)
    for f in STEP2:
        for x in json.loads((DATA / f).read_text()):
            k = (x["version"], x["pid"]); h = human.get(k)
            reader = x["status"] == "disputed" and h
            sup = (h.get("label") if reader else x["prelabel"]) in ("supported", "fragment")
            if not sup:
                continue
            read_any[k] += [e["date"] or e["date_upper_bound"] for e in x["evidence"]]
            for e, v in zip(x["evidence"], x.get("judge_passages") or []):
                if reader:
                    marks = h.get("evidence") or []
                    on = e["ecli"] in marks or f"{e['ecli']}|{e['ord']}" in marks
                else:
                    on = any((v.get(j) or {}).get("label") in ("applies", "partial") for j in v)
                if on:
                    found[k].append(e["date"] or e["date_upper_bound"])
    rows = []
    for t in codifications():
        v0 = t["first_version"]; k = (v0, t["versions"][v0]["pid"])
        exh = (t.get("exhaustive") or {}).get("earliest")
        pre = [d for d in [s["date"] or s["bound"] for s in t["support"]] + found.get(k, []) + ([exh] if exh else [])
               if d < t["first_date"]]
        how = "found"
        if not pre:
            pre = [max(d for d in read_any[k] if d < t["first_date"])]
            how = "unmarked: latest passage read"
        earliest = min(pre)
        rows.append({"track": t["track"], "version": v0, "pid": k[1], "first_date": t["first_date"],
                     "earliest": earliest, "how": how,
                     "lag_years": round((date.fromisoformat(t["first_date"]) - date.fromisoformat(earliest)).days / 365.25, 1)})
    (DATA / "text_lag_base.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(len(rows), "codifications; unmarked:", [r["pid"] for r in rows if r["how"] != "found"])
    return 0


def cmd_plan(args) -> int:
    conn = ex.connect(args.dsn)
    base = {r["track"]: r for r in json.loads((DATA / "text_lag_base.json").read_text())}
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    meta = ex.meta_all(conn)
    vectors, eclis, ords = dense_index()
    ext = np.load(ex.EXT_VECTORS)
    ev = ext["vectors"].astype("float32"); ev /= np.linalg.norm(ev, axis=1, keepdims=True)
    V = np.vstack([vectors, ev])
    E = np.concatenate([np.asarray([str(e) for e in eclis]), ext["ecli"].astype(str)])
    O = np.concatenate([np.asarray(ords), ext["ord"]])
    notice = {e for e, m in meta.items() if m.get("rpw_chapter") == "D1"}
    seen = ex.read_already()
    cache: dict = {}
    plan = []
    for t in codifications():
        b = base[t["track"]]
        before = date.fromisoformat(b["earliest"])
        wordings = sorted({full[(v, d["pid"])]["text"] for v, d in t["versions"].items() if (v, d["pid"]) in full})
        Q = np.asarray(embed(wordings, ex.TEI, cache), dtype="float32"); Q /= np.linalg.norm(Q, axis=1, keepdims=True)
        score = (V @ Q.T).max(axis=1)
        already = set().union(*(seen.get((v, d["pid"]), set()) for v, d in t["versions"].items()))
        best: dict = {}
        for i in np.argsort(-score):
            e = E[i]
            if e in notice or e in best or e not in meta or (e, int(O[i])) in already:
                continue
            bound = meta[e]["date_upper_bound"]
            if not bound or bound >= before:
                continue
            best[e] = (float(score[i]), int(O[i]))
            if len(best) >= TOP:
                break
        chosen = sorted(best, key=lambda e: (meta[e]["date_upper_bound"], -best[e][0]))
        plan.append({"track": t["track"], "class": "codification", "version": b["version"], "pid": b["pid"],
                     "first_date": b["first_date"], "before": b["earliest"],
                     "candidates": [{"ecli": e, "ord": best[e][1], "score": round(best[e][0], 3),
                                     "date_upper_bound": str(meta[e]["date_upper_bound"]),
                                     "ext": bool(meta[e].get("ext"))} for e in chosen]})
    (DIR / "textlag_plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    print(f"{len(plan)} codifications; candidates per rule: "
          f"{dict(collections.Counter(min(len(p['candidates']) // ex.BATCH + (len(p['candidates']) % ex.BATCH > 0), 3) for p in plan))}")
    return 0


def cmd_next(args) -> int:
    conn = ex.connect(args.dsn)
    plan = json.loads((DIR / "textlag_plan.json").read_text())
    meta = ex.meta_all(conn)
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    items = []
    for p in plan:
        batch = p["candidates"][(args.round - 1) * ex.BATCH: args.round * ex.BATCH]
        if not batch:
            continue
        base = full[(p["version"], p["pid"])]
        evs = []
        for c in batch:
            body = conn.execute(
                "SELECT text FROM ch_weko_audit_passages_v2 WHERE ecli=%s AND ord=%s UNION ALL "
                "SELECT text FROM ch_weko_audit_ext_passages WHERE ecli=%s AND ord=%s",
                (c["ecli"], c["ord"], c["ecli"], c["ord"])).fetchone()["text"]
            evs.append(pk.evidence({"ecli": c["ecli"], "ord": c["ord"], "score": c["score"], "class": "textlag",
                                    "recital_share": pk.recital_share(base["text"], body), "body": body},
                                   meta, None, set()))
        items.append({**{k: base.get(k) for k in ("version", "pid", "part", "heading", "lead", "text")},
                      "kind": "sample", "track": p["track"], "round": args.round, "before": p["before"], "evidence": evs})
    out = DIR / f"packet_tlag_r{args.round}.json"
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1, default=str))
    print(f"round {args.round}: {len(items)} rules -> {out}")
    return 0


def settled(rounds: int) -> tuple[dict, list]:
    human = {}
    hf = DATA / "human_labels_tlag.json"
    if hf.exists():
        for x in json.loads(hf.read_text())["labels"]:
            human[(x["version"], x["pid"], x["round"])] = x
    out, need = {}, []
    for r in range(1, rounds + 1):
        f = DIR / f"review_tlag_r{r}.json"
        if not f.exists():
            continue
        for x in json.loads(f.read_text()):
            tr = x["track"]
            if tr in out or tr in {n[1] for n in need}:
                continue
            k = (x["version"], x["pid"], r)
            if x["status"] == "disputed":
                h = human.get(k)
                if not h:
                    need.append((r, tr, x["pid"], x["version"]))
                    continue
                if h["label"] in ex.SUP:
                    out[tr] = {"round": r, "by": "reader", "item": x, "marks": h.get("evidence_marked") or []}
            elif x["prelabel"] in ex.SUP:
                out[tr] = {"round": r, "by": "judges", "item": x, "marks": []}
    return out, need


def cmd_result(args) -> int:
    rounds = max((int(f.stem.split("_r")[-1]) for f in DIR.glob("review_tlag_r*.json")), default=0)
    done, need = settled(rounds)
    if need:
        print("disputes the reader has to settle first:", need)
        (DIR / "tlag_disputes_needed.json").write_text(json.dumps(need))
        return 1
    rows = []
    for b in json.loads((DATA / "text_lag_base.json").read_text()):
        hit = done.get(b["track"]); earliest = b["earliest"]; how = b["how"]
        if hit:
            ds = []
            for e, v in zip(hit["item"]["evidence"], hit["item"].get("judge_passages") or []):
                on = (f"{e['ecli']}|{e['ord']}" in hit["marks"] or e["ecli"] in hit["marks"]) if hit["by"] == "reader" \
                    else any((v.get(j) or {}).get("label") in ("applies", "partial") for j in v)
                if on:
                    ds.append(e["date"] or e["date_upper_bound"])
            if ds and min(ds) < earliest:
                earliest, how = min(ds), f"search round {hit['round']} ({hit['by']})"
        rows.append(dict(b, earliest=earliest, how=how,
                         lag_years=round((date.fromisoformat(b["first_date"]) - date.fromisoformat(earliest)).days / 365.25, 1)))
    (DATA / "text_lag.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    moved = [r for r in rows if r["how"].startswith("search")]
    print(len(rows), "codifications;", len(moved), "moved earlier by the search")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("base")
    for name in ("plan", "next"):
        s = sub.add_parser(name)
        s.add_argument("--dsn", required=True)
        if name == "next":
            s.add_argument("--round", type=int, required=True)
    sub.add_parser("result")
    args = ap.parse_args()
    return {"base": cmd_base, "plan": cmd_plan, "next": cmd_next, "result": cmd_result}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
