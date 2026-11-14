#!/usr/bin/env python3
"""Load the embedded PL corpus into qdrant-lawrider (pl_corpus_bge_cls).

Port of the CH loader (upsert_ch_vectors.py) that reads local files instead
of GCS: the chunk shards were exported on cthulhu and the vectors were
downloaded there, so the load needs no cloud credentials and can run in a
throwaway container on the `lawrider` docker network:

  docker run --rm -d --name pl-upsert --network lawrider \
    -v ~/lawrider/pl-vectors:/work -v ~/lawrider/repo/scripts/pl:/code:ro \
    python:3.12-slim sh -c 'pip install -q qdrant-client numpy requests &&
      python /code/upsert_pl_vectors.py --chunks /work/chunks --vectors /work/vectors'

Vectors are one fp16 .npy per shard in the same row order as the shard's
NDJSON. Ids are the exporter's deterministic uuids, so the load is
re-runnable; finished shards are recorded in <vectors>/.upserted.

The collection already exists (created 10.11.2026 with the CH profile and
the PL payload indexes). Indexing is switched off for the bulk load and
restored at the end, as for CH.
"""
import argparse
import gzip
import json
import os
import time

import numpy as np
import requests
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

QDRANT = os.environ.get("QDRANT_URL", "http://qdrant:6333")
QDRANT_HOST = QDRANT.split("//")[-1].split(":")[0]
BATCH = 1000
SUFFIX = ".ndjson.gz"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def set_threshold(name, value):
    r = requests.patch(f"{QDRANT}/collections/{name}",
                       json={"optimizers_config": {"indexing_threshold": value}},
                       timeout=60)
    r.raise_for_status()
    log(f"indexing_threshold={value}")


def upsert_shard(client, name, jsonl_path, vec_path):
    ids, payloads = [], []
    with gzip.open(jsonl_path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            ids.append(rec.pop("id"))
            payloads.append(rec)  # text stays in the payload for rendering

    vecs = np.load(vec_path)
    if len(vecs) != len(ids):
        raise SystemExit(f"{jsonl_path}: {len(ids)} rows but {len(vecs)} vectors")

    for i in range(0, len(ids), BATCH):
        hi = min(i + BATCH, len(ids))
        batch = qm.Batch(ids=ids[i:hi],
                         vectors=vecs[i:hi].astype(np.float32).tolist(),
                         payloads=payloads[i:hi])
        for attempt in range(5):
            try:
                client.upsert(collection_name=name, points=batch, wait=False)
                break
            except Exception as e:  # noqa: BLE001 - retry any transport error
                log(f"  retry {attempt + 1}: {str(e)[:120]}")
                time.sleep(2 * (attempt + 1))
        else:
            raise SystemExit(f"upsert failed at {jsonl_path} offset {i}")
    return len(ids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collection", default="pl_corpus_bge_cls")
    ap.add_argument("--chunks", required=True)
    ap.add_argument("--vectors", required=True)
    ap.add_argument("--limit", type=int, default=0, help="stop after N shards (test)")
    a = ap.parse_args()

    if not os.path.exists(os.path.join(a.vectors, "_COMPLETE")):
        raise SystemExit("vectors/_COMPLETE missing: download not finished")

    state = os.path.join(a.vectors, ".upserted")
    done = set(open(state).read().split()) if os.path.exists(state) else set()
    shards = sorted(f[: -len(SUFFIX)] for f in os.listdir(a.chunks) if f.endswith(SUFFIX))
    log(f"{len(shards)} shards, {len(done)} already loaded")

    set_threshold(a.collection, 0)
    client = QdrantClient(host=QDRANT_HOST, port=6333, grpc_port=6334,
                          prefer_grpc=True, https=False, timeout=300)
    total, n_shards, t0 = 0, 0, time.time()
    for base in shards:
        if base in done:
            continue
        n = upsert_shard(client, a.collection,
                         os.path.join(a.chunks, base + SUFFIX),
                         os.path.join(a.vectors, base + ".f16.npy"))
        total += n
        n_shards += 1
        with open(state, "a") as f:
            f.write(base + "\n")
        log(f"{base}: {n} points ({total:,} total, {total / (time.time() - t0):.0f}/s)")
        if a.limit and n_shards >= a.limit:
            log("limit reached, indexing left off")
            return

    set_threshold(a.collection, 20000)
    r = requests.get(f"{QDRANT}/collections/{a.collection}", timeout=60)
    log(f"done: {total:,} points this run; collection says "
        f"{r.json()['result'].get('points_count')}")


if __name__ == "__main__":
    main()
