"""The exhaustive search for a rule's earliest application (PAPER-234).

Measurement 1 read eight passages per proposition. That is enough to find
support, not to say a rule is applied nowhere, nor to date its first
application: 2002 Ziff. 3(d) showed a lag of 23.9 years on eight passages.
Schrepel and Jenny read against every decision. Here, for every norm that
measurement 1 left an announcement or ungrounded:

  ext    the French and Italian decisions the German-word selection of the
         record missed, chosen by hand from the candidates (EXT), in a table
         of their own with their passages and vectors -- the record of the
         paper is not changed;
  plan   the 40 decisions nearest to the rule (best passage per decision,
         cosine over every passage of the record and of the extension, the
         query being every wording the rule's chain has had), less the
         passages already read, in order of date, cut into batches of eight;
  next   the next batch for every rule not yet settled, given the judges'
         answers and the reader's labels so far: reading stops at the first
         batch that holds an application -- in date order, the earliest one;
  result the earliest application found per rule, and its class again.

The judges read each batch under protocol v2 against the rule as first
stated, which is what an announcement announced.

    python3 exhaustive.py ext --dsn ...
    python3 exhaustive.py plan --dsn ...
    python3 exhaustive.py next --round 1           # writes packet_exh_r1.json
    python3 exhaustive.py result
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
import packet as pk  # noqa: E402
from retrieve import dense_index, embed, passages_of  # noqa: E402

DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
EXT_VECTORS = DIR / "vectors_ext.npz"
TEI = "http://172.30.0.2:80"
TOP = 40
BATCH = 8
SUP = ("supported", "fragment")

# French and Italian decisions outside the German-word record, read and kept
# by hand (2026-10-04) from 45 candidates naming the cartel act and a vertical
# term; the federal messages, reports, forms and reprints of notices among
# them are not decisions and were left out, as was one copy of each duplicate.
EXT = ["12.2003.112", "CR.2004.0363", "CM10.022542", "CC.2008.143", "C2 15 40", "604 2015 65", "12.2019.166",
       "4A_229/2021", "102 2018 98", "B-1410/2022", "B-2784/2022", "B-430/2023", "B-432/2023", "B-431/2023"]
EXT_DDL = ["""CREATE TABLE IF NOT EXISTS ch_weko_audit_ext (
    ecli text PRIMARY KEY, spider text, docket_number text, decision_date date, date_exact date,
    date_upper_bound date, date_source text, lang text, full_text text)""",
           """CREATE TABLE IF NOT EXISTS ch_weko_audit_ext_passages (
    ecli text NOT NULL, ord int NOT NULL, text text NOT NULL, PRIMARY KEY (ecli, ord))"""]


def connect(dsn: str):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(dsn, row_factory=dict_row)


def cmd_ext(args) -> int:
    conn = connect(args.dsn)
    for s in EXT_DDL:
        conn.execute(s)
    rows = conn.execute("""SELECT DISTINCT ON (docket_number) ecli, spider, docket_number, decision_date,
                                  metadata_json->>'Sprache' AS lang, full_text
                             FROM ch_court_decisions WHERE stage = 'loaded' AND docket_number = ANY(%s)
                            ORDER BY docket_number, decision_date""", (EXT,)).fetchall()
    missing = set(EXT) - {r["docket_number"] for r in rows}
    assert not missing, missing
    texts, keys = [], []
    with conn.cursor() as cur:
        cur.execute("DELETE FROM ch_weko_audit_ext_passages")
        cur.execute("DELETE FROM ch_weko_audit_ext")
        for r in rows:
            d = r["decision_date"]
            cur.execute("INSERT INTO ch_weko_audit_ext VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (r["ecli"], r["spider"], r["docket_number"], d, d, d, "record" if d else "none",
                         r["lang"], r["full_text"]))
            for i, c in enumerate(passages_of(r["full_text"])):
                cur.execute("INSERT INTO ch_weko_audit_ext_passages VALUES (%s,%s,%s)", (r["ecli"], i, c))
                texts.append(c); keys.append((r["ecli"], i))
    conn.commit()
    vecs = np.asarray(embed(texts, TEI, {}), dtype="float32")
    np.savez(EXT_VECTORS, vectors=vecs, ecli=np.array([k[0] for k in keys]), ord=np.array([k[1] for k in keys]))
    print(f"{len(rows)} decisions, {len(texts)} passages -> {EXT_VECTORS}")
    return 0


def meta_all(conn) -> dict:
    meta = {r["ecli"]: r for r in conn.execute(pk.META).fetchall()}
    for r in conn.execute("SELECT * FROM ch_weko_audit_ext").fetchall():
        meta[r["ecli"]] = {"ecli": r["ecli"], "spider": r["spider"], "docket_number": r["docket_number"],
                           "rpw_chapter": None, "date_exact": r["date_exact"], "date_upper_bound": r["date_upper_bound"],
                           "date_source": r["date_source"], "issue_key": None, "section": None, "section_name": None,
                           "same_as": None, "lang": r["lang"], "pdf_page": None, "journal_pages": None,
                           "opening": (r["full_text"] or "")[:600], "ext": True}
    return meta


def read_already() -> dict[str, set]:
    """(version, pid) -> passages any judge has already read for it."""
    seen = collections.defaultdict(set)
    for f in [DIR / "packet_full_v3.json", DIR / "packet_before.json", DIR / "packet_before_erl.json",
              DIR / "packet_before_v3redo.json", DIR / "packet_before_v5.json", DIR / "packet_before_v6.json"]:
        if f.exists():
            for p in json.loads(f.read_text()):
                for e in p["evidence"]:
                    seen[(p["version"], p["pid"])].add((e["ecli"], e["ord"]))
    return seen


def cmd_plan(args) -> int:
    conn = connect(args.dsn)
    m1 = [t for t in json.loads((DATA / "measure1_final_v7.json").read_text())
          if t["type"] == "norm" and t["final_class"] in ("announcement", "ungrounded")]
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    meta = meta_all(conn)
    vectors, eclis, ords = dense_index()
    ext = np.load(EXT_VECTORS)
    ev = ext["vectors"].astype("float32"); ev /= np.linalg.norm(ev, axis=1, keepdims=True)
    V = np.vstack([vectors, ev])
    E = np.concatenate([np.asarray([str(e) for e in eclis]), ext["ecli"].astype(str)])
    O = np.concatenate([np.asarray(ords), ext["ord"]])
    notice = {e for e, m in meta.items() if m.get("rpw_chapter") == "D1"}
    seen = read_already()
    cache: dict = {}
    plan = []
    for t in m1:
        v0 = t["first_version"]; pid0 = t["versions"][v0]["pid"]
        wordings = sorted({full[(v, d["pid"])]["text"] for v, d in t["versions"].items() if (v, d["pid"]) in full})
        Q = np.asarray(embed(wordings, TEI, cache), dtype="float32")
        Q /= np.linalg.norm(Q, axis=1, keepdims=True)
        score = (V @ Q.T).max(axis=1)
        already = set().union(*(seen.get((v, d["pid"]), set()) for v, d in t["versions"].items()))
        best: dict[str, tuple] = {}
        for i in np.argsort(-score):
            e = E[i]
            if e in notice or e in best or e not in meta or (e, int(O[i])) in already:
                continue
            best[e] = (float(score[i]), int(O[i]))
            if len(best) >= TOP:
                break
        when = lambda e: meta[e]["date_upper_bound"] or date(2100, 1, 1)
        chosen = sorted(best, key=lambda e: (when(e), -best[e][0]))
        plan.append({"track": t["track"], "class": t["final_class"], "version": v0, "pid": pid0,
                     "first_date": t["first_date"], "lag_years": t["lag_years"],
                     "candidates": [{"ecli": e, "ord": best[e][1], "score": round(best[e][0], 3),
                                     "date_upper_bound": str(meta[e]["date_upper_bound"]),
                                     "ext": bool(meta[e].get("ext"))} for e in chosen]})
    (DIR / "exhaustive_plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    print(f"{len(plan)} rules, {sum(len(p['candidates']) for p in plan)} candidate decisions, "
          f"{sum(c['ext'] for p in plan for c in p['candidates'])} of them from the extension")
    return 0


def settled(rnd: int) -> dict[str, dict]:
    """Rules settled by rounds 1..rnd: an application found (both judges by
    the binary-check rule, or the reader) -- with its date -- or every batch read."""
    out = {}
    for r in range(1, rnd + 1):
        f = DIR / f"review_exh_r{r}.json"
        if not f.exists():
            continue
        human = {}
        hf = DATA / f"human_labels_exh_r{r}.json"
        if hf.exists():
            human = {(x["version"], x["pid"]): x["label"] for x in json.loads(hf.read_text())["labels"]}
        for x in json.loads(f.read_text()):
            k = (x["version"], x["pid"])
            lab = human.get(k) if x["status"] == "disputed" else x["prelabel"]
            if lab is None:
                raise SystemExit(f"{k} disputed in round {r} and not labelled by the reader")
            track = x["track"]
            if track in out:
                continue
            if lab in SUP:
                out[track] = {"round": r, "label": lab, "item": x}
    return out


def cmd_next(args) -> int:
    conn = connect(args.dsn)
    plan = json.loads((DIR / "exhaustive_plan.json").read_text())
    done = settled(args.round - 1)
    meta = meta_all(conn)
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    items = []
    for p in plan:
        if p["track"] in done:
            continue
        batch = p["candidates"][(args.round - 1) * BATCH: args.round * BATCH]
        if not batch:
            continue
        base = full[(p["version"], p["pid"])]
        ev = []
        for c in batch:
            body = conn.execute(
                "SELECT text FROM ch_weko_audit_passages_v2 WHERE ecli=%s AND ord=%s UNION ALL "
                "SELECT text FROM ch_weko_audit_ext_passages WHERE ecli=%s AND ord=%s",
                (c["ecli"], c["ord"], c["ecli"], c["ord"])).fetchone()["text"]
            ev.append(pk.evidence({"ecli": c["ecli"], "ord": c["ord"], "score": c["score"], "class": "exhaustive",
                                   "recital_share": pk.recital_share(base["text"], body), "body": body},
                                  meta, None, set()))
        items.append({**{k: base.get(k) for k in ("version", "pid", "part", "heading", "lead", "text")},
                      "kind": "sample", "track": p["track"], "round": args.round, "evidence": ev})
    out = DIR / f"packet_exh_r{args.round}.json"
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1, default=str))
    print(f"round {args.round}: {len(items)} rules still open -> {out}")
    return 0


def cmd_result(args) -> int:
    plan = {p["track"]: p for p in json.loads((DIR / "exhaustive_plan.json").read_text())}
    rounds = max((int(f.stem.split("_r")[-1]) for f in DIR.glob("review_exh_r*.json")), default=0)
    done = settled(rounds)
    m1 = json.loads((DATA / "measure1_final_v7.json").read_text())
    rows, cls = [], collections.Counter()
    for t in m1:
        if t["track"] not in plan:
            continue
        first = date.fromisoformat(t["first_date"])
        old_first = min((date.fromisoformat(s["date"] or s["bound"]) for s in t["support"]), default=None)
        hit = done.get(t["track"])
        new_first = None
        if hit:
            it = hit["item"]
            jp = it.get("judge_passages") or []
            sup_dates = []
            for e, votes in zip(it["evidence"], jp):
                c = (votes.get("claude-opus") or {}).get("label")
                if c in ("applies", "partial"):
                    sup_dates.append(date.fromisoformat(e["date"] or e["date_upper_bound"]))
            if sup_dates:
                new_first = min(sup_dates)
        earliest = min(d for d in (old_first, new_first) if d) if (old_first or new_first) else None
        if earliest is None:
            new_cls = "ungrounded"
        elif earliest < first:
            new_cls = "codification"
        else:
            new_cls = "announcement"
        lag = round((earliest - first).days / 365.25, 1) if earliest and new_cls == "announcement" else None
        cls[(t["final_class"], new_cls)] += 1
        rows.append({"track": t["track"], "version": t["first_version"], "pid": t["versions"][t["first_version"]]["pid"],
                     "old_class": t["final_class"], "old_lag": t["lag_years"], "class": new_cls, "lag_years": lag,
                     "earliest": str(earliest) if earliest else None, "found_in_round": hit["round"] if hit else None,
                     "batches_read": hit["round"] if hit else rounds})
    (DATA / "exhaustive_result.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print("old -> new:", dict(cls))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("ext", "plan", "next"):
        s = sub.add_parser(name)
        s.add_argument("--dsn", required=True)
        if name == "next":
            s.add_argument("--round", type=int, required=True)
    sub.add_parser("result")
    args = ap.parse_args()
    return {"ext": cmd_ext, "plan": cmd_plan, "next": cmd_next, "result": cmd_result}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
