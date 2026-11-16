#!/usr/bin/env python3
"""Export the Polish corpus in pg-lawrider as BGE-M3 embedding chunks (variant 1: no BZP bodies).

Chunks are at most 1536 chars with a 200-char overlap: at Polish density (~3.7 chars/token)
2048-char chunks overflowed the 512-token window 77% of the time, 1536 does so 4.6% of the time.

Run as PARTS processes (PART=0..PARTS-1). Decisions are split between parts by hashtext(id);
part 0 also exports the small sources. Part p owns shards p, p+PARTS, p+2*PARTS, ... so no two
processes ever write the same file. Each part writes manifest.part{p}.json.

Sources: court decisions (full text), act articles (all editions; is_current = latest snapshot),
PDF act texts (snapshots with no article structure), Sejm titles, BZP subjects (order_object),
open-data rows except TERYT (street and place names, no use for semantic search).

The chunker, the point id and the per-source payload builders (*_doc below) are
shared with vectorize_incremental.py, so the daily run produces exactly the ids
and payloads of this bulk export. Change them here, for both, or not at all.

Ran 10.11.2026 on cthulhu via ~/lawrider/pl-vectors/run-pl-export.sh
(PL_DSN=postgresql://secondlayer@127.0.0.1:5448/secondlayer_prod, PGPASSWORD from
~/lawrider/pl-env.sh, ch-pipeline-venv python for psycopg 3).
"""
import hashlib
import json
import os
import sys
import time

DSN = os.environ.get("PL_DSN")
OUT_DIR = os.environ.get("OUT_DIR", "/home/vovkes/lawrider/pl-vectors/chunks")
N_SHARDS = int(os.environ.get("N_SHARDS", "256"))
PARTS = int(os.environ.get("PARTS", "4"))
PART = int(os.environ.get("PART", "0"))
SMOKE = os.environ.get("SMOKE_LIMIT")
MAX = 1536
OVERLAP = 200
MIN_TAIL = 100


def chunk_text(text, max_chars=MAX):
    text = text.strip()
    if len(text) <= max_chars:
        return [text]
    out, start, n = [], 0, len(text)
    while start < n:
        end = min(start + max_chars, n)
        if n - end < MIN_TAIL:
            end = n  # absorb a short tail instead of emitting a scrap chunk
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


def points(doc_type, key, text, payload):
    """Point records (id, text, doc_type, chunk_index, n_chunks, payload...) of one document."""
    pieces = chunk_text(text)
    return [{"id": vec_id(f"{key}_c{ci}"), "text": piece, "doc_type": doc_type,
             "chunk_index": ci, "n_chunks": len(pieces), **payload}
            for ci, piece in enumerate(pieces)]


# Each *_doc returns (doc_type, key, text, payload), or None when the bulk export skips the row.
def article_doc(act_eli, snap, ord_, disp, art_no, text, title, act_type, is_cur, source="eli"):
    head = f"{title or act_eli}, {disp or ('art. ' + str(art_no))}\n"
    return ("pl_article", f"pla_{snap}_{ord_}", head + text,
            {"act_eli": act_eli, "snapshot_eli": snap, "art_no": art_no, "art_display": disp,
             "title": title, "act_type": act_type, "is_current": bool(is_cur), "source": source})


def snapshot_doc(act_eli, snap, text, title, act_type, is_cur):
    return ("pl_act_text", f"pls_{snap}", f"{title or act_eli}\n" + text,
            {"act_eli": act_eli, "snapshot_eli": snap, "title": title, "act_type": act_type,
             "is_current": bool(is_cur), "source": "eli-pdf"})


def sejm_doc(kind, term, key, title, changed):
    return ("pl_sejm", f"plj_{kind}_{term}_{key}", title,
            {"kind": kind, "term": term, "key": key, "changed_at": changed, "source": "sejm"})


def bzp_doc(oid, ntype, pub, otype, cpv, org, obj):
    return ("pl_bzp", f"plb_{oid}", obj,
            {"object_id": oid, "notice_type": ntype, "publication_date": pub, "order_type": otype,
             "cpv_code": cpv, "organization_name": org, "source": "bzp"})


def opendata_doc(src, sheet, row_no, data):
    text = "; ".join(f"{k}: {v}" for k, v in data.items() if v not in (None, "")) if isinstance(data, dict) else json.dumps(data, ensure_ascii=False)
    if len(text) < 20:
        return None
    return ("pl_opendata", f"plo_{src}_{sheet}_{row_no}", text,
            {"dataset": src, "sheet": sheet, "row_no": row_no, "source": "opendata"})


def decision_doc(did, source, ctype, cname, case_no, dtype, ddate, ecli, full_text):
    if len(full_text) <= 200:
        return None
    return ("pl_decision", f"pld_{did}", full_text,
            {"decision_id": did, "source": source, "court_type": ctype, "court_name": cname,
             "case_number": case_no, "decision_type": dtype, "decision_date": ddate, "ecli": ecli})


def lim(sql):
    return sql + (f" LIMIT {int(SMOKE)}" if SMOKE else "")


DECISIONS = """
SELECT id, source, court_type, court_name, case_number, decision_type, decision_date, ecli, full_text
FROM pl_court_decisions WHERE full_text IS NOT NULL AND abs(hashtext(id)) % {parts} = {part}
"""
ARTICLES = """
WITH cur AS (SELECT DISTINCT ON (act_eli) act_eli, snapshot_eli FROM pl_act_snapshots ORDER BY act_eli, seq DESC)
SELECT a.act_eli, a.snapshot_eli, a.ord, a.art_display, a.art_no, a.text, act.title, act.act_type,
       (cur.snapshot_eli IS NOT NULL) AS is_current
FROM pl_act_articles a
LEFT JOIN pl_acts act ON act.eli = a.act_eli
LEFT JOIN cur ON cur.act_eli = a.act_eli AND cur.snapshot_eli = a.snapshot_eli
WHERE length(a.text) >= 20
"""
SNAPSHOTS = """
WITH cur AS (SELECT DISTINCT ON (act_eli) act_eli, snapshot_eli FROM pl_act_snapshots ORDER BY act_eli, seq DESC)
SELECT t.act_eli, t.snapshot_eli, t.text, act.title, act.act_type, (cur.snapshot_eli IS NOT NULL)
FROM pl_snapshot_texts t
LEFT JOIN pl_acts act ON act.eli = t.act_eli
LEFT JOIN cur ON cur.act_eli = t.act_eli AND cur.snapshot_eli = t.snapshot_eli
WHERE length(t.text) >= 200
"""
SEJM = "SELECT kind, term, key, title, changed_at FROM pl_sejm_objects WHERE length(title) >= 20"
BZP = """SELECT object_id, notice_type, publication_date, order_type, cpv_code, organization_name, order_object
FROM pl_bzp_notices WHERE length(order_object) >= 20"""
OPENDATA = """SELECT source, coalesce(sheet, ''), row_no, data FROM pl_opendata_rows WHERE source NOT LIKE 'teryt%'"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    mine = list(range(PART, N_SHARDS, PARTS))
    files = {i: open(os.path.join(OUT_DIR, f"shard_{i:03d}.ndjson"), "w", encoding="utf-8") for i in mine}
    rr = 0
    docs, chunks, chars = {}, {}, {}
    t0 = time.time()

    def emit(doc):
        nonlocal rr
        if doc is None:
            return
        doc_type = doc[0]
        recs = points(*doc)
        for rec in recs:
            files[mine[rr % len(mine)]].write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            rr += 1
            chars[doc_type] = chars.get(doc_type, 0) + len(rec["text"])
        docs[doc_type] = docs.get(doc_type, 0) + 1
        chunks[doc_type] = chunks.get(doc_type, 0) + len(recs)

    def stream(conn, name, sql, itersize):
        with conn.cursor(name=name) as cur:
            cur.itersize = itersize
            cur.execute(lim(sql))
            yield from cur

    import psycopg  # only the bulk export needs it; the *_doc helpers are imported without it

    with psycopg.connect(DSN) as conn:
        if PART == 0:
            for row in stream(conn, "art", ARTICLES, 2000):
                emit(article_doc(*row))
            print(f"articles done {docs.get('pl_article')} {time.time()-t0:.0f}s", flush=True)
            for row in stream(conn, "snap", SNAPSHOTS, 50):
                emit(snapshot_doc(*row))
            for row in stream(conn, "sejm", SEJM, 5000):
                emit(sejm_doc(*row))
            for row in stream(conn, "bzp", BZP, 10000):
                emit(bzp_doc(*row))
            for row in stream(conn, "od", OPENDATA, 2000):
                emit(opendata_doc(*row))
            print(f"small sources done {time.time()-t0:.0f}s", flush=True)

        n = 0
        for row in stream(conn, "dec", DECISIONS.format(parts=PARTS, part=PART), 500):
            doc = decision_doc(*row)
            if doc is None:
                continue
            emit(doc)
            n += 1
            if n % 50000 == 0:
                print(f"decisions {n} chunks {chunks['pl_decision']} {time.time()-t0:.0f}s", flush=True)

    for f in files.values():
        f.close()
    m = {"part": PART, "parts": PARTS, "n_shards": N_SHARDS, "docs": docs, "chunks": chunks, "chars": chars,
         "total_chunks": sum(chunks.values()), "seconds": round(time.time() - t0),
         "chunking": {"max_chars": MAX, "overlap": OVERLAP, "min_tail": MIN_TAIL}}
    with open(os.path.join(OUT_DIR, f"manifest.part{PART}.json"), "w") as f:
        json.dump(m, f, indent=1)
    print(json.dumps(m), flush=True)


if __name__ == "__main__":
    sys.exit(main())
