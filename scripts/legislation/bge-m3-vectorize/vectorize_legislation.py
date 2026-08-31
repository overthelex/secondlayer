#!/usr/bin/env python3
"""
Vectorize Ukrainian legislation into Qdrant using bge-m3 (TEI), on the SAME model
as EDRSR (BAAI/bge-m3, 1024-dim). Covers CURRENT + HISTORICAL editions ("по роках")
via text-dedup: each distinct text-version of an article is embedded ONCE and tagged
with its validity window (valid_from / valid_to) + is_current.

Part of LEXAI-1807 (full migration legal_sections VoyageAI -> bge-m3 + historical).

WHY dedup: an article has up to ~300 edition rows but most are byte-identical across
dates. Distinct-by-text versions across the whole corpus ≈ 75K (vs 1.3M raw editions).
Full historical *restoration* never uses vectors — it is an exact DB lookup on
legislation_articles (version_date <= as_of). Vectors are only for SEMANTIC search;
valid_from/valid_to let the query optionally scope semantic search to a point in time.

Pipeline parity with the in-app indexer (rada-legislation-adapter::createArticleChunks):
  - chunking: CHUNK_SIZE=500, CHUNK_OVERLAP=100 (stride 400), 100-char context_before/after
  - payload:  {rada_id, article_id, article_number, section_number, chapter_number,
               article_title, chunk_index, text, context_before, context_after,
               document_type:'legislation', valid_from, valid_to, valid_from_ts,
               valid_to_ts, is_current}
  - vector_id: md5("leg_{rada}_art_{num}_v_{valid_from}_chunk_{idx}") -> UUID (deterministic)
  - embedding: POST {BGE_M3_URL}/v1/embeddings {"input":[...],"model":"BAAI/bge-m3"}
  - PG mirror legislation_chunks: only for the is_current version (historical -> Qdrant only,
    to keep the table lean; dedup/resume relies on deterministic Qdrant ids anyway)

Safe cutover: default target collection is legal_sections_bge (live Voyage legal_sections
untouched until the backend query path is switched — separate PR).

Run inside deployment_secondlayer-prod-network (tei-bge-m3 / qdrant internal). Env:
  DATABASE_URL, BGE_M3_URL, QDRANT_URL, QDRANT_API_KEY

Examples:
  python vectorize_legislation.py --pilot --recreate-collection        # Constitution, all editions
  python vectorize_legislation.py --all --skip-existing                 # whole corpus, resumable
  python vectorize_legislation.py --all --current-only                  # only is_current (fast subset)
  python vectorize_legislation.py --all --shard-index 0 --shard-count 4 # parallel worker 0/4
  python vectorize_legislation.py --rada-id 254к/96-вр --dry-run
"""
import argparse
import hashlib
import os
import sys
import time

import psycopg2
import psycopg2.extras
import requests
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

CHUNK_SIZE = 500
CHUNK_OVERLAP = 100
EMBED_DIM = 1024
BGE_MODEL = "BAAI/bge-m3"
EMBED_BATCH = 64
DEFAULT_COLLECTION = "legal_sections_bge"
TS_SENTINEL = 99991231  # valid_to for the current/open version

# Formerly DEFAULT_EXCLUDE = {"254к/96-ВР", "4651-vi", "5073-VI", "4173-IX"}.
#
# Those were not act ids at all — they are OFFICIAL numbers that had been stored
# in legislation.rada_id, creating a second row for the Constitution, the КПК
# and two more acts. The exclusion existed to stop the same act being vectorised
# twice under both spellings.
#
# Migration 188 merged those duplicates away, so the strings match nothing and
# the workaround is dead. Verified on prod: 0 rows remain under any of the four,
# and legislation now holds 651 rows with 651 distinct lower(rada_id), enforced
# by a unique index plus a CHECK that refuses upper case and Roman suffixes.
DEFAULT_EXCLUDE: set[str] = set()


def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def det_uuid(s: str) -> str:
    h = hashlib.md5(s.encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def ts_of(d) -> int:
    return int(d.strftime("%Y%m%d")) if d else 0


def make_chunks(full_text, article_number, section_number, chapter_number, title):
    """Exact port of createArticleChunks (500/100)."""
    chunks, text = [], full_text or ""
    if len(text) <= CHUNK_SIZE:
        return [{"chunk_index": 0, "text": text, "context_before": None, "context_after": None,
                 "metadata": {"article_number": article_number, "section_number": section_number,
                              "chapter_number": chapter_number, "title": title}}]
    start, ci = 0, 0
    denom = -(-len(text) // CHUNK_SIZE)
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append({
            "chunk_index": ci, "text": text[start:end],
            "context_before": text[max(0, start - CHUNK_OVERLAP):start] if start > 0 else None,
            "context_after": text[end:min(len(text), end + CHUNK_OVERLAP)] if end < len(text) else None,
            "metadata": {"article_number": article_number, "section_number": section_number,
                         "chapter_number": chapter_number, "title": title,
                         "chunk_position": f"{ci + 1}/{denom}"},
        })
        start += CHUNK_SIZE - CHUNK_OVERLAP
        ci += 1
    return chunks


def build_text_versions(rows, current_only: bool):
    """Given all edition rows for one act (ordered by article_number, version_date),
    collapse consecutive byte-identical texts into versions with valid_from/valid_to.
    Returns list of version dicts."""
    from itertools import groupby
    versions = []
    rows = sorted(rows, key=lambda r: (str(r["article_number"]), r["version_date"] or _EPOCH0))
    for _, grp in groupby(rows, key=lambda r: str(r["article_number"])):
        grp = list(grp)
        # collapse consecutive identical text
        runs = []  # (rows_in_run)
        cur_run, cur_md5 = [], None
        for r in grp:
            m = hashlib.md5((r["full_text"] or "").encode("utf-8")).hexdigest()
            if m != cur_md5 and cur_run:
                runs.append(cur_run); cur_run = []
            cur_run.append(r); cur_md5 = m
        if cur_run:
            runs.append(cur_run)
        for i, run in enumerate(runs):
            rep = next((r for r in run if r["is_current"]), run[0])
            is_cur = any(r["is_current"] for r in run)
            valid_from = run[0]["version_date"]
            valid_to = runs[i + 1][0]["version_date"] if i + 1 < len(runs) else None
            if current_only and not is_cur:
                continue
            versions.append({
                "article_id": rep["id"], "article_number": rep["article_number"],
                "section_number": rep["section_number"], "chapter_number": rep["chapter_number"],
                "title": rep["title"], "full_text": rep["full_text"],
                "valid_from": valid_from, "valid_to": valid_to, "is_current": is_cur,
            })
    return versions


import datetime as _dt
_EPOCH0 = _dt.datetime(1900, 1, 1)


def embed_batch(bge_url, texts, retries=5):
    url = bge_url.rstrip("/") + "/v1/embeddings"
    delay = 2.0
    for attempt in range(retries):
        try:
            r = requests.post(url, json={"input": texts, "model": BGE_MODEL}, timeout=180)
            if r.status_code in (429, 503):
                raise requests.HTTPError(str(r.status_code))
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            vecs = [d["embedding"] for d in data]
            for v in vecs:
                if len(v) != EMBED_DIM:
                    raise ValueError(f"dim {len(v)}")
            return vecs
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            log(f"  embed retry {attempt+1}/{retries} ({e}); sleep {delay}s")
            time.sleep(delay); delay *= 2


def ensure_collection(qc, name, recreate):
    if qc.collection_exists(name) and not recreate:
        return
    if qc.collection_exists(name):
        log(f"recreating collection {name}"); qc.delete_collection(name)
    qc.create_collection(name, vectors_config=qm.VectorParams(size=EMBED_DIM, distance=qm.Distance.COSINE),
                         on_disk_payload=True)
    for field, sch in [("document_type", qm.PayloadSchemaType.KEYWORD),
                       ("rada_id", qm.PayloadSchemaType.KEYWORD),
                       ("article_number", qm.PayloadSchemaType.KEYWORD),
                       ("is_current", qm.PayloadSchemaType.BOOL),
                       ("valid_from_ts", qm.PayloadSchemaType.INTEGER),
                       ("valid_to_ts", qm.PayloadSchemaType.INTEGER)]:
        try:
            qc.create_payload_index(name, field_name=field, field_schema=sch)
        except Exception:  # noqa: BLE001
            pass


def select_acts(cur, args):
    if args.rada_id:
        cur.execute("SELECT id, rada_id FROM legislation WHERE lower(rada_id)=lower(%s)", (args.rada_id,))
        return cur.fetchall()
    if args.pilot:
        cur.execute("SELECT id, rada_id FROM legislation WHERE rada_id=%s", ("254к/96-вр",))
        return cur.fetchall()
    cur.execute("""SELECT l.id, l.rada_id FROM legislation l
                   WHERE EXISTS (SELECT 1 FROM legislation_articles la
                                 WHERE la.legislation_id=l.id AND length(la.full_text)>0)
                   ORDER BY l.id""")
    return cur.fetchall()


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--rada-id"); g.add_argument("--all", action="store_true"); g.add_argument("--pilot", action="store_true")
    ap.add_argument("--collection", default=os.environ.get("LEG_BGE_COLLECTION", DEFAULT_COLLECTION))
    ap.add_argument("--recreate-collection", action="store_true")
    ap.add_argument("--current-only", action="store_true", help="only is_current versions (no history)")
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--shard-index", type=int, default=0)
    ap.add_argument("--shard-count", type=int, default=1)
    ap.add_argument("--exclude", default=",".join(DEFAULT_EXCLUDE))
    args = ap.parse_args()

    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    dburl = os.environ.get("DATABASE_URL") or sys.exit("DATABASE_URL required")
    bge_url = os.environ.get("BGE_M3_URL", "http://tei-bge-m3:80")
    qurl = os.environ.get("QDRANT_URL", "http://localhost:6333")
    qkey = os.environ.get("QDRANT_API_KEY")

    conn = psycopg2.connect(dburl); conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    qc = None
    if not args.dry_run:
        qc = QdrantClient(url=qurl, api_key=qkey, timeout=60)
        ensure_collection(qc, args.collection, args.recreate_collection)

    acts = [a for a in select_acts(cur, args) if a["rada_id"] not in exclude]
    if args.shard_count > 1:
        acts = [a for i, a in enumerate(acts) if i % args.shard_count == args.shard_index]
    log(f"acts={len(acts)} collection={args.collection} current_only={args.current_only} "
        f"shard={args.shard_index}/{args.shard_count} dry_run={args.dry_run}")

    grand = 0
    for ai, act in enumerate(acts, 1):
        lid, rada_id = act["id"], act["rada_id"]
        cur.execute("""SELECT id, article_number, section_number, chapter_number, title,
                              full_text, version_date, is_current
                       FROM legislation_articles
                       WHERE legislation_id=%s AND length(full_text)>0""", (lid,))
        versions = build_text_versions(cur.fetchall(), args.current_only)

        pending = []  # (version, chunk)
        for v in versions:
            for ch in make_chunks(v["full_text"], v["article_number"], v["section_number"],
                                  v["chapter_number"], v["title"]):
                pending.append((v, ch))

        if args.dry_run:
            log(f"[{ai}/{len(acts)}] {rada_id}: {len(versions)} text-versions -> {len(pending)} chunks")
            grand += len(pending); continue

        if args.skip_existing and pending:
            ids = [det_uuid(f"leg_{rada_id}_art_{v['article_number']}_v_{v['valid_from']}_chunk_{c['chunk_index']}")
                   for v, c in pending]
            present = set()
            for i in range(0, len(ids), 256):
                present.update(p.id for p in qc.retrieve(args.collection, ids=ids[i:i+256],
                                                         with_payload=False, with_vectors=False))
            pending = [(v, c) for (v, c), vid in zip(pending, ids) if vid not in present]

        act_chunks = 0
        for i in range(0, len(pending), EMBED_BATCH):
            batch = pending[i:i + EMBED_BATCH]
            vecs = embed_batch(bge_url, [c["text"] for _, c in batch])
            points, pg_rows = [], []
            for (v, ch), vec in zip(batch, vecs):
                vid = det_uuid(f"leg_{rada_id}_art_{v['article_number']}_v_{v['valid_from']}_chunk_{ch['chunk_index']}")
                points.append(qm.PointStruct(id=vid, vector=vec, payload={
                    "rada_id": rada_id, "article_id": v["article_id"], "article_number": v["article_number"],
                    "section_number": v["section_number"], "chapter_number": v["chapter_number"],
                    "article_title": v["title"], "chunk_index": ch["chunk_index"], "text": ch["text"],
                    "context_before": ch["context_before"], "context_after": ch["context_after"],
                    "document_type": "legislation", "is_current": v["is_current"],
                    "valid_from": v["valid_from"].isoformat() if v["valid_from"] else None,
                    "valid_to": v["valid_to"].isoformat() if v["valid_to"] else None,
                    "valid_from_ts": ts_of(v["valid_from"]),
                    "valid_to_ts": ts_of(v["valid_to"]) if v["valid_to"] else TS_SENTINEL,
                }))
                if v["is_current"]:  # PG mirror only for current (historical -> Qdrant only)
                    pg_rows.append((v["article_id"], lid, ch["chunk_index"], ch["text"], vid,
                                    ch["context_before"], ch["context_after"],
                                    psycopg2.extras.Json(ch["metadata"])))
            for attempt in range(3):
                try:
                    qc.upsert(args.collection, points=points, wait=True); break
                except Exception as e:  # noqa: BLE001
                    if attempt == 2: raise
                    log(f"  qdrant retry ({e})"); time.sleep(2)
            if pg_rows:
                psycopg2.extras.execute_values(cur,
                    """INSERT INTO legislation_chunks
                       (article_id, legislation_id, chunk_index, text, vector_id,
                        context_before, context_after, metadata) VALUES %s
                       ON CONFLICT (article_id, chunk_index) DO UPDATE SET
                         text=EXCLUDED.text, vector_id=EXCLUDED.vector_id,
                         context_before=EXCLUDED.context_before, context_after=EXCLUDED.context_after,
                         metadata=EXCLUDED.metadata, updated_at=now()""", pg_rows)
                conn.commit()
            act_chunks += len(batch)
        grand += act_chunks
        log(f"[{ai}/{len(acts)}] {rada_id}: {len(versions)} versions -> {act_chunks} chunks")

    log(f"DONE. total chunks: {grand}")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
