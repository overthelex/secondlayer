#!/usr/bin/env python3
"""Stage 3: load the embedded АМКУ decisions into Qdrant as `amcu_bge_cls`.

Same shape as `scripts/legislation/sagemaker/upsert_legislation_vectors.py`: vectors come back
one fp16 .npy per shard in that shard's JSONL row order (the entry script sorts by length for
batching but writes each row back to its original index), and ids are the deterministic md5 uuids
from the chunker — so a repeat overwrites the same points instead of duplicating them.

Run it FROM PROD, not from the Qdrant box: the Qdrant instance's role cannot read
`secondlayer-ml-data-euc1`.

  QDRANT_URL=http://172.31.21.244:6333 QDRANT_API_KEY=… python3 03_upsert_amcu_vectors.py
  python3 03_upsert_amcu_vectors.py --create-only
"""
import argparse
import gzip
import json
import os
import time

import boto3
import numpy as np
import requests
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

QDRANT = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
QDRANT_HOST = QDRANT.split("//")[-1].split(":")[0]
API_KEY = os.environ.get("QDRANT_API_KEY") or None
BUCKET = "secondlayer-ml-data-euc1"
CHUNKS_PREFIX = "rada-npa/amcu-decisions/chunks"
VECTORS_PREFIX = "rada-npa/amcu-decisions/vectors"
BATCH = 1000

INDEXES = [
    ("amcu_id", "integer"),
    ("doc_kind", "keyword"),
    ("decision_no", "keyword"),
    ("decision_date_ts", "integer"),
    ("document_type", "keyword"),
]


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def headers():
    return {"api-key": API_KEY} if API_KEY else {}


def create_collection(name):
    r = requests.get(f"{QDRANT}/collections/{name}", headers=headers(), timeout=30)
    if r.status_code == 200:
        log(f"collection {name} exists")
        return
    # ~165K points is small enough to keep vectors in RAM — unlike the 28M-point legislation
    # collection, which needs on_disk + binary quantization to fit.
    body = {
        "vectors": {"size": 1024, "distance": "Cosine"},
        "optimizers_config": {"indexing_threshold": 0},
    }
    r = requests.put(f"{QDRANT}/collections/{name}", json=body, headers=headers(), timeout=60)
    r.raise_for_status()
    log(f"created {name}")
    for field, schema in INDEXES:
        rr = requests.put(f"{QDRANT}/collections/{name}/index",
                          json={"field_name": field, "field_schema": schema},
                          headers=headers(), timeout=60)
        log(f"  index {field}: {rr.status_code}")


def finalise(name):
    r = requests.patch(f"{QDRANT}/collections/{name}",
                       json={"optimizers_config": {"indexing_threshold": 20000}},
                       headers=headers(), timeout=60)
    log(f"indexing_threshold restored: {r.status_code}")


def upsert_shard(client, name, jsonl_path, vec_path):
    ids, payloads = [], []
    with gzip.open(jsonl_path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            ids.append(rec["id"])
            payload = rec["payload"]
            payload["text"] = rec["text"]  # so a hit renders without a second lookup
            payloads.append(payload)

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
            except Exception as e:
                log(f"  retry {attempt + 1}: {str(e)[:120]}")
                time.sleep(2 * (attempt + 1))
        else:
            raise SystemExit(f"upsert failed at {jsonl_path} offset {i}")
    return len(ids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collection", default="amcu_bge_cls")
    ap.add_argument("--workdir", default="/data/amcu/upsert")
    ap.add_argument("--create-only", action="store_true")
    a = ap.parse_args()

    create_collection(a.collection)
    if a.create_only:
        return

    os.makedirs(a.workdir, exist_ok=True)
    state = os.path.join(a.workdir, ".upserted")
    done = set(open(state).read().split()) if os.path.exists(state) else set()

    s3 = boto3.client("s3", region_name="eu-central-1")
    shards = sorted(o["Key"].split("/")[-1][: -len(".jsonl.gz")]
                    for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=CHUNKS_PREFIX + "/")
                    .get("Contents", []) if o["Key"].endswith(".jsonl.gz"))
    log(f"{len(shards)} shards, {len(done)} already loaded")

    # https=False is load-bearing: qdrant-client turns TLS on the moment an api_key is passed,
    # then fails the gRPC handshake against a plaintext port with a WRONG_VERSION_NUMBER error
    # that reads like a certificate problem rather than a scheme mismatch.
    client = QdrantClient(host=QDRANT_HOST, port=6333, grpc_port=6334, prefer_grpc=True,
                          api_key=API_KEY, https=False, timeout=300)
    total, t0 = 0, time.time()
    for base in shards:
        if base in done:
            continue
        jp = os.path.join(a.workdir, base + ".jsonl.gz")
        vp = os.path.join(a.workdir, base + ".f16.npy")
        s3.download_file(BUCKET, f"{CHUNKS_PREFIX}/{base}.jsonl.gz", jp)
        s3.download_file(BUCKET, f"{VECTORS_PREFIX}/{base}.f16.npy", vp)
        n = upsert_shard(client, a.collection, jp, vp)
        os.remove(jp)
        os.remove(vp)
        total += n
        with open(state, "a") as f:
            f.write(base + "\n")
        log(f"{base}: {n} points ({total:,} total, {total / (time.time() - t0):.0f}/s)")

    finalise(a.collection)
    r = requests.get(f"{QDRANT}/collections/{a.collection}", headers=headers(), timeout=60)
    log(f"done: {total:,} points this run; collection says "
        f"{r.json()['result'].get('points_count')}")


if __name__ == "__main__":
    main()
