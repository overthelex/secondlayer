#!/usr/bin/env python3
"""Polish Sejm API into pl_sejm_objects (migration 250).

  python3 scripts/pl/harvest_sejm.py --terms 10 9          # full, then cheap re-runs
  python3 scripts/pl/harvest_sejm.py --terms 10 --kinds voting

Each run re-reads every list (a few hundred requests per term) and fetches a
detail only when it is missing or its changeDate moved, so the same command is
both the initial load and the incremental sync. Detail fetches:

  process  /termN/processes/{num}            stages; changeDate drives refetch
  voting   /termN/votings/{sitting}/{num}    per-MP votes; immutable once held

Measured 2026-11-07, term 10: 499 MPs, 40 committees, 3,571 prints,
~1,791 processes, ~1,377 bills, 89 sittings, 5,298 votings (~72 KB each with
votes), ~20,935 interpellations, ~4,188 written questions. Lists that page take
limit<=500&offset; prints, MP, committees, proceedings come whole.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

API = "https://api.sejm.gov.pl/sejm"
MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "250_pl_sejm.sql")
WORKERS = int(os.environ.get("WORKERS", "4"))
RATE = float(os.environ.get("RATE", "8"))
TRIES = int(os.environ.get("TRIES", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "120"))
UA = "lawrider.pl Sejm open-data harvester"
COLS = ["kind", "term", "key", "title", "changed_at", "payload", "source_url",
        "fetched_at"]
ALL_KINDS = ["mp", "committee", "print", "proceeding", "bill", "process",
             "interpellation", "written_question", "voting"]

_lock = threading.Lock()
_next = [0.0]
_local = threading.local()
stats = {"calls": 0, "rows": 0, "failed": 0}
started = time.time()


def throttle():
    with _lock:
        now = time.time()
        wait = _next[0] - now
        _next[0] = max(now, _next[0]) + 1.0 / RATE
    if wait > 0:
        time.sleep(wait)


def get(path):
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
        s.headers["User-Agent"] = UA
    url = f"{API}/{path}"
    for attempt in range(TRIES):
        throttle()
        try:
            r = s.get(url, timeout=TIMEOUT)
            stats["calls"] += 1
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError:
                return None
        if r.status_code == 404:
            return None
        time.sleep(5 * (attempt + 1))
    stats["failed"] += 1
    return None


def paged(path):
    out, off = [], 0
    sep = "&" if "?" in path else "?"
    while True:
        page = get(f"{path}{sep}limit=500&offset={off}")
        if page is None:
            raise RuntimeError(f"{path} offset={off} failed")
        out += page
        if len(page) < 500:
            return out
        off += 500


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def row(kind, term, key, title, changed, payload, path):
    return (kind, term, str(key), title, changed,
            json.dumps(payload, ensure_ascii=False), f"{API}/{path}", now())


def write(rows):
    # Some lists repeat a key (proceedings carries more than one entry per
    # number). One upsert batch cannot touch a row twice, so keep the last.
    uniq = {(r[0], r[1], r[2]): r for r in rows}
    if len(uniq) != len(rows):
        print(f"  {len(rows) - len(uniq)} duplicate keys in {rows[0][0]} "
              f"term {rows[0][1]}, kept the last", flush=True)
    rows = list(uniq.values())
    if rows:
        plprod.upsert_rows("pl_sejm_objects", COLS, rows, ["kind", "term", "key"],
                           prefer_new=False)
        stats["rows"] += len(rows)


def held(kind, term):
    """key -> changed_at text, for what we already store."""
    return {r[0]: r[1] for r in plprod.rows_of(
        "SELECT key, coalesce(changed_at::text, '') FROM pl_sejm_objects "
        f"WHERE kind = '{kind}' AND term = {term}")}


def log(msg):
    el = int(time.time() - started) or 1
    print(f"[{el:>6}s] {msg} | rows={stats['rows']} calls={stats['calls']} "
          f"failed={stats['failed']} | {stats['calls'] / el:.1f} req/s", flush=True)


def simple_list(kind, term, path, keyf, titlef, changedf=lambda x: None, pages=False):
    items = paged(f"term{term}/{path}") if pages else get(f"term{term}/{path}")
    if items is None:
        raise RuntimeError(f"term{term}/{path} failed")
    write([row(kind, term, keyf(i), titlef(i), changedf(i), i, f"term{term}/{path}")
           for i in items])
    log(f"term{term} {kind}: {len(items)}")
    return items


def processes(term):
    items = paged(f"term{term}/processes")
    have = held("process", term)
    # changed_at is stored as timestamptz text; compare on the date-time prefix
    todo = [i for i in items
            if str(i.get("number")) not in have
            or not have[str(i["number"])].startswith(
                (i.get("changeDate") or "").replace("T", " ")[:19])]

    def one(i):
        p = f"term{term}/processes/{i['number']}"
        d = get(p)
        return row("process", term, i["number"], i.get("title"),
                   (d or i).get("changeDate"), d, p) if d else None

    for k in range(0, len(todo), 200):
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            write([r for r in pool.map(one, todo[k:k + 200]) if r])
        log(f"term{term} process details {k + len(todo[k:k + 200])}/{len(todo)}")
    log(f"term{term} process: {len(items)} listed, {len(todo)} fetched")


def votings(term):
    sittings = get(f"term{term}/votings") or []
    have = set(held("voting", term))
    for s in sittings:
        sit = s.get("proceeding")
        lst = get(f"term{term}/votings/{sit}") or []
        todo = [v for v in lst if f"{sit}/{v['votingNumber']}" not in have]

        def one(v):
            p = f"term{term}/votings/{sit}/{v['votingNumber']}"
            d = get(p)
            return row("voting", term, f"{sit}/{v['votingNumber']}", d.get("title"),
                       None, d, p) if d else None

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            write([r for r in pool.map(one, todo) if r])
        if todo:
            log(f"term{term} sitting {sit}: {len(todo)} votings")
    log(f"term{term} voting: done")


def run_term(term, kinds):
    if "mp" in kinds:
        simple_list("mp", term, "MP", lambda i: i["id"],
                    lambda i: i.get("firstLastName"))
    if "committee" in kinds:
        simple_list("committee", term, "committees", lambda i: i["code"],
                    lambda i: i.get("name"))
    if "print" in kinds:
        simple_list("print", term, "prints", lambda i: i["number"],
                    lambda i: i.get("title"), lambda i: i.get("changeDate"))
    if "proceeding" in kinds:
        # number 0 is shared by every assembly and planned sitting (20 of them
        # in term 10), so those are keyed by their first date instead.
        simple_list("proceeding", term, "proceedings",
                    lambda i: i["number"] or f"0/{(i.get('dates') or ['?'])[0]}",
                    lambda i: i.get("title"))
    if "bill" in kinds:
        simple_list("bill", term, "bills", lambda i: i["number"],
                    lambda i: i.get("title"), pages=True)
    if "interpellation" in kinds:
        simple_list("interpellation", term, "interpellations", lambda i: i["num"],
                    lambda i: i.get("title"), lambda i: i.get("lastModified"),
                    pages=True)
    if "written_question" in kinds:
        simple_list("written_question", term, "writtenQuestions", lambda i: i["num"],
                    lambda i: i.get("title"), lambda i: i.get("lastModified"),
                    pages=True)
    if "process" in kinds:
        processes(term)
    if "voting" in kinds:
        votings(term)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terms", type=int, nargs="+", default=[10])
    ap.add_argument("--kinds", nargs="+", default=ALL_KINDS, choices=ALL_KINDS)
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True,
                           text=True, timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    for t in a.terms:
        run_term(t, a.kinds)
    log("finished")
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
