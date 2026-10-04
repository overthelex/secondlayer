"""Would the French and Italian decisions the record misses have been read? (PAPER-236)

frit_selection.json lists the decisions outside the record that the
German selection rule, put into French and Italian, finds on vertical
agreements. The exhaustive and text-lag searches read, per rule, the 24
decisions nearest to it; a decision of the supplementary selection matters
only if it would have entered those 24 (for the text-lag search, also dated
before the cut-off). Its passages are embedded as the record's were and
scored against every wording of the rule.

    python3 frit_rank.py --dsn ...
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from retrieve import embed, passages_of  # noqa: E402

DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")
TEI = "http://172.30.0.2:80"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    sel = json.loads((DATA / "frit_selection.json").read_text())
    ext = {r["ecli"] for r in conn.execute("SELECT DISTINCT ecli FROM ch_weko_audit_ext_passages").fetchall()}
    new = [c for c in sel["candidates"] if c["ecli"] not in ext]
    rows = conn.execute("SELECT ecli, full_text FROM ch_court_decisions WHERE ecli = ANY(%s)",
                        ([c["ecli"] for c in new],)).fetchall()
    texts, owner = [], []
    for r in rows:
        for p in passages_of(r["full_text"] or ""):
            texts.append(p); owner.append(r["ecli"])
    cache: dict = {}
    V = np.asarray(embed(texts, TEI, cache), dtype="float32"); V /= np.linalg.norm(V, axis=1, keepdims=True)
    date = {c["ecli"]: c["date"] for c in new}
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    m1 = {t["track"]: t for t in json.loads((DATA / "measure1_final_v9.json").read_text())}
    hits = []
    for name, plan in (("exhaustive", "exhaustive_plan.json"), ("textlag", "textlag_plan.json")):
        for p in json.loads((DIR / plan).read_text()):
            t = m1[p["track"]]
            wordings = sorted({full[(v, d["pid"])]["text"] for v, d in t["versions"].items() if (v, d["pid"]) in full})
            Q = np.asarray(embed(wordings, TEI, cache), dtype="float32"); Q /= np.linalg.norm(Q, axis=1, keepdims=True)
            s = (V @ Q.T).max(axis=1)
            floor = min(c["score"] for c in p["candidates"])
            best: dict = {}
            for i, e in enumerate(owner):
                if p.get("before") and date[e] >= p["before"]:
                    continue
                best[e] = max(best.get(e, -1), float(s[i]))
            for e, sc in best.items():
                if sc > floor:
                    hits.append({"search": name, "track": p["track"], "pid": p["pid"], "version": p["version"],
                                 "ecli": e, "date": date[e], "score": round(sc, 3), "floor": floor})
    out = {"decisions": len(new), "passages": len(texts), "would_enter": hits}
    (DATA / "frit_rank.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(new)} decisions, {len(texts)} passages; would enter the 24 nearest: {len(hits)}")
    for h in hits:
        print("  ", h)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
