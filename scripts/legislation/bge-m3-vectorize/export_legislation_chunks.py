#!/usr/bin/env python3
"""
STEP 1 (run on prod, READ-ONLY DB): export legislation article chunks (current +
historical editions, text-deduped) to balanced JSONL shards for GPU embedding on Brev.

Each JSONL line: {"id": <uuid>, "text": <chunk text>, "payload": {...}}
- text-dedup: consecutive byte-identical editions collapse into one version.
- chunk 500/100 (parity with rada-legislation-adapter::createArticleChunks).
- deterministic versioned id: md5("leg_{rada}_art_{num}_v_{valid_from}_chunk_{idx}").
- payload = final Qdrant payload (rada_id, article_id, article_number, section/chapter,
  article_title, chunk_index, text, context_before/after, document_type, is_current,
  valid_from, valid_to, valid_from_ts, valid_to_ts).

No embedding, no Qdrant here — pure export. Output: <out>/shard_{i}.jsonl (round-robin
by chunk for balance across GPUs).

  DATABASE_URL=postgresql://...@127.0.0.1:5438/secondlayer_prod \
  python export_legislation_chunks.py --all --shards 8 --out /home/ubuntu/leg-export
"""
import argparse, hashlib, json, os, sys, time, datetime as _dt
import psycopg2, psycopg2.extras

CHUNK_SIZE, CHUNK_OVERLAP = 500, 100
TS_SENTINEL = 99991231
_EPOCH0 = _dt.datetime(1900, 1, 1)
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


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)
def det_uuid(s):
    h = hashlib.md5(s.encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
def ts_of(d): return int(d.strftime("%Y%m%d")) if d else 0


def make_chunks(text, an, sn, cn, title):
    text = text or ""
    if len(text) <= CHUNK_SIZE:
        return [{"chunk_index": 0, "text": text, "context_before": None, "context_after": None}]
    out, start, ci = [], 0, 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        out.append({"chunk_index": ci, "text": text[start:end],
                    "context_before": text[max(0, start - CHUNK_OVERLAP):start] if start > 0 else None,
                    "context_after": text[end:min(len(text), end + CHUNK_OVERLAP)] if end < len(text) else None})
        start += CHUNK_SIZE - CHUNK_OVERLAP; ci += 1
    return out


def text_versions(rows):
    from itertools import groupby
    rows = sorted(rows, key=lambda r: (str(r["article_number"]), r["version_date"] or _EPOCH0))
    for _, grp in groupby(rows, key=lambda r: str(r["article_number"])):
        grp = list(grp)
        runs, cur, cmd5 = [], [], None
        for r in grp:
            m = hashlib.md5((r["full_text"] or "").encode()).hexdigest()
            if m != cmd5 and cur:
                runs.append(cur); cur = []
            cur.append(r); cmd5 = m
        if cur: runs.append(cur)
        for i, run in enumerate(runs):
            rep = next((r for r in run if r["is_current"]), run[0])
            yield {"article_id": rep["id"], "article_number": rep["article_number"],
                   "section_number": rep["section_number"], "chapter_number": rep["chapter_number"],
                   "title": rep["title"], "full_text": rep["full_text"],
                   "valid_from": run[0]["version_date"],
                   "valid_to": runs[i + 1][0]["version_date"] if i + 1 < len(runs) else None,
                   "is_current": any(r["is_current"] for r in run)}


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true"); g.add_argument("--rada-id"); g.add_argument("--pilot", action="store_true")
    ap.add_argument("--shards", type=int, default=8)
    ap.add_argument("--out", default="/home/ubuntu/leg-export")
    ap.add_argument("--current-only", action="store_true")
    ap.add_argument("--exclude", default=",".join(DEFAULT_EXCLUDE))
    a = ap.parse_args()
    exclude = {x.strip() for x in a.exclude.split(",") if x.strip()}
    os.makedirs(a.out, exist_ok=True)

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    if a.rada_id:
        cur.execute("SELECT id, rada_id FROM legislation WHERE lower(rada_id)=lower(%s)", (a.rada_id,))
    elif a.pilot:
        cur.execute("SELECT id, rada_id FROM legislation WHERE rada_id=%s", ("254к/96-вр",))
    else:
        cur.execute("""SELECT l.id, l.rada_id FROM legislation l WHERE EXISTS
                       (SELECT 1 FROM legislation_articles la WHERE la.legislation_id=l.id AND length(la.full_text)>0)
                       ORDER BY l.id""")
    acts = [r for r in cur.fetchall() if r["rada_id"] not in exclude]

    files = [open(os.path.join(a.out, f"shard_{i}.jsonl"), "w") for i in range(a.shards)]
    n = 0
    for act in acts:
        lid, rada = act["id"], act["rada_id"]
        cur.execute("""SELECT id, article_number, section_number, chapter_number, title,
                              full_text, version_date, is_current
                       FROM legislation_articles WHERE legislation_id=%s AND length(full_text)>0""", (lid,))
        rows = cur.fetchall()
        for v in text_versions(rows):
            if a.current_only and not v["is_current"]:
                continue
            for ch in make_chunks(v["full_text"], v["article_number"], v["section_number"],
                                  v["chapter_number"], v["title"]):
                vid = det_uuid(f"leg_{rada}_art_{v['article_number']}_v_{v['valid_from']}_chunk_{ch['chunk_index']}")
                rec = {"id": vid, "text": ch["text"], "payload": {
                    "rada_id": rada, "article_id": v["article_id"], "article_number": v["article_number"],
                    "section_number": v["section_number"], "chapter_number": v["chapter_number"],
                    "article_title": v["title"], "chunk_index": ch["chunk_index"], "text": ch["text"],
                    "context_before": ch["context_before"], "context_after": ch["context_after"],
                    "document_type": "legislation", "is_current": v["is_current"],
                    "valid_from": v["valid_from"].isoformat() if v["valid_from"] else None,
                    "valid_to": v["valid_to"].isoformat() if v["valid_to"] else None,
                    "valid_from_ts": ts_of(v["valid_from"]),
                    "valid_to_ts": ts_of(v["valid_to"]) if v["valid_to"] else TS_SENTINEL,
                }}
                files[n % a.shards].write(json.dumps(rec, ensure_ascii=False) + "\n")
                n += 1
    for f in files: f.close()
    log(f"exported {n} chunks across {a.shards} shards from {len(acts)} acts -> {a.out}")


if __name__ == "__main__":
    main()
