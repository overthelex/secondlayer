"""The review packet: every proposition with the passages the record offers it.

This is what both the human reader and the judge see, and they must see the
same thing. For each of the instrument's 66 propositions it collects the top
passages by dense similarity, marks which of their decisions cite the
proposition by number, and writes one JSON file.

The citation marks are kept out of the reader's way on purpose: whether a
decision names пункт 6.1 says nothing about whether the passage in front of
you applies it, and a reader told the answer stops reading. They are in the
file so that agreement can be measured afterwards.

Usage:
    python3 packet.py --k 8 --out packet.json
"""
from __future__ import annotations

import argparse
import json

import psycopg2
import psycopg2.extras

import metodyka
import retrieve


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--goldset", default="/data/amcu/goldset.jsonl")
    ap.add_argument("--out", default="packet.json")
    args = ap.parse_args()

    props = metodyka.load("db")
    cited: dict[str, set[str]] = {p.number: set() for p in props}
    for line in open(args.goldset, encoding="utf-8"):
        row = json.loads(line)
        doc_id = f"{row['corpus']}:{row['doc_id']}"
        for cite in row["cites"]:
            if cite["kind"] == "punkt" and cite["number"] in cited:
                cited[cite["number"]].add(doc_id)

    conn = psycopg2.connect(retrieve.dsn())
    index = retrieve.dense_index()
    cache: dict = {}
    out = []
    for prop in props:
        hits = retrieve.search_dense(index, prop.text, args.k, cache)
        ids = [h["doc_id"] for h in hits]
        bodies, meta = passage_bodies(conn, hits)
        out.append({
            "number": prop.number,
            "rozdil": prop.rozdil,
            "rozdil_title": prop.rozdil_title,
            "text": prop.text,
            "cited_by": len(cited[prop.number]),
            "passages": [
                {"doc_id": h["doc_id"], "ord": h["ord"],
                 "score": round(h["rank"], 4),
                 "corpus": meta.get(h["doc_id"], {}).get("corpus"),
                 "doc_ref": meta.get(h["doc_id"], {}).get("doc_ref"),
                 "date": str(meta.get(h["doc_id"], {}).get("decision_date") or ""),
                 "cites_this": h["doc_id"] in cited[prop.number],
                 "body": bodies.get((h["doc_id"], h["ord"]), "")}
                for h in hits],
        })
        print(f"  {prop.number:<9} {len(hits)} passages, "
              f"{sum(1 for h in hits if h['doc_id'] in cited[prop.number])} of them cite it")
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    total = sum(len(p["passages"]) for p in out)
    print(f"{len(out)} propositions, {total} passages -> {args.out}")


def passage_bodies(conn, hits: list[dict]) -> tuple[dict, dict]:
    if not hits:
        return {}, {}
    keys = [(h["doc_id"], h["ord"]) for h in hits]
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT doc_id, ord, body FROM ua_metodyka_audit_passages "
            "WHERE (doc_id, ord) IN %s", (tuple(keys),))
        bodies = {(r["doc_id"], r["ord"]): r["body"] for r in cur.fetchall()}
        cur.execute(
            "SELECT doc_id, corpus, doc_ref, decision_date "
            "FROM ua_metodyka_audit_corpus WHERE doc_id = ANY(%s)",
            ([h["doc_id"] for h in hits],))
        meta = {r["doc_id"]: dict(r) for r in cur.fetchall()}
    return bodies, meta


if __name__ == "__main__":
    main()
