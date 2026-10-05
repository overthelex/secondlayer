"""Judgments the record lacks, read for the 2026 norms (PAPER-244).

fullsearch2026.py found 74 judgments outside the record that use the terms
of a new or modified norm in a competition context. For each (norm,
judgment) the passage read is one that contains the term (passages cut as
for the record, retrieve.passages_of) and, among those, the nearest to the
norm by bge-m3; if the term falls across a cut, the nearest passage of the
judgment. Same judges, same task (judge2026.py).

    python3 ext2026.py --out /data/amcu/packet2026_ext.json
"""
from __future__ import annotations

import argparse
import json
import pathlib

import numpy as np
import psycopg2

import fullsearch2026
import retrieve

DATA = pathlib.Path(__file__).resolve().parents[2] / "data" / "metodyka"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--search", default="/data/amcu/fullsearch2026.json")
    ap.add_argument("--first", default="/data/amcu/packet2026.json")
    ap.add_argument("--out", default="/data/amcu/packet2026_ext.json")
    args = ap.parse_args()
    found = json.loads(pathlib.Path(args.search).read_text())
    first = {p["number"]: p for p in json.loads(pathlib.Path(args.first).read_text())}
    conn = psycopg2.connect(retrieve.dsn())
    cur = conn.cursor()
    cache: dict = {}
    out = []
    for norm, v in found["norms"].items():
        if not v["outside"]:
            continue
        item = {k: first[norm][k] for k in ("number", "rozdil", "rozdil_title", "text", "origin", "from_2002", "text_2002")}
        q = np.asarray(retrieve.embed([item["text"]], cache=cache)[0], dtype="float32")
        q /= np.linalg.norm(q)
        item["passages"] = []
        for doc in v["outside"]:
            cur.execute("SELECT f.full_text, d.cause_num, d.adjudication_date FROM edrsr_fulltext f "
                        "LEFT JOIN edrsr_documents d ON d.doc_id = f.doc_id WHERE f.doc_id = %s", (doc,))
            text, ref, date = cur.fetchone()
            chunks = retrieve.passages_of(text)
            hit = []
            for i, ch in enumerate(chunks):
                cur.execute("SELECT bool_or(to_tsvector('simple', %s) @@ to_tsquery('simple', q)) "
                            "FROM unnest(%s::text[]) q", (ch, fullsearch2026.TERMS[norm]))
                if cur.fetchone()[0]:
                    hit.append(i)
            pool = hit or list(range(len(chunks)))
            vec = np.asarray(retrieve.embed([chunks[i] for i in pool], cache=cache), dtype="float32")
            vec /= np.linalg.norm(vec, axis=1, keepdims=True)
            best = pool[int(np.argmax(vec @ q))]
            item["passages"].append({"doc_id": f"court:{doc}", "ord": best, "corpus": "court", "doc_ref": ref,
                                     "date": str(date or ""), "term_in_passage": bool(hit), "body": chunks[best]})
        out.append(item)
        print(f"  {norm:<8} {len(item['passages'])} judgments, "
              f"{sum(p['term_in_passage'] for p in item['passages'])} with the term in the passage read", flush=True)
    pathlib.Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} norms, {sum(len(p['passages']) for p in out)} passages -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
