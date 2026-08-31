#!/usr/bin/env python3
"""Stage 1: chunk АМКУ decisions out of Postgres into gzipped JSONL shards for SageMaker.

`opendata_amcu_decisions` already has a GIN full-text index (`idx_amcu_dec_body`), so keyword
search works today. What it has no way to answer is "practice about X" where X is phrased
differently from the decision text — hence the semantic layer.

Corpus, measured on prod 2026-08-12 (not quoted from an older note):
    6 846 rows, 2 600 with a usable body_text, 66 MB of text, mean 26 586 chars.
At 500/100 windows that is roughly 165K chunks — a single-GPU job, minutes not hours.

Chunking matches the НПА corpus exactly (500 chars, 100 overlap, deterministic md5 ids) so both
collections behave the same way and a re-run overwrites rather than duplicates.

  PGHOST=127.0.0.1 PGPORT=5438 PGUSER=secondlayer PGPASSWORD=… PGDATABASE=secondlayer_prod \
      python3 01_chunk_amcu.py --out /data/amcu/chunks
"""
import argparse
import gzip
import hashlib
import json
import os
import time

import psycopg2

CHUNK_SIZE, CHUNK_OVERLAP = 500, 100
STRIDE = CHUNK_SIZE - CHUNK_OVERLAP
# Below this a "body" is a parse artefact (a header line, an empty docx), not a decision.
MIN_BODY_CHARS = 200


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def det_uuid(s):
    h = hashlib.md5(s.encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def ts_of(d):
    """date → YYYYMMDD int, for Qdrant's integer range filter."""
    return int(d.strftime("%Y%m%d")) if d else 0


def make_chunks(text):
    if len(text) <= CHUNK_SIZE:
        return [(0, text)] if text.strip() else []
    out, start, ci = [], 0, 0
    while start < len(text):
        out.append((ci, text[start:start + CHUNK_SIZE]))
        start += STRIDE
        ci += 1
    return out


class ShardWriter:
    """Round-robin per CHUNK, never per document. АМКУ decisions run from a page to hundreds of
    pages; dealing whole documents would leave one shard several times the size of the rest."""

    def __init__(self, outdir, n):
        os.makedirs(outdir, exist_ok=True)
        self.files = [gzip.open(os.path.join(outdir, f"amcu_{j:03d}.jsonl.gz"),
                                "wt", encoding="utf-8", compresslevel=6)
                      for j in range(n)]
        self.n = n
        self.count = 0

    def write(self, rec):
        self.files[self.count % self.n].write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.count += 1

    def close(self):
        for f in self.files:
            f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/data/amcu/chunks")
    ap.add_argument("--shards", type=int, default=8)
    ap.add_argument("--limit", type=int, help="smoke test: stop after N decisions")
    a = ap.parse_args()

    conn = psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", 5438)),
        user=os.environ.get("PGUSER", "secondlayer"),
        password=os.environ.get("PGPASSWORD"),
        dbname=os.environ.get("PGDATABASE", "secondlayer_prod"),
    )
    cur = conn.cursor(name="amcu_stream")  # server-side cursor: 66 MB of text, streamed
    cur.itersize = 50
    sql = ("SELECT id, doc_kind, decision_no, decision_date, body_text "
           "FROM opendata_amcu_decisions "
           "WHERE body_text IS NOT NULL AND length(body_text) > %s ORDER BY id")
    if a.limit:
        sql += f" LIMIT {int(a.limit)}"
    cur.execute(sql, (MIN_BODY_CHARS,))

    w = ShardWriter(a.out, a.shards)
    docs = 0
    t0 = time.time()
    for did, doc_kind, decision_no, decision_date, body in cur:
        base = {
            "amcu_id": did,
            "doc_kind": doc_kind,
            "decision_no": decision_no,
            "decision_date": decision_date.isoformat() if decision_date else None,
            "decision_date_ts": ts_of(decision_date),
            "document_type": "amcu_decision",
        }
        for ci, ch in make_chunks(body):
            w.write({
                "id": det_uuid(f"amcu_{did}_chunk_{ci}"),
                "text": ch,
                "payload": dict(base, chunk_index=ci),
            })
        docs += 1
        if docs % 200 == 0:
            log(f"{docs} decisions, {w.count:,} chunks ({w.count / (time.time() - t0):.0f}/s)")

    w.close()
    cur.close()
    conn.close()
    log(f"done: {docs} decisions -> {w.count:,} chunks across {a.shards} shards in {a.out}")


if __name__ == "__main__":
    main()
