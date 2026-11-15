#!/usr/bin/env python3
"""Embed the articles split out of PDF-only editions into pl_corpus_bge_cls.

The bulk vector run (10-14.11.2026) embedded these editions as whole texts
(doc_type pl_act_text), because segment_eli_pdf.py did not exist yet. This
script gives them the same per-article points the HTML editions have, and
then drops the edition's whole-text points so search does not return the
same edition twice.

Two steps, because the database is reached through `docker exec psql` on the
host while TEI and Qdrant are only on the `lawrider` docker network:

  # 1. on the host: articles of every split edition -> NDJSON (seconds)
  python3 scripts/pl/vectorize_pdf_articles.py export --out ~/lawrider/pl-vectors/pdf-articles.ndjson

  # 2. in a container on the network: embed, upsert, drop the whole-text points
  docker run --rm -d --name pl-pdf-vec --network lawrider \
    -v ~/lawrider/pl-vectors:/work -v ~/SecondLayer-pl/scripts/pl:/code:ro \
    -v ~/lawrider/pl-vectors/pydeps:/deps:ro -e PYTHONPATH=/deps \
    -e TEI_URL=http://tei-pl-batch:80 python:3.12-slim \
    python /code/vectorize_pdf_articles.py load --src /work/pdf-articles.ndjson

Chunking, point ids, and payload are those of pl_chunk_export.py (articles:
key pla_<snapshot>_<ord>, chunks of at most 1536 chars with a 200-char
overlap, "<title>, <Art. N.>" heading line). TEI must serve BAAI/bge-m3 with
CLS pooling, as the query side does: checked 15.11 against GCP vectors,
cosine 1.0.

`load` is resumable: an edition is written to <src>.done only after its
points are upserted and its whole-text points deleted.
"""
import argparse
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

MAX = 1536
OVERLAP = 200
MIN_TAIL = 100
COLLECTION = os.environ.get("COLLECTION", "pl_corpus_bge_cls")
QDRANT = os.environ.get("QDRANT_URL", "http://qdrant-lawrider:6333")
TEI = os.environ.get("TEI_URL", "http://tei-bge-m3-lawrider:80")
TEI_BATCH = int(os.environ.get("TEI_BATCH", "8"))
TEI_PARALLEL = int(os.environ.get("TEI_PARALLEL", "3"))

ARTICLES = """
WITH cur AS (SELECT DISTINCT ON (act_eli) act_eli, snapshot_eli FROM pl_act_snapshots ORDER BY act_eli, seq DESC)
SELECT a.act_eli, a.snapshot_eli, a.ord, a.art_display, a.art_no, a.text, act.title, act.act_type,
       (cur.snapshot_eli IS NOT NULL)
FROM pl_act_articles a
JOIN pl_snapshot_texts t ON t.snapshot_eli = a.snapshot_eli AND t.http_status = 906 AND t.pdf_split = 200
LEFT JOIN pl_acts act ON act.eli = a.act_eli
LEFT JOIN cur ON cur.act_eli = a.act_eli AND cur.snapshot_eli = a.snapshot_eli
WHERE length(a.text) >= 20
ORDER BY a.snapshot_eli, a.ord
"""


def chunk_text(text, max_chars=MAX):
    """Same splitter as pl_chunk_export.py, so ids and boundaries match a full re-export."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text]
    out, start, n = [], 0, len(text)
    while start < n:
        end = min(start + max_chars, n)
        if n - end < MIN_TAIL:
            end = n
        elif end < n:
            sp = text.rfind(" ", start + max_chars // 2, end)
            if sp > 0:
                end = sp
        out.append(text[start:end])
        if end >= n:
            break
        nxt = end - OVERLAP
        sp = text.find(" ", nxt, end)
        start = sp + 1 if sp > 0 else nxt
    return out


def vec_id(key):
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def points_for(act_eli, snap, ord_, disp, art_no, text, title, act_type, is_cur):
    head = f"{title or act_eli}, {disp or ('art. ' + str(art_no))}\n"
    pieces = chunk_text(head + text)
    for ci, piece in enumerate(pieces):
        yield {"id": vec_id(f"pla_{snap}_{ord_}_c{ci}"), "text": piece, "doc_type": "pl_article",
               "chunk_index": ci, "n_chunks": len(pieces), "act_eli": act_eli, "snapshot_eli": snap,
               "art_no": art_no, "art_display": disp, "title": title, "act_type": act_type,
               "is_current": is_cur, "source": "eli-pdf-split"}


def export(out):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import plprod
    n = 0
    with open(out + ".tmp", "w", encoding="utf-8") as f:
        for act, snap, ord_, disp, art_no, text, title, act_type, is_cur in plprod.rows_of(ARTICLES):
            for p in points_for(act, snap, int(ord_), disp, art_no, text, title, act_type, is_cur == "t"):
                f.write(json.dumps(p, ensure_ascii=False) + "\n")
                n += 1
    os.replace(out + ".tmp", out)
    print(f"{n} chunks -> {out}", flush=True)


def load(src):
    import requests

    def embed(batch):
        for attempt in range(6):
            try:
                r = requests.post(f"{TEI}/embed", json={"inputs": batch, "truncate": True}, timeout=900)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001 - TEI restarts, queue full
                print(f"  embed retry {attempt + 1}: {str(e)[:160]}", flush=True)
                time.sleep(5 * (attempt + 1))
        raise SystemExit("TEI keeps failing")

    def qdrant(method, path, body):
        for attempt in range(6):
            try:
                r = requests.request(method, f"{QDRANT}/collections/{COLLECTION}{path}", json=body, timeout=300)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001
                print(f"  qdrant retry {attempt + 1}: {str(e)[:160]}", flush=True)
                time.sleep(3 * (attempt + 1))
        raise SystemExit(f"qdrant {path} keeps failing")

    by_snap = {}
    with open(src, encoding="utf-8") as f:
        for line in f:
            p = json.loads(line)
            by_snap.setdefault(p["snapshot_eli"], []).append(p)
    state = src + ".done"
    done = set(open(state).read().split()) if os.path.exists(state) else set()
    todo = [s for s in by_snap if s not in done]
    total = sum(len(by_snap[s]) for s in todo)
    print(f"{len(by_snap)} editions, {len(done)} done, {total} chunks to embed", flush=True)

    t0, n = time.time(), 0
    with ThreadPoolExecutor(TEI_PARALLEL) as pool:
        for snap in todo:
            pts = by_snap[snap]
            batches = [pts[i:i + TEI_BATCH] for i in range(0, len(pts), TEI_BATCH)]
            vecs = [v for vs in pool.map(lambda b: embed([p["text"] for p in b]), batches) for v in vs]
            for i in range(0, len(pts), 256):
                qdrant("PUT", "/points?wait=true", {"points": [
                    {"id": p["id"], "vector": v, "payload": {k: x for k, x in p.items() if k != "id"}}
                    for p, v in zip(pts[i:i + 256], vecs[i:i + 256])]})
            qdrant("POST", "/points/delete?wait=true", {"filter": {"must": [
                {"key": "doc_type", "match": {"value": "pl_act_text"}},
                {"key": "snapshot_eli", "match": {"value": snap}}]}})
            with open(state, "a") as f:
                f.write(snap + "\n")
            n += len(pts)
            rate = n / (time.time() - t0)
            print(f"[{time.strftime('%H:%M:%S')}] {snap}: {len(pts)} chunks | {n}/{total} "
                  f"{rate:.1f}/s, eta {(total - n) / rate / 3600:.1f} h", flush=True)
    print("done", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--out", required=True)
    lo = sub.add_parser("load")
    lo.add_argument("--src", required=True)
    a = ap.parse_args()
    export(a.out) if a.cmd == "export" else load(a.src)


if __name__ == "__main__":
    main()
