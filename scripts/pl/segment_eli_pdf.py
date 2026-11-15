#!/usr/bin/env python3
"""Articles and headings for PDF-only ELI snapshots (verdict 906).

  python3 scripts/pl/segment_eli_pdf.py --eli DU/2026/1245 --dry-run   # inspect one
  python3 scripts/pl/segment_eli_pdf.py --limit 20                     # smoke
  python3 scripts/pl/segment_eli_pdf.py                                # everything not tried yet

Worklist: pl_snapshot_texts rows with http_status 906 and pdf_split IS NULL. The
PDF is read from the harvest_eli_pdf.py cache (RAW/<eli>.pdf); nothing is fetched.

Per snapshot, in one transaction: its pl_act_articles / pl_act_units rows are
replaced, and pl_snapshot_texts gets article_count, unit_count and pdf_split
(200 = split, 9xx = rejected, see pl_pdf_segmenter). A rejected snapshot keeps
its whole text and article_count 0, so the MCP tools keep answering from the
last HTML edition with their "newer editions are not split" warning.

When the source later publishes HTML for the snapshot, sync_eli_changes.py
deletes these rows together with the 906 text row and the HTML pass takes over.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402
import pl_pdf_segmenter as seg  # noqa: E402

RAW = os.environ.get("RAW", "/data/pl_eli/raw")
WORKERS = int(os.environ.get("WORKERS", "4"))
BATCH = int(os.environ.get("BATCH", "50"))
NO_PDF = 910

ART_COLS = ["act_eli", "snapshot_eli", "ord", "symbol", "struct_id", "art_no",
            "art_display", "art_sort_1", "art_sort_2", "art_title", "text", "n_chars"]
UNIT_COLS = ["snapshot_eli", "ord", "parent_ord", "depth", "struct_id", "symbol",
             "unit_type", "name", "title", "article_ord", "in_annex"]


def lit(v):
    return "'" + str(v).replace("'", "''") + "'"


def worklist(limit, eli=None, every=False):
    where = f"t.snapshot_eli = {lit(eli)}" if eli else "TRUE" if every else "t.pdf_split IS NULL"
    lim = f"LIMIT {int(limit)}" if limit else ""
    return list(plprod.rows_of(
        "SELECT t.snapshot_eli, t.act_eli, s.snapshot_kind, "
        "  (SELECT p.snapshot_eli FROM pl_act_snapshots p "
        "     JOIN pl_snapshot_texts pt ON pt.snapshot_eli = p.snapshot_eli "
        "    WHERE p.act_eli = s.act_eli AND p.seq < s.seq AND pt.http_status = 200 "
        "      AND pt.article_count > 0 ORDER BY p.seq DESC LIMIT 1) "
        "FROM pl_snapshot_texts t "
        "JOIN pl_act_snapshots s ON s.snapshot_eli = t.snapshot_eli AND s.act_eli = t.act_eli "
        f"WHERE t.http_status = 906 AND {where} ORDER BY t.snapshot_eli {lim}"))


def previous_articles(snapshot_elis):
    if not snapshot_elis:
        return {}
    ids = ", ".join(lit(e) for e in snapshot_elis)
    prev = {}
    for snap, art_no in plprod.rows_of(
            f"SELECT snapshot_eli, art_no FROM pl_act_articles WHERE snapshot_eli IN ({ids}) "
            "ORDER BY snapshot_eli, ord"):
        prev.setdefault(snap, []).append(art_no)
    return prev


def symbol_of(art_no):
    return "arti_" + art_no.replace("^", "_")


def process(job):
    """(snapshot_eli, act_eli, kind, previous art_nos) -> result dict. Runs in a worker."""
    import pymupdf  # imported here: the module is optional for the rest of the pipeline
    snap, act, kind, prev = job
    path = os.path.join(RAW, snap + ".pdf")
    if not os.path.exists(path):
        return {"snap": snap, "act": act, "verdict": NO_PDF, "detail": {}}
    try:
        with pymupdf.open(path) as doc:
            lines, footnotes = seg.read_lines(doc)
    except Exception as e:  # noqa: BLE001 - a broken PDF must not stop the batch
        return {"snap": snap, "act": act, "verdict": NO_PDF, "detail": {"error": str(e)[:200]}}
    verdict, articles, headings = seg.segment(lines, kind == "jednolity", footnotes)
    detail = {}
    if verdict == seg.OK:
        verdict, detail = seg.validate(articles, prev, headings)
    if verdict != seg.OK:
        return {"snap": snap, "act": act, "verdict": verdict, "detail": detail}
    return {"snap": snap, "act": act, "verdict": seg.OK, "detail": detail,
            "articles": articles, "units": seg.heading_units(headings, articles)}


def rows_for(r):
    arts, units = [], []
    for i, a in enumerate(r["articles"], 1):
        k = seg.art_key(a["art_no"])
        display = "Art. " + a["art_no"] + "."
        arts.append([r["act"], r["snap"], i, symbol_of(a["art_no"]), "pdf-" + symbol_of(a["art_no"]),
                     a["art_no"], display, k[0], k[2] or None, display, a["text"], len(a["text"])])
    for i, u in enumerate(r["units"], 1):
        sym = (u["unit_type"] + "_" + u["name"]) if u["name"] else u["unit_type"]
        units.append([r["snap"], i, (u["parent"] + 1) if u["parent"] is not None else None,
                      u["depth"], f"pdf-{i}", sym, u["unit_type"], u["name"], u["title"],
                      u["article_ord"], False])
    return arts, units


def write(results):
    """One transaction for the batch: replace articles/units, then mark the text rows."""
    snaps = [r["snap"] for r in results]
    ids = ", ".join(lit(s) for s in snaps)
    arts, units = [], []
    for r in results:
        if r["verdict"] == seg.OK:
            a, u = rows_for(r)
            arts += a
            units += u
    sql = ["BEGIN;",
           f"DELETE FROM pl_act_articles WHERE snapshot_eli IN ({ids});",
           f"DELETE FROM pl_act_units WHERE snapshot_eli IN ({ids});"]
    for table, cols, rows in (("pl_act_articles", ART_COLS, arts), ("pl_act_units", UNIT_COLS, units)):
        if rows:
            sql.append(f"COPY {table} ({', '.join(cols)}) FROM STDIN WITH (FORMAT text);")
            sql.append("".join("\t".join(plprod.esc(c) for c in row) + "\n" for row in rows) + "\\.")
    for r in results:
        n_art = len(r.get("articles") or [])
        n_unit = len(r.get("units") or [])
        sql.append(
            f"UPDATE pl_snapshot_texts SET article_count = {n_art}, unit_count = {n_unit}, "
            f"nonmonotonic = {int(r['detail'].get('backwards') or 0) if r['verdict'] == seg.OK else 0}, "
            f"pdf_split = {int(r['verdict'])} WHERE snapshot_eli = {lit(r['snap'])} "
            "AND http_status = 906;")
    sql.append("COMMIT;")
    proc = subprocess.run(plprod._argv(), input="\n".join(sql) + "\n",
                          capture_output=True, text=True, timeout=plprod.PSQL_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError(f"segment write failed: {proc.stderr.strip()[:600]}")
    return len(arts), len(units)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--eli", help="one snapshot, ignores pdf_split")
    ap.add_argument("--dry-run", action="store_true", help="print, write nothing")
    ap.add_argument("--scan", action="store_true",
                    help="dry run over every 906 snapshot: verdict counts and rejects only")
    a = ap.parse_args()

    started = time.time()
    counts = {}
    done = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        if a.scan:
            work = worklist(a.limit, every=True)
            prev = previous_articles(sorted({w[3] for w in work if w[3]}))
            jobs = [(s, act, kind, prev.get(p) if p else None) for s, act, kind, p in work]
            for r in pool.map(process, jobs, chunksize=4):
                counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
                if r["verdict"] != seg.OK:
                    print(r["snap"], r["verdict"], json.dumps(r["detail"], ensure_ascii=False), flush=True)
            print("scan", counts, f"{int(time.time() - started)}s", flush=True)
            return 0
        while True:
            n = BATCH if not a.limit else min(BATCH, a.limit - done)
            if n <= 0:
                break
            work = worklist(n, a.eli)
            if not work:
                break
            prev = previous_articles([w[3] for w in work if w[3]])
            jobs = [(s, act, kind, prev.get(p) if p else None) for s, act, kind, p in work]
            results = list(pool.map(process, jobs))
            for r in results:
                counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
                if a.dry_run or r["verdict"] != seg.OK:
                    print(r["snap"], r["verdict"], json.dumps(r["detail"], ensure_ascii=False),
                          len(r.get("articles") or []), "articles", flush=True)
            if a.dry_run:
                for r in results:
                    for art in (r.get("articles") or [])[:3]:
                        print("  ", art["art_no"], "|", art["text"][:160].replace("\n", " / "))
                    for u in [u for u in (r.get("units") or []) if u["unit_type"] != "arti"][:8]:
                        print("  ", "  " * u["depth"], u["unit_type"], u["title"])
                break
            write(results)
            done += len(work)
            print(f"[{int(time.time() - started)}s] {done} snapshots | {counts}", flush=True)
            if a.eli:
                break
    print("done", counts, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
