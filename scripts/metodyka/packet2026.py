"""The review packet for the 2026 Methodology's new and modified norms (PAPER-244).

Schrepel and Jenny's question in the form they built it for: a text with a
record before it and none yet after. z1043-26 came into force on 1 August
2026; the record (AMCU decisions 2017-2026, court judgments 2006-2026) lies
almost wholly before it. For every norm of the 2026 text that is new or
modified against 2002 (align2026.py, typology_ua.json), the passages are
chosen exactly as packet.py chose them for the 2002 text -- dense and keyword
candidates, recitation last, no twins, three agency slots -- from decisions
dated before 1 August 2026. A modified norm carries its 2002 counterpart, so
the judges can say whether a passage shows what changed.

    python3 packet2026.py --out /data/amcu/packet2026.json
"""
from __future__ import annotations

import argparse
import json
import pathlib

import psycopg2
import psycopg2.extras

import packet
import retrieve

DATA = pathlib.Path(__file__).resolve().parents[2] / "data" / "metodyka"
CUTOFF = "2026-08-01"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--out", default="/data/amcu/packet2026.json")
    args = ap.parse_args()
    new = {p["number"]: p for p in json.loads((DATA / "propositions_2026.json").read_text())["propositions"]}
    old = json.loads((DATA / "propositions.json").read_text())
    old = {p["number"]: p for p in (old["propositions"] if isinstance(old, dict) else old)}
    types = {r["pid"]: r["type"] for r in json.loads((DATA / "typology_ua.json").read_text())["types"]
             if r["version"] == "2026"}
    origin = {r["number"]: r for r in json.loads((DATA / "alignment_2002_2026.json").read_text())["new"]}
    targets = [n for n in new if types[n] == "norm" and origin[n]["origin"] in ("new", "modified")]

    conn = psycopg2.connect(retrieve.dsn())
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT doc_id FROM ua_metodyka_audit_corpus WHERE decision_date < %s", (CUTOFF,))
        before = {r["doc_id"] for r in cur.fetchall()}
    keep = retrieve.canonical_ids(conn) & before
    index = retrieve.dense_index()
    cache: dict = {}
    out = []
    for n in targets:
        p = new[n]
        hits = packet.pool(conn, index, p["text"], args.k, cache, keep)
        bodies, meta = packet.passage_bodies(conn, hits)
        o = origin[n]
        out.append({
            "number": n, "rozdil": p["rozdil"], "rozdil_title": p["rozdil_title"], "text": p["text"],
            "origin": o["origin"], "from_2002": o["from_2002"],
            "text_2002": old[o["from_2002"]]["text"] if o["from_2002"] else None,
            "passages": [{"doc_id": h["doc_id"], "ord": h["ord"], "score": round(h["rank"], 4),
                          "found_by": h.get("source", "dense"), "recital": h["recital"],
                          "corpus": meta.get(h["doc_id"], {}).get("corpus"),
                          "doc_ref": meta.get(h["doc_id"], {}).get("doc_ref"),
                          "date": str(meta.get(h["doc_id"], {}).get("decision_date") or ""),
                          "body": bodies.get((h["doc_id"], h["ord"]), "")} for h in hits]})
        print(f"  {n:<8} {o['origin']:<9} {len(hits)} passages, "
              f"{sum(h['doc_id'].startswith('amcu:') for h in hits)} agency", flush=True)
    pathlib.Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    late = [s for p in out for s in p["passages"] if s["date"] >= CUTOFF]
    assert not late, f"{len(late)} passages dated on or after {CUTOFF}"
    print(f"{len(out)} norms ({sum(p['origin'] == 'new' for p in out)} new, "
          f"{sum(p['origin'] == 'modified' for p in out)} modified), "
          f"{sum(len(p['passages']) for p in out)} passages, all before {CUTOFF} -> {args.out}")


if __name__ == "__main__":
    main()
