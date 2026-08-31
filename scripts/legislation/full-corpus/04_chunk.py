#!/usr/bin/env python3
"""Stage 3 (prod): chunk fetched edition NDJSON shards → JSONL chunk-shards for Brev GPU embed.

Reads text NDJSON shards from Stage 2 (editions of each act co-located per shard),
collapses consecutive byte-identical editions into text-versions (valid_from/valid_to),
article-splits where «Стаття N» exists (else whole-doc), chunks 500/100, emits
{id,text,payload} balanced across output shards.

payload keys align with the embed script indexes: document_type, rada_id, article_number,
is_current, valid_from_ts, valid_to_ts (+ doc_type, status, chunk_index, valid_from/to).

  DBURL=postgresql://...@127.0.0.1:5438/rada_npa \
    python3 04_chunk.py --in /data/rada_npa/texts --out /data/rada_npa/shards --shards 8
"""
import argparse, hashlib, json, os, re, sys, time, glob
import psycopg2, psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import article_number

CHUNK_SIZE, CHUNK_OVERLAP = 500, 100
TS_SENTINEL = 99991231
DBURL = os.environ["DBURL"]
_art = re.compile(r"(?m)^\s*Стаття\s+\d+")
# Captures the WHOLE number, index included. This used to be a bare (\d+), which
# indexed «Стаття 111-14» as article 111 — under its neighbour's number, in the
# collection prod actually serves. See article_number.py.
_art_num = re.compile(r"\s*Стаття\s+(" + article_number.NUMBER + r")")


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def det_uuid(s):
    h = hashlib.md5(s.encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def ts_of(d):
    return int(d) if d and len(d) == 8 and d.isdigit() else 0


def make_chunks(text):
    text = text or ""
    if len(text) <= CHUNK_SIZE:
        return [(0, text)]
    out, start, ci = [], 0, 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        out.append((ci, text[start:end]))
        start += CHUNK_SIZE - CHUNK_OVERLAP; ci += 1
    return out


def split_articles(text):
    idxs = [m.start() for m in _art.finditer(text)]
    if len(idxs) < 3:
        return [(None, text)]
    segs = []
    if idxs[0] > 0:
        segs.append((None, text[:idxs[0]]))
    for i, s in enumerate(idxs):
        e = idxs[i + 1] if i + 1 < len(idxs) else len(text)
        seg = text[s:e]
        mnum = _art_num.match(seg)
        segs.append((article_number.normalize(mnum.group(1)) if mnum else None, seg))
    return segs


def versions_from(eds):
    """eds: list of dicts {ed_date, text_hash, text}. Collapse consecutive identical hash."""
    eds = sorted(eds, key=lambda r: r["ed_date"])
    runs, cur, cmd5 = [], [], None
    for r in eds:
        if r["text_hash"] != cmd5 and cur:
            runs.append(cur); cur = []
        cur.append(r); cmd5 = r["text_hash"]
    if cur:
        runs.append(cur)
    for i, run in enumerate(runs):
        yield {"valid_from": run[0]["ed_date"],
               "valid_to": runs[i + 1][0]["ed_date"] if i + 1 < len(runs) else None,
               "is_current": (i == len(runs) - 1),
               "text": run[0]["text"]}


def load_metamap():
    conn = psycopg2.connect(DBURL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""SELECT m.nreg, dt.name AS doc_type, ds.name AS status
                   FROM rada_docs_master m
                   LEFT JOIN rada_dict dt ON dt.kind='typ'  AND dt.id = NULLIF(split_part(m.types_raw,'|',1),'')::int
                   LEFT JOIN rada_dict ds ON ds.kind='stan' AND ds.id = m.status""")
    mm = {r["nreg"]: (r["doc_type"], r["status"]) for r in cur.fetchall()}
    conn.close()
    return mm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", default="/data/rada_npa/texts")
    ap.add_argument("--out", default="/data/rada_npa/shards")
    ap.add_argument("--shards", type=int, default=8)
    ap.add_argument("--current-only", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    metamap = load_metamap()
    log(f"metamap: {len(metamap)} acts")

    files = [open(os.path.join(a.out, f"shard_{i}.jsonl"), "w", encoding="utf-8") for i in range(a.shards)]
    n, acts = 0, 0
    shard_paths = sorted(set(glob.glob(os.path.join(a.indir, "shard_*.ndjson")) +
                             glob.glob(os.path.join(a.indir, "**", "shard_*.ndjson"), recursive=True)))
    for shard_path in shard_paths:
        by_nreg = {}
        with open(shard_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("http_status") != 200 or not d.get("text"):
                    continue
                by_nreg.setdefault(d["nreg"], []).append(
                    {"ed_date": d["ed_date"], "text_hash": d["text_hash"], "text": d["text"]})
        for nreg, eds in by_nreg.items():
            doc_type, status = metamap.get(nreg, (None, None))
            acts += 1
            for v in versions_from(eds):
                if a.current_only and not v["is_current"]:
                    continue
                for art_num, seg in split_articles(v["text"]):
                    for ci, ch in make_chunks(seg):
                        vid = det_uuid(f"legfull_{nreg}_art_{art_num}_v_{v['valid_from']}_chunk_{ci}")
                        rec = {"id": vid, "text": ch, "payload": {
                            "rada_id": nreg, "doc_type": doc_type, "status": status,
                            "article_number": art_num, "chunk_index": ci, "text": ch,
                            "document_type": "legislation", "is_current": v["is_current"],
                            "valid_from": v["valid_from"], "valid_to": v["valid_to"],
                            "valid_from_ts": ts_of(v["valid_from"]),
                            "valid_to_ts": ts_of(v["valid_to"]) if v["valid_to"] else TS_SENTINEL,
                        }}
                        files[n % a.shards].write(json.dumps(rec, ensure_ascii=False) + "\n")
                        n += 1
        log(f"  {os.path.basename(shard_path)}: {acts} acts, {n} chunks total")
    for f in files:
        f.close()
    log(f"DONE {n} chunks across {a.shards} shards from {acts} acts → {a.out}")


if __name__ == "__main__":
    main()
