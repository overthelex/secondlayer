#!/usr/bin/env python3
"""
Add decisions harvested since the last run to the citation graph (LEXAI-2323).

Reads every edrsr_fulltext row with doc_id above the watermark in
citation_graph_watermark, extracts with the same code as the full rebuild
(case_numbers.find_case_refs for decision -> case, extract-citations.py statute
patterns over the full text for decision -> article) and hands the rows to
incremental-update.sql, which updates edrsr_case_index, case_citation_edges,
case_citation_links, case_citation_counts, decision_statute_citations and
statute_article_stats and moves the watermark, all in one transaction.

EDRSR doc_ids grow with publication, so "above the watermark" is "harvested
since": a late-published old decision has a new doc_id and is picked up too.
The first run starts from max(case_citation_edges.from_case_id), the newest
decision the 20.11.2026 rebuild read.

  DATABASE_URL=postgresql://secondlayer:...@localhost:5432/secondlayer_local \\
    python3 incremental-update.py [--max-docs 200000] [--dry-run]

Scheduling: nightly on cthulhu after the EDRSR harvest, e.g. crontab
  30 4 * * *  cd ~/citgraph-pg && . ./env.sh && flock -n /tmp/citgraph-inc.lock \\
              python3 incremental-update.py >> incremental.log 2>&1
flock keeps runs from overlapping; a failed run commits nothing and the next one
repeats it. Run it only while no full rebuild is writing the same tables.
"""

import argparse
import csv
import io
import os
import sys
import time

import psycopg2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from case_numbers import find_case_refs  # noqa: E402

DSN = os.environ.get("DATABASE_URL", "postgresql://secondlayer@localhost:5432/secondlayer_local")


def load_extractor():
    import importlib.util
    spec = importlib.util.spec_from_file_location("extract_citations", os.path.join(HERE, "extract-citations.py"))
    ec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ec)
    ec._MAX_TEXT_LEN = 10 ** 9   # full text, as the rebuild
    return ec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-docs", type=int, default=500_000, help="decisions per run (the rest waits for the next)")
    ap.add_argument("--dry-run", action="store_true", help="extract and report, roll back")
    ap.add_argument("--since", type=int, help="test only: start above this doc_id instead of the watermark")
    ap.add_argument("--replay", action="store_true",
                    help="test only (needs --dry-run --since): drop the decisions' existing rows inside the "
                         "transaction, re-add them, and diff the links against what the full rebuild wrote")
    args = ap.parse_args()
    if (args.since is not None or args.replay) and not args.dry_run:
        sys.exit("--since/--replay are for testing and require --dry-run")

    ec = load_extractor()
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = '2h'")
    cur.execute("SET lock_timeout = '30s'")
    cur.execute("SET jit = off")
    cur.execute("""CREATE TABLE IF NOT EXISTS citation_graph_watermark (
                     layer text PRIMARY KEY, max_doc_id bigint NOT NULL, updated_at timestamptz DEFAULT now())""")
    cur.execute("SELECT max_doc_id FROM citation_graph_watermark WHERE layer = 'decisions'")
    row = cur.fetchone()
    if row is None:
        cur.execute("SELECT max(from_case_id) FROM case_citation_edges")
        wm = cur.fetchone()[0] or 0
    else:
        wm = row[0]
    if args.since is not None:
        wm = args.since
    conn.commit()

    t0 = time.time()
    rd = conn.cursor(name="inc_read")
    rd.itersize = 1000
    rd.execute("""SELECT doc_id, full_text, justice_kind, adj_year FROM edrsr_fulltext
                   WHERE doc_id > %s ORDER BY doc_id LIMIT %s""", (wm, args.max_docs))
    docs, case_buf, stat_buf = io.StringIO(), io.StringIO(), io.StringIO()
    wd, wc, ws = (csv.writer(b, lineterminator="\n") for b in (docs, case_buf, stat_buf))
    n_docs = n_case = n_stat = 0
    new_wm = wm
    for doc_id, text, jk, adj_year in rd:
        new_wm = max(new_wm, doc_id)
        n_docs += 1
        wd.writerow([doc_id])
        if not text:
            continue
        yv = "" if adj_year is None else adj_year
        seen = set()
        for norm, written in find_case_refs(text):
            if norm not in seen:
                seen.add(norm)
                n_case += 1
                wc.writerow([doc_id, norm, written[:200], "" if jk is None else jk, yv])
        seen = set()
        for c in ec.extract_citations_from_text(doc_id, text):
            if c.citation_type not in ec._STATUTE_TYPES:
                continue
            key = (c.citation_type, c.law_ref, c.article_ref or "")
            if key not in seen:
                seen.add(key)
                n_stat += 1
                ws.writerow([doc_id, *key, yv])
    rd.close()
    print(f"watermark {wm} -> {new_wm}: {n_docs:,} decisions, {n_case:,} case refs, "
          f"{n_stat:,} statute refs ({time.time() - t0:.0f}s extract)", flush=True)
    if n_docs == 0:
        conn.rollback()
        return

    cur.execute("CREATE TEMP TABLE inc_docs (doc_id bigint) ON COMMIT DROP")
    cur.execute("""CREATE TEMP TABLE inc_case (from_case_id bigint, to_case_number text, citation_context text,
                     justice_kind smallint, adj_year smallint) ON COMMIT DROP""")
    cur.execute("""CREATE TEMP TABLE inc_statute (doc_id bigint, citation_type text, law_number text,
                     law_article text, adj_year smallint) ON COMMIT DROP""")
    for buf, sql in ((docs, "COPY inc_docs FROM STDIN WITH (FORMAT csv)"),
                     (case_buf, "COPY inc_case FROM STDIN WITH (FORMAT csv, NULL '')"),
                     (stat_buf, "COPY inc_statute FROM STDIN WITH (FORMAT csv, NULL '', FORCE_NOT_NULL (law_number, law_article))")):
        buf.seek(0)
        cur.copy_expert(sql, buf)
    cur.execute("ANALYZE inc_docs; ANALYZE inc_case; ANALYZE inc_statute")
    if args.replay:
        cur.execute("""CREATE TEMP TABLE replay_before AS
                       SELECT from_doc_id, to_case_number, resolved, is_self_citation, match_method, unresolved_reason
                         FROM case_citation_links WHERE from_doc_id IN (SELECT doc_id FROM inc_docs)""")
        cur.execute("DELETE FROM case_citation_links WHERE from_doc_id IN (SELECT doc_id FROM inc_docs)")
        cur.execute("DELETE FROM case_citation_edges WHERE from_case_id IN (SELECT doc_id FROM inc_docs)")
        cur.execute("DELETE FROM decision_statute_citations WHERE doc_id IN (SELECT doc_id FROM inc_docs)")
    t1 = time.time()
    cur.execute(open(os.path.join(HERE, "incremental-update.sql"), encoding="utf-8").read(), {"new_watermark": new_wm})
    cur.execute("""SELECT (SELECT count(*) FROM inc_edge), (SELECT count(*) FROM inc_link WHERE resolved),
                          (SELECT count(*) FROM inc_stat)""")
    e, r, s = cur.fetchone()
    print(f"edges +{e:,} (resolved links +{r:,}), statute rows +{s:,} ({time.time() - t1:.0f}s apply)", flush=True)
    if args.replay:
        cur.execute("""SELECT (SELECT count(*) FROM replay_before),
                              (SELECT count(*) FROM (SELECT * FROM replay_before EXCEPT
                                 SELECT from_doc_id, to_case_number, resolved, is_self_citation, match_method,
                                        unresolved_reason FROM inc_link) a),
                              (SELECT count(*) FROM (SELECT from_doc_id, to_case_number, resolved, is_self_citation,
                                        match_method, unresolved_reason FROM inc_link EXCEPT
                                 SELECT * FROM replay_before) b)""")
        nb, only_before, only_after = cur.fetchone()
        print(f"replay: {nb:,} links from the rebuild; {only_before:,} missing now, {only_after:,} new/different", flush=True)
    if args.dry_run:
        conn.rollback()
        print("dry run: rolled back", flush=True)
    else:
        conn.commit()
        print(f"committed; watermark = {new_wm}", flush=True)


if __name__ == "__main__":
    main()
