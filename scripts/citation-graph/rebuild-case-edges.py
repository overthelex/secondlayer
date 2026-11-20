#!/usr/bin/env python3
"""
Re-extract decision -> case-number edges from the whole EDRSR corpus (LEXAI-2314).

Case references only (the statute layer is extract-citations.py's job), full
text (no 10,000-character window), into an UNLOGGED, index-free staging table
that rebuild-case-graph-01-finalize.sql turns into case_citation_edges_new /
case_citation_links_new.

Chunking is by heap block range (TID range scan), not OFFSET: every chunk reads
only its own blocks, so a large partition costs one pass instead of the
quadratic re-scan OFFSET/LIMIT does. Each chunk's edges and its progress row
are written in ONE transaction, so a restart skips exactly the chunks that are
in the staging table and never duplicates or loses one.

  python3 rebuild-case-edges.py --partitions 2023-2026 --workers 5
  python3 rebuild-case-edges.py --partitions 2005-2022,pre2005,default,future --workers 4
  python3 rebuild-case-edges.py --status

Rows inserted into a partition after its plan was made are only picked up if
they land in the last (open-ended) chunk; the graph's coverage date is the
start of the run.
"""

import argparse
import csv
import io
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from case_numbers import find_case_refs  # noqa: E402

DSN = os.environ.get("DATABASE_URL", "postgresql://secondlayer@localhost:5432/secondlayer_local")
BULK = "cce_rebuild_bulk"
PROGRESS = "cce_rebuild_progress"


def connect():
    conn = psycopg2.connect(DSN)
    with conn.cursor() as c:
        c.execute("SET idle_in_transaction_session_timeout = 0")
        c.execute("SET statement_timeout = 0")
        c.execute("SET jit = off")
    conn.commit()
    return conn


def setup(conn):
    with conn.cursor() as c:
        c.execute(f"""CREATE UNLOGGED TABLE IF NOT EXISTS {BULK} (
            from_case_id bigint, to_case_number text, citation_context text,
            justice_kind smallint, adj_year smallint)""")
        c.execute(f"""CREATE TABLE IF NOT EXISTS {PROGRESS} (
            part text, blk_lo bigint, blk_hi bigint, rows_read int, docs_with_text int,
            edges int, seconds real, done_at timestamptz DEFAULT now(),
            PRIMARY KEY (part, blk_lo))""")
    conn.commit()


def partitions(conn, spec: str) -> list[str]:
    want = set()
    for tok in spec.split(","):
        tok = tok.strip()
        if "-" in tok and tok.replace("-", "").isdigit():
            a, b = tok.split("-")
            want |= {f"edrsr_fulltext_p_{y}" for y in range(int(a), int(b) + 1)}
        elif tok:
            want.add(f"edrsr_fulltext_p_{tok}")
    with conn.cursor() as c:
        c.execute("""SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                      WHERE i.inhparent = 'edrsr_fulltext'::regclass ORDER BY c.relname DESC""")
        have = [r[0] for r in c.fetchall()]
    missing = want - set(have)
    if missing:
        sys.exit(f"no such partitions: {sorted(missing)}")
    return [p for p in have if p in want]


def plan(conn, parts: list[str], chunk_blocks: int) -> list[tuple]:
    chunks = []
    with conn.cursor() as c:
        for p in parts:
            c.execute("SELECT pg_relation_size(%s::regclass) / current_setting('block_size')::int", (p,))
            nblocks = c.fetchone()[0]
            c.execute(f"SELECT blk_lo FROM {PROGRESS} WHERE part = %s", (p,))
            done = {r[0] for r in c.fetchall()}
            los = list(range(0, max(nblocks, 1), chunk_blocks))
            for i, lo in enumerate(los):
                hi = None if i == len(los) - 1 else lo + chunk_blocks   # last chunk is open-ended
                if lo not in done:
                    chunks.append((p, lo, hi))
    return chunks


def process_chunk(task: tuple) -> dict:
    part, lo, hi = task
    t0 = time.time()
    year = part.rsplit("_", 1)[-1]
    part_year = int(year) if year.isdigit() else None
    conn = connect()
    cur = conn.cursor(name=f"cce_{part}_{lo}")
    cur.itersize = 500
    where = "ctid >= %s::tid" + ("" if hi is None else " AND ctid < %s::tid")
    params = [f"({lo},0)"] + ([] if hi is None else [f"({hi},0)"])
    cur.execute(f"SELECT doc_id, full_text, justice_kind, adj_year FROM {part} WHERE {where}", params)

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    rows = docs = edges = 0
    for doc_id, text, jk, adj_year in cur:
        rows += 1
        if not text:
            continue
        docs += 1
        seen = set()
        for norm, written in find_case_refs(text):
            if norm in seen:
                continue
            seen.add(norm)
            edges += 1
            w.writerow([doc_id, norm, written[:200], "" if jk is None else jk,
                        adj_year if adj_year is not None else ("" if part_year is None else part_year)])
    cur.close()

    buf.seek(0)
    with conn.cursor() as c:
        c.copy_expert(
            f"COPY {BULK} (from_case_id, to_case_number, citation_context, justice_kind, adj_year) "
            f"FROM STDIN WITH (FORMAT csv, NULL '')", buf)
        c.execute(
            f"INSERT INTO {PROGRESS} (part, blk_lo, blk_hi, rows_read, docs_with_text, edges, seconds) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (part, lo, hi, rows, docs, edges, time.time() - t0))
    conn.commit()
    conn.close()
    return {"part": part, "lo": lo, "rows": rows, "edges": edges}


def status(conn):
    with conn.cursor() as c:
        c.execute(f"""SELECT part, count(*), sum(rows_read), sum(edges), round(sum(seconds)::numeric),
                             max(done_at) FROM {PROGRESS} GROUP BY part ORDER BY part""")
        for r in c.fetchall():
            print(*r, sep="\t")
        c.execute(f"SELECT count(*), sum(rows_read), sum(edges) FROM {PROGRESS}")
        print("TOTAL", *c.fetchone(), sep="\t")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--partitions", help="e.g. 2023-2026 or 2005-2022,pre2005,default,future")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--chunk-blocks", type=int, default=2000, help="heap blocks per chunk (8 KB each)")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    conn = connect()
    setup(conn)
    if args.status:
        status(conn)
        return
    if not args.partitions:
        ap.error("--partitions or --status")
    parts = partitions(conn, args.partitions)
    chunks = plan(conn, parts, args.chunk_blocks)
    conn.close()
    print(f"{time.strftime('%F %T')} partitions={len(parts)} pending chunks={len(chunks)} workers={args.workers}", flush=True)

    t0 = time.time()
    rows = edges = 0
    failed = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_chunk, ch): ch for ch in chunks}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                r = f.result()
            except Exception as e:  # one lost connection must not end a multi-hour run
                failed.append(futs[f])
                print(f"  ! {futs[f]} failed: {type(e).__name__}: {e}", flush=True)
                continue
            rows += r["rows"]
            edges += r["edges"]
            if i % 25 == 0 or i == len(chunks):
                el = time.time() - t0
                print(f"{time.strftime('%F %T')} [{i}/{len(chunks)}] rows={rows:,} edges={edges:,} "
                      f"{rows / el:,.0f} rows/s", flush=True)
    lost = 0
    for ch in failed:
        try:
            process_chunk(ch)
            print(f"  retry ok {ch}", flush=True)
        except Exception as e:
            lost += 1
            print(f"  ✗ {ch} failed again: {e}", flush=True)
    print(f"{time.strftime('%F %T')} done in {time.time() - t0:,.0f}s; chunks still missing: {lost}"
          + (" (rerun the same command: done chunks are skipped)" if lost else ""), flush=True)


if __name__ == "__main__":
    main()
