#!/usr/bin/env python3
"""Daily incremental vectors for the Polish corpus (pl_corpus_bge_cls on qdrant-lawrider).

The bulk run (export 10.11.2026 17:58 UTC, load 14.11) embedded everything that
was in pg-lawrider then; the daily harvesters (ncourt, SAOS, KIO, TK, BZP, Sejm,
ELI sync, dane.gov.pl files) keep adding rows after it. This script picks up what
changed since a cursor and gives it the same points a full re-export would:
chunking, point ids and payloads come from pl_chunk_export.py (the *_doc helpers),
not from a copy.

Two steps, like vectorize_pdf_articles.py, because Postgres is reached from the
host (127.0.0.1:5448, PG* env from ~/lawrider/pl-env.sh) while TEI and Qdrant
are only on the `lawrider` docker network. run_vectorize_incremental.sh runs both:

  # 1. host: rows changed since the cursors -> <work>/batch.ndjson
  python3 vectorize_incremental.py export --work ~/lawrider/pl-vectors/incremental
  # 2. container on the network: diff against Qdrant, embed what is new, upsert
  docker run --rm --network lawrider ... python /code/vectorize_incremental.py load --work /work

What counts as changed (cursor = (timestamp, key), stored in <work>/state.json):
  decisions    pl_court_decisions greatest(imported_at, updated_at)
  legislation  pl_snapshot_texts.fetched_at (texts fetched or refetched by
               sync_eli_changes.py), plus editions newly split out of PDFs
               (pdf_split = 200; segment_eli_pdf.py does not touch fetched_at,
               so these are tracked as a set)
  bzp          pl_bzp_notices.fetched_at, plus the update notices of the same
               procedures (harvest_bzp.fill_updates copies CPV into them)
  sejm         pl_sejm_objects.fetched_at
  opendata     pl_opendata_loads.loaded_at (a reload replaces the whole source)

The load is a diff, not a blind upsert: every expected point is first looked
up by id, and only a missing point or one whose text changed is embedded. A
point whose text is the same but whose payload differs (BZP CPV filled in
later, a court name) gets its payload overwritten without re-embedding. So the
cursors can overlap (30 min) and a re-run costs lookups, not TEI time.

Stale points:
  - an edition (snapshot) is replaced as a unit: once its points are in, the
    edition's other points are deleted (filter snapshot_eli, must_not has_id).
    For an edition split out of a PDF the whole-text pl_act_text points are not
    expected, so they go - the rule vectorize_pdf_articles.py applies. An
    edition with no points at all (no text yet) is left alone, never emptied.
  - a decision/notice/Sejm object whose text got shorter loses the chunk ids
    past its new n_chunks (read off the old chunk 0).
  - an open-data source is replaced as a unit (filter doc_type + dataset).
  - is_current: for every act with a touched edition, points of the act's
    latest snapshot get is_current=true and all its other points false
    (set_payload by filter; act_eli, snapshot_eli and is_current are indexed).
    Same rule as the bulk export: the latest snapshot is current even before it
    has text.

Caps: export stops adding units at --max-chunks expected chunks (default
40000) and keeps the cursor at the last unit taken; load stops after
--max-seconds (default 7200) and leaves the rest of the batch for the next run
(export does not write a new batch while one is pending). TEI is the live
search embedder (CPU, 3 cores): one request of 4 texts in flight, so a live
query waits at most ~3 s behind us (with 2 x 8 in flight TEI queue time was 6-7 s).
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pl_chunk_export as X  # noqa: E402

COLLECTION = os.environ.get("COLLECTION", "pl_corpus_bge_cls")
QDRANT = os.environ.get("QDRANT_URL", "http://qdrant-lawrider:6333")
TEI = os.environ.get("TEI_URL", "http://tei-bge-m3-lawrider:80")
TEI_BATCH = int(os.environ.get("TEI_BATCH", "4"))
TEI_PARALLEL = int(os.environ.get("TEI_PARALLEL", "1"))

# The bulk export started here; everything older is in the collection.
BULK_EXPORT_START = "2026-11-10T17:58:35+00:00"
OVERLAP = timedelta(minutes=30)
STREAMS = ("decisions", "legislation", "bzp", "sejm", "opendata")
LEGISLATION_TYPES = ("pl_article", "pl_act_text")
GROUP_POINTS = 256


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, default=str)
    os.replace(path + ".tmp", path)


# ----------------------------------------------------------------------------- export

DECISIONS = """
SELECT greatest(imported_at, coalesce(updated_at, imported_at)) AS ts, id,
       id, source, court_type, court_name, case_number, decision_type, decision_date, ecli, full_text
FROM pl_court_decisions
WHERE full_text IS NOT NULL
  AND (greatest(imported_at, coalesce(updated_at, imported_at)), id) > (%s::timestamptz, %s)
ORDER BY 1, 2
"""
SNAP_CANDIDATES = """
SELECT fetched_at, snapshot_eli FROM pl_snapshot_texts
WHERE fetched_at IS NOT NULL AND (fetched_at, snapshot_eli) > (%s::timestamptz, %s)
ORDER BY 1, 2
"""
CUR = """SELECT DISTINCT ON (act_eli) act_eli, snapshot_eli FROM pl_act_snapshots
WHERE act_eli = ANY(%s) ORDER BY act_eli, seq DESC"""
SNAP_ACTS = "SELECT snapshot_eli, act_eli, pdf_split FROM pl_snapshot_texts WHERE snapshot_eli = ANY(%s)"
ARTICLES = """
SELECT a.act_eli, a.snapshot_eli, a.ord, a.art_display, a.art_no, a.text, act.title, act.act_type
FROM pl_act_articles a LEFT JOIN pl_acts act ON act.eli = a.act_eli
WHERE a.snapshot_eli = ANY(%s) AND length(a.text) >= 20
ORDER BY a.snapshot_eli, a.ord
"""
SNAP_TEXTS = """
SELECT t.act_eli, t.snapshot_eli, t.text, act.title, act.act_type
FROM pl_snapshot_texts t LEFT JOIN pl_acts act ON act.eli = t.act_eli
WHERE t.snapshot_eli = ANY(%s) AND length(t.text) >= 200
"""
BZP = """
SELECT fetched_at, object_id,
       object_id, notice_type, publication_date, order_type, cpv_code, organization_name, order_object, tender_id
FROM pl_bzp_notices
WHERE (fetched_at, object_id) > (%s::timestamptz, %s)
ORDER BY 1, 2
"""
BZP_UPDATES = """
SELECT object_id, notice_type, publication_date, order_type, cpv_code, organization_name, order_object
FROM pl_bzp_notices
WHERE tender_id = ANY(%s) AND notice_type = 'NoticeUpdateNotice'
  AND publication_date >= now() - interval '120 days' AND length(order_object) >= 20
"""
SEJM = """
SELECT fetched_at, kind || '/' || term || '/' || key, kind, term, key, title, changed_at
FROM pl_sejm_objects
WHERE (fetched_at, kind || '/' || term || '/' || key) > (%s::timestamptz, %s)
ORDER BY 1, 2
"""
OD_LOADS = """
SELECT max(loaded_at), source FROM pl_opendata_loads
WHERE source NOT LIKE 'teryt%%' GROUP BY source HAVING max(loaded_at) > %s::timestamptz ORDER BY 1, 2
"""
OD_ROWS = "SELECT source, coalesce(sheet, ''), row_no, data FROM pl_opendata_rows WHERE source = %s ORDER BY row_no"


def doc_unit(uid, docs, replace=None):
    """A unit: the expected points of some documents, applied together."""
    pts, meta = [], []
    for d in docs:
        if d is None:
            continue
        p = X.points(*d)
        pts.extend(p)
        meta.append({"key": d[1], "n": len(p)})
    return {"u": uid, "points": pts, "docs": meta, "replace": replace}


class Budget:
    def __init__(self, max_chunks):
        self.left = max_chunks

    def take(self, unit):
        self.left -= len(unit["points"])
        return self.left > 0


def advance(cursor, last, seen_max, truncated):
    """New (ts, key) cursor for a stream."""
    if truncated:
        return [str(last[0]), last[1]]
    if seen_max is None:
        return cursor
    back = seen_max - OVERLAP
    old = datetime.fromisoformat(cursor[0])
    return [str(max(back, old)), ""] if back > old else cursor


def stream_rows(conn, name, sql, params):
    with conn.cursor(name=name) as cur:
        cur.itersize = 200
        cur.execute(sql, params)
        yield from cur


def export(args):
    import psycopg2

    work = args.work
    os.makedirs(work, exist_ok=True)
    batch_path = os.path.join(work, "batch.ndjson")
    if os.path.exists(batch_path):
        log(f"batch pending ({batch_path}), not exporting a new one")
        return 0
    state = read_json(os.path.join(work, "state.json"), {})
    cursors = state.setdefault("cursors", {})
    for s in STREAMS:
        cursors.setdefault(s, [BULK_EXPORT_START, ""])
    streams = [s for s in STREAMS if s in args.streams.split(",")]
    if args.no_legislation and "legislation" in streams:
        streams.remove("legislation")
        log("legislation skipped this run (--no-legislation)")

    conn = psycopg2.connect("")
    conn.set_session(readonly=True)
    with conn.cursor() as c:
        c.execute("SET statement_timeout = '1800s'")
    budget = Budget(args.max_chunks)
    units, new_cursors, extra = [], {}, {}
    out_of_budget = False

    def run_stream(name, sql, make):
        """Walk a cursor-ordered query; make(row) -> unit or None. Returns the new cursor."""
        nonlocal out_of_budget
        cursor = cursors[name]
        if out_of_budget:
            return cursor
        last, seen_max, truncated, n = None, None, False, 0
        for row in stream_rows(conn, f"s_{name}", sql, (cursor[0], cursor[1])):
            ts, key = row[0], row[1]
            last, seen_max = (ts, key), ts if seen_max is None or ts > seen_max else seen_max
            u = make(row)
            n += 1
            if u is not None and u["points"]:
                units.append(u)
                if not budget.take(u):
                    truncated = out_of_budget = True
                    break
        log(f"{name}: {n} rows since {cursor[0]}{' (budget reached)' if truncated else ''}")
        return advance(cursor, last, seen_max, truncated)

    if "decisions" in streams:
        new_cursors["decisions"] = run_stream(
            "decisions", DECISIONS, lambda r: doc_unit(f"dec:{r[2]}", [X.decision_doc(*r[2:])]))

    if "legislation" in streams and not out_of_budget:
        snaps, last, seen_max = [], None, None
        for ts, snap in stream_rows(conn, "s_snap", SNAP_CANDIDATES, tuple(cursors["legislation"])):
            snaps.append(snap)
            last, seen_max = (ts, snap), ts
        with conn.cursor() as c:
            c.execute("SELECT snapshot_eli FROM pl_snapshot_texts WHERE pdf_split = 200")
            split_now = {r[0] for r in c.fetchall()}
        seen = state.get("pdf_split_seen")
        if seen is None:  # first run: the PDF articles vectorize_pdf_articles.py already loaded
            seen = []
            if args.seed_pdf_done and os.path.exists(args.seed_pdf_done):
                seen = open(args.seed_pdf_done).read().split()
            log(f"pdf_split_seen seeded with {len(seen)} editions from {args.seed_pdf_done}")
        new_split = sorted(split_now - set(seen))
        cand = list(dict.fromkeys(new_split + snaps))
        log(f"legislation: {len(snaps)} editions fetched since {cursors['legislation'][0]}, "
            f"{len(new_split)} newly split from PDF")
        truncated = False
        taken = []
        for i in range(0, len(cand), 200):
            part = cand[i:i + 200]
            with conn.cursor() as c:
                c.execute(SNAP_ACTS, (part,))
                info = {r[0]: (r[1], r[2]) for r in c.fetchall()}
                acts = sorted({a for a, _ in info.values()})
                c.execute(CUR, (acts,))
                cur = dict(c.fetchall())
                c.execute(ARTICLES, (part,))
                arts = {}
                for r in c.fetchall():
                    arts.setdefault(r[1], []).append(r)
                c.execute(SNAP_TEXTS, (part,))
                texts = {r[1]: r for r in c.fetchall()}
            for snap in part:
                if snap not in info:
                    continue  # text row deleted since (sync step 5); it comes back with a new fetched_at
                act, pdf_split = info[snap]
                is_cur = cur.get(act) == snap
                split = pdf_split == 200
                docs = [X.article_doc(*r, is_cur, source="eli-pdf-split" if split else "eli")
                        for r in arts.get(snap, [])]
                if snap in texts and not split:
                    docs.append(X.snapshot_doc(*texts[snap], is_cur))
                u = doc_unit(f"snap:{snap}", docs,
                             replace={"key": "snapshot_eli", "value": snap})
                taken.append(snap)
                if u["points"]:
                    units.append(u)
                    if not budget.take(u):
                        truncated = out_of_budget = True
                        break
            if truncated:
                break
        # is_current for every act with a touched edition (also one with no text yet: it is
        # still the act's latest snapshot), queued after the editions themselves
        with conn.cursor() as c:
            c.execute(SNAP_ACTS, (taken,))
            acts = sorted({r[1] for r in c.fetchall()})
            c.execute(CUR, (acts,))
            cur = dict(c.fetchall())
        for a in acts:
            units.append({"u": f"cur:{a}", "act_current": {"act_eli": a, "cur": cur.get(a)}})
        if truncated:
            last_taken = taken[-1]
            # cursor: the last fetched_at-ordered edition taken (new splits are tracked by set)
            ts_rows = [s for s in snaps if s in set(taken)]
            if ts_rows:
                with conn.cursor() as c:
                    c.execute("SELECT fetched_at FROM pl_snapshot_texts WHERE snapshot_eli = %s", (ts_rows[-1],))
                    new_cursors["legislation"] = [str(c.fetchone()[0]), ts_rows[-1]]
            else:
                new_cursors["legislation"] = cursors["legislation"]
            extra["pdf_split_seen"] = sorted(set(seen) | (set(new_split) & set(taken)))
            log(f"legislation: budget reached at {last_taken}")
        else:
            new_cursors["legislation"] = advance(cursors["legislation"], last, seen_max, False)
            extra["pdf_split_seen"] = sorted(set(seen) | set(new_split))

    if "bzp" in streams:
        tenders = set()

        def bzp_unit(r):
            if r[9]:
                tenders.add(r[9])
            obj = r[8]
            if not obj or len(obj) < 20:
                return None
            return doc_unit(f"bzp:{r[2]}", [X.bzp_doc(*r[2:9])])
        new_cursors["bzp"] = run_stream("bzp", BZP, bzp_unit)
        have = {u["u"] for u in units}
        if tenders:
            with conn.cursor() as c:
                c.execute(BZP_UPDATES, (sorted(tenders),))
                rows = c.fetchall()
            added = 0
            for r in rows:
                if f"bzp:{r[0]}" not in have:
                    units.append(doc_unit(f"bzp:{r[0]}", [X.bzp_doc(*r)]))
                    added += 1
            log(f"bzp: {added} update notices of the same procedures re-checked")

    if "sejm" in streams:
        new_cursors["sejm"] = run_stream(
            "sejm", SEJM,
            lambda r: doc_unit(f"sejm:{r[1]}", [X.sejm_doc(*r[2:])]) if r[5] and len(r[5]) >= 20 else None)

    if "opendata" in streams and not out_of_budget:
        cursor = cursors["opendata"]
        with conn.cursor() as c:
            c.execute(OD_LOADS, (cursor[0],))
            loads = c.fetchall()
        seen_max = None
        for ts, src in loads:
            with conn.cursor() as c:
                c.execute(OD_ROWS, (src,))
                docs = [X.opendata_doc(*r) for r in c.fetchall()]
            u = doc_unit(f"od:{src}", docs, replace={"key": "dataset", "value": src, "doc_type": "pl_opendata"})
            if u["points"]:
                units.append(u)
                budget.take(u)
            seen_max = ts if seen_max is None or ts > seen_max else seen_max
        log(f"opendata: {len(loads)} sources reloaded since {cursor[0]}")
        # opendata cursor is exact (one row per source load): no overlap needed
        new_cursors["opendata"] = [str(seen_max), ""] if seen_max else cursor
    conn.close()

    for s in STREAMS:
        new_cursors.setdefault(s, cursors[s])
    n_pts = sum(len(u.get("points", [])) for u in units)
    by_kind = {}
    for u in units:
        k = u["u"].split(":", 1)[0]
        by_kind[k] = by_kind.get(k, 0) + 1
    header = {"header": {"created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                         "cursors": new_cursors, "units": len(units), "points": n_pts,
                         "by_kind": by_kind, **extra}}
    if not units:
        state["cursors"] = new_cursors
        state.update(extra)
        write_json(os.path.join(work, "state.json"), state)
        log("nothing to do; cursors advanced")
        return 0
    with open(batch_path + ".tmp", "w", encoding="utf-8") as f:
        f.write(json.dumps(header, ensure_ascii=False, default=str) + "\n")
        for u in units:
            f.write(json.dumps(u, ensure_ascii=False, default=str) + "\n")
    os.replace(batch_path + ".tmp", batch_path)
    log(f"batch: {len(units)} units, {n_pts} expected chunks {by_kind}")
    return 0


# ----------------------------------------------------------------------------- load

def load(args):
    import requests

    work = args.work
    batch_path = os.path.join(work, "batch.ndjson")
    done_path = batch_path + ".done"
    if not os.path.exists(batch_path):
        log("no batch")
        return 0
    s = requests.Session()
    base = f"{QDRANT}/collections/{COLLECTION}"

    def call(method, path, body, tries=6):
        for attempt in range(tries):
            try:
                r = s.request(method, base + path, json=body, timeout=300)
                r.raise_for_status()
                return r.json()["result"]
            except Exception as e:  # noqa: BLE001 - qdrant busy optimizing
                log(f"  qdrant {path} retry {attempt + 1}: {str(e)[:160]}")
                time.sleep(3 * (attempt + 1))
        raise SystemExit(f"qdrant {path} keeps failing")

    def embed(batch):
        for attempt in range(6):
            try:
                r = s.post(f"{TEI}/embed", json={"inputs": batch, "truncate": True}, timeout=900)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001 - TEI queue full, restart
                log(f"  embed retry {attempt + 1}: {str(e)[:160]}")
                time.sleep(5 * (attempt + 1))
        raise SystemExit("TEI keeps failing")

    with open(batch_path, encoding="utf-8") as f:
        header = json.loads(f.readline())["header"]
        units = [json.loads(line) for line in f if line.strip()]
    done = set(open(done_path).read().split("\n")) if os.path.exists(done_path) else set()
    todo = [u for u in units if u["u"] not in done]
    log(f"batch {header['created']}: {len(units)} units, {len(done & {u['u'] for u in units})} done, {len(todo)} to go")

    stats = {"embedded": 0, "unchanged": 0, "payload": 0, "stale_deleted": 0, "replaced": 0, "current": 0}
    t0 = time.time()
    pool = ThreadPoolExecutor(TEI_PARALLEL)

    def strip(p, legislation):
        q = {k: v for k, v in p.items() if k != "id"}
        if legislation:
            q.pop("is_current", None)
        return q

    def apply(group):
        pts = [p for u in group for p in u.get("points", [])]
        existing = {}
        for i in range(0, len(pts), GROUP_POINTS):
            ids = [p["id"] for p in pts[i:i + GROUP_POINTS]]
            for r in call("POST", "/points", {"ids": ids, "with_payload": True, "with_vector": False}):
                existing[r["id"]] = r.get("payload") or {}
        need, repay = [], []
        for p in pts:
            ex = existing.get(p["id"])
            leg = p["doc_type"] in LEGISLATION_TYPES
            if ex is None or ex.get("text") != p["text"]:
                need.append(p)
            elif strip(p, leg) != strip(ex, leg):
                repay.append(p)
            else:
                stats["unchanged"] += 1
        if need:
            batches = [need[i:i + TEI_BATCH] for i in range(0, len(need), TEI_BATCH)]
            vecs = [v for vs in pool.map(lambda b: embed([p["text"] for p in b]), batches) for v in vs]
            for i in range(0, len(need), 64):
                call("PUT", "/points?wait=true", {"points": [
                    {"id": p["id"], "vector": v, "payload": {k: x for k, x in p.items() if k != "id"}}
                    for p, v in zip(need[i:i + 64], vecs[i:i + 64])]})
            stats["embedded"] += len(need)
        for p in repay:
            payload = {k: x for k, x in p.items() if k != "id"}
            if p["doc_type"] in LEGISLATION_TYPES:
                payload.pop("is_current", None)  # owned by the act_current units
                call("POST", "/points/payload?wait=true", {"payload": payload, "points": [p["id"]]})
            else:
                call("PUT", "/points/payload?wait=true", {"payload": payload, "points": [p["id"]]})
        stats["payload"] += len(repay)
        for u in group:
            if u.get("act_current"):
                a, cur = u["act_current"]["act_eli"], u["act_current"]["cur"]
                off = {"must": [{"key": "act_eli", "match": {"value": a}},
                                {"key": "is_current", "match": {"value": True}}]}
                if cur:
                    off["must_not"] = [{"key": "snapshot_eli", "match": {"value": cur}}]
                    call("POST", "/points/payload?wait=true", {"payload": {"is_current": True}, "filter": {"must": [
                        {"key": "act_eli", "match": {"value": a}},
                        {"key": "snapshot_eli", "match": {"value": cur}},
                        {"key": "is_current", "match": {"value": False}}]}})
                call("POST", "/points/payload?wait=true", {"payload": {"is_current": False}, "filter": off})
                stats["current"] += 1
                continue
            if u.get("replace") and u["points"]:
                rp = u["replace"]
                must = [{"key": rp["key"], "match": {"value": rp["value"]}}]
                if rp.get("doc_type"):
                    must.append({"key": "doc_type", "match": {"value": rp["doc_type"]}})
                flt = {"must": must, "must_not": [{"has_id": [p["id"] for p in u["points"]]}]}
                n = call("POST", "/points/count", {"filter": flt, "exact": True})["count"]
                if n:
                    call("POST", "/points/delete?wait=true", {"filter": flt})
                    stats["replaced"] += n
                continue
            stale = []
            for d in u.get("docs", []):
                c0 = existing.get(X.vec_id(f"{d['key']}_c0"))
                old_n = (c0 or {}).get("n_chunks") or 0
                stale += [X.vec_id(f"{d['key']}_c{i}") for i in range(d["n"], old_n)]
            if stale:
                call("POST", "/points/delete?wait=true", {"points": stale})
                stats["stale_deleted"] += len(stale)
        with open(done_path, "a", encoding="utf-8") as f:
            f.write("".join(u["u"] + "\n" for u in group))

    group, gpts, n_done = [], 0, 0
    stopped, last_log = False, time.time()
    for u in todo:
        group.append(u)
        gpts += len(u.get("points", []))
        if gpts >= GROUP_POINTS or u.get("replace"):
            apply(group)
            n_done += len(group)
            group, gpts = [], 0
            el = time.time() - t0
            if time.time() - last_log > 120 or el > args.max_seconds:
                last_log = time.time()
                log(f"{n_done}/{len(todo)} units, {stats} {stats['embedded'] / max(el, 1):.1f} emb/s")
            if el > args.max_seconds:
                stopped = True
                break
    if group and not stopped:
        apply(group)
        n_done += len(group)
    pool.shutdown()
    log(f"{n_done}/{len(todo)} units in {time.time() - t0:.0f}s: {stats}")
    if stopped:
        log(f"stopped at --max-seconds {args.max_seconds}; the rest of the batch runs next time")
        return 0

    state_path = os.path.join(work, "state.json")
    state = read_json(state_path, {})
    state["cursors"] = header["cursors"]
    if "pdf_split_seen" in header:
        state["pdf_split_seen"] = header["pdf_split_seen"]
    state["last_run"] = {"batch": header["created"], "finished": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                         "units": len(units), "seconds": round(time.time() - t0), **stats}
    write_json(state_path, state)
    os.replace(batch_path, os.path.join(work, "last-batch.ndjson"))
    if os.path.exists(done_path):
        os.remove(done_path)
    log("batch complete, cursors committed")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--work", required=True)
    e.add_argument("--streams", default=",".join(STREAMS))
    e.add_argument("--no-legislation", action="store_true",
                   help="leave legislation for a later run (e.g. while another job rewrites pl_act_text points)")
    e.add_argument("--max-chunks", type=int, default=40000)
    e.add_argument("--seed-pdf-done", default=os.path.expanduser("~/lawrider/pl-vectors/pdf-articles.ndjson.done"),
                   help="first run only: editions vectorize_pdf_articles.py already loaded")
    lo = sub.add_parser("load")
    lo.add_argument("--work", required=True)
    lo.add_argument("--max-seconds", type=int, default=7200)
    a = ap.parse_args()
    return export(a) if a.cmd == "export" else load(a)


if __name__ == "__main__":
    sys.exit(main())
