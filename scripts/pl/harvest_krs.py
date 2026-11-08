#!/usr/bin/env python3
"""Polish KRS register into pl_krs_entities, by enumeration plus daily bulletin.

  --scan        probe numbers 1..--max that have no pl_krs_scan row
  --bulletin    for each day since the last stored bulletin (or --from), read
                /api/Krs/Biuletyn/{day} and drop those numbers' scan rows, so the
                next --scan refetches them

Per number: OdpisAktualny?rejestr=P; on 404 try rejestr=S; on 204 (in P, struck
off) fetch OdpisPelny?rejestr=P, which still carries the history. The worklist
is the database (generate_series anti-join pl_krs_scan), so a killed run is
resumed by running it again, and running it twice is a no-op.

Schema: mcp_backend/src/migrations/249_pl_krs.sql, applied by this script on
start (idempotent), so the load does not wait for a deploy.

Measured 2026-11-07: ~0.2 s per call, no 429 at 60 concurrent; the ministry
says the API has no limits and about 2,000 entries change per day. Highest
number seen in the bulletin: ~1,277,878.

On cthulhu against pg-lawrider:
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/harvest_krs.py --scan --limit 2000
  PL_SSH_HOST= PG_CONTAINER=pg-lawrider python3 scripts/pl/harvest_krs.py --bulletin --scan
"""
import argparse
import datetime as dt
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

API = "https://api-krs.ms.gov.pl/api/krs"
BULLETIN = "https://api-krs.ms.gov.pl/api/Krs/Biuletyn"
MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "249_pl_krs.sql")
WORKERS = int(os.environ.get("WORKERS", "8"))
RATE = float(os.environ.get("RATE", "15"))      # requests per second, all workers
BATCH = int(os.environ.get("BATCH", "500"))
TRIES = int(os.environ.get("TRIES", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "60"))
UA = "lawrider.pl KRS open-data harvester"

ENT_COLS = ["krs", "rejestr", "status", "name", "legal_form", "nip", "regon",
            "voivodeship", "city", "registered_on", "last_entry_on",
            "last_entry_no", "struck_off_on", "is_opp", "odpis_kind", "odpis",
            "source_url", "fetched_at"]
SCAN_COLS = ["krs", "rejestr", "http_p", "http_s", "scanned_at"]

_lock = threading.Lock()
_next = [0.0]
_local = threading.local()
counts = {"numbers": 0, "hits": 0, "struck": 0, "miss": 0, "failed": 0, "calls": 0}
started = time.time()


def throttle():
    with _lock:
        now = time.time()
        wait = _next[0] - now
        _next[0] = max(now, _next[0]) + 1.0 / RATE
    if wait > 0:
        time.sleep(wait)


def session():
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
        s.headers["User-Agent"] = UA
    return s


def get(path):
    """(json or None, http code). 599 = gave up after retries.
    path is relative to API, or a full URL."""
    url = path if path.startswith("https://") else f"{API}/{path}"
    for attempt in range(TRIES):
        throttle()
        try:
            r = session().get(url, timeout=TIMEOUT)
            counts["calls"] += 1
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code in (204, 404):
            return None, r.status_code
        if r.status_code == 200:
            try:
                return r.json(), 200
            except ValueError:
                return None, 901
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(10 * (attempt + 1))
            continue
        return None, r.status_code
    return None, 599


def pl_date(s):
    """dd.mm.yyyy -> yyyy-mm-dd; None on anything else."""
    if not s or len(s) != 10 or s[2] != "." or s[5] != ".":
        return None
    return f"{s[6:]}-{s[3:5]}-{s[:2]}"


def last(v):
    """OdpisPelny wraps every field in a list of versions; take the newest."""
    if isinstance(v, list):
        return v[-1] if v else None
    return v


def field(v, key):
    """Value of key, unwrapping the OdpisPelny {key: value, nrWpisu...} form."""
    v = last(v)
    if isinstance(v, dict) and key in v:
        return v[key]
    return v


def entity_row(num, rejestr, d, kind, url, struck=None):
    struck = kind == "pelny" if struck is None else struck
    o = d.get("odpis") or {}
    head = o.get("naglowekA") or o.get("naglowekP") or {}
    dane = o.get("dane") or {}
    d1 = dane.get("dzial1") or {}
    pod = d1.get("danePodmiotu") or {}
    ids = field(pod.get("identyfikatory"), "identyfikatory") or {}
    sied = field((d1.get("siedzibaIAdres") or {}).get("siedziba"), "siedziba") or {}
    if kind == "pelny":
        wpisy = head.get("wpis") or []
        lastw = wpisy[-1] if wpisy else {}
        last_on, last_no = pl_date(lastw.get("dataWpisu")), lastw.get("numerWpisu")
        first = wpisy[0] if wpisy else {}
        reg_on = pl_date(first.get("dataWpisu"))
        struck_on = last_on if struck else None
    else:
        last_on = pl_date(head.get("dataOstatniegoWpisu"))
        last_no = head.get("numerOstatniegoWpisu")
        reg_on = pl_date(head.get("dataRejestracjiWKRS"))
        struck_on = None
    opp = field(pod.get("czyPosiadaStatusOPP"), "czyPosiadaStatusOPP")
    return (
        f"{num:010d}", rejestr, "struck_off" if struck else "current",
        field(pod.get("nazwa"), "nazwa"), field(pod.get("formaPrawna"), "formaPrawna"),
        ids.get("nip") if isinstance(ids, dict) else None,
        ids.get("regon") if isinstance(ids, dict) else None,
        sied.get("wojewodztwo") if isinstance(sied, dict) else None,
        sied.get("miejscowosc") if isinstance(sied, dict) else None,
        reg_on, last_on, last_no, struck_on,
        opp if isinstance(opp, bool) else None,
        kind, json.dumps(o, ensure_ascii=False), url,
        time.strftime("%Y-%m-%d %H:%M:%S"),
    )


def probe(num):
    """-> (scan row, entity row or None)."""
    k = f"{num:010d}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    d, cp = get(f"OdpisAktualny/{k}?rejestr=P&format=json")
    if cp == 200:
        counts["hits"] += 1
        return (num, "P", 200, None, now), entity_row(
            num, "P", d, "aktualny", f"{API}/OdpisAktualny/{k}?rejestr=P&format=json")
    if cp == 204:
        url = f"{API}/OdpisPelny/{k}?rejestr=P&format=json"
        d, c2 = get(f"OdpisPelny/{k}?rejestr=P&format=json")
        if c2 == 200:
            counts["struck"] += 1
            return (num, "P", 204, None, now), entity_row(num, "P", d, "pelny", url)
        counts["failed"] += 1
        return None, None
    if cp == 901:
        # A few live entities answer OdpisAktualny with 200 and an empty body
        # every time (0000035662, entry dated 2026-10-12); OdpisPelny works.
        url = f"{API}/OdpisPelny/{k}?rejestr=P&format=json"
        d, c2 = get(f"OdpisPelny/{k}?rejestr=P&format=json")
        if c2 == 200:
            counts["hits"] += 1
            return (num, "P", 200, None, now), entity_row(num, "P", d, "pelny", url,
                                                          struck=False)
        counts["failed"] += 1
        return None, None
    if cp != 404:
        counts["failed"] += 1
        return None, None
    d, cs = get(f"OdpisAktualny/{k}?rejestr=S&format=json")
    if cs == 200:
        counts["hits"] += 1
        return (num, "S", 404, 200, now), entity_row(
            num, "S", d, "aktualny", f"{API}/OdpisAktualny/{k}?rejestr=S&format=json")
    if cs == 404:
        counts["miss"] += 1
        return (num, None, 404, 404, now), None
    if cs == 204:
        # Not seen in probing; record it rather than guess at a register.
        counts["miss"] += 1
        return (num, "S", 404, 204, now), None
    counts["failed"] += 1
    return None, None


def log(msg):
    el = int(time.time() - started) or 1
    print(f"[{el:>6}s] {msg} | n={counts['numbers']} hits={counts['hits']} "
          f"struck={counts['struck']} miss={counts['miss']} failed={counts['failed']} "
          f"| {counts['calls'] / el:.1f} req/s", flush=True)


def apply_schema():
    with open(MIGRATION, encoding="utf-8") as f:
        sql = f.read()
    r = subprocess.run(plprod._argv(), input=sql, capture_output=True, text=True,
                       timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")


def do_scan(maxnum, limit):
    done = 0
    while True:
        n = BATCH if not limit else min(BATCH, limit - done)
        if n <= 0:
            break
        work = [int(r[0]) for r in plprod.rows_of(
            f"SELECT g FROM generate_series(1, {maxnum}) g "
            "LEFT JOIN pl_krs_scan s ON s.krs = g WHERE s.krs IS NULL "
            f"ORDER BY g LIMIT {n}")]
        if not work:
            log("worklist empty, done")
            break
        scans, ents = [], []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for srow, erow in pool.map(probe, work):
                if srow:
                    scans.append(srow)
                if erow:
                    ents.append(erow)
        # Entities first: the scan row is what marks a number done, so a crash
        # between the two writes must leave the number on the worklist.
        if ents:
            plprod.upsert_rows("pl_krs_entities", ENT_COLS, ents, ["krs"],
                               prefer_new=False)
        if scans:
            plprod.upsert_rows("pl_krs_scan", SCAN_COLS, scans, ["krs"],
                               prefer_new=False)
        counts["numbers"] += len(work)
        done += len(work)
        log(f"batch {work[0]}..{work[-1]}")
        if not scans:
            print("FATAL: a whole batch failed; stopping instead of looping",
                  file=sys.stderr)
            return 1
        if limit and done >= limit:
            break
    return 0


def do_bulletin(start):
    if start is None:
        v = plprod.scalar("SELECT max(day) + 1 FROM pl_krs_bulletin")
        if not v:
            raise SystemExit("no bulletin stored yet: pass --from YYYY-MM-DD")
        start = dt.date.fromisoformat(v)
    today = dt.date.today()
    day = start
    while day < today:      # today's bulletin is still filling up
        d, code = get(f"{BULLETIN}/{day.isoformat()}")
        if code not in (200, 204, 404):
            print(f"bulletin {day}: HTTP {code}, stopping", file=sys.stderr)
            return 1
        nums = sorted({int(x) for x in (d or [])})
        if nums:
            for i in range(0, len(nums), 5000):
                chunk = ",".join(str(x) for x in nums[i:i + 5000])
                plprod.psql(f"DELETE FROM pl_krs_scan WHERE krs IN ({chunk})")
        plprod.upsert_rows("pl_krs_bulletin", ["day", "entries", "distinct_krs"],
                           [(day.isoformat(), len(d or []), len(nums))], ["day"],
                           prefer_new=False)
        print(f"bulletin {day}: {len(d or [])} entries, {len(nums)} numbers requeued",
              flush=True)
        day += dt.timedelta(days=1)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--bulletin", action="store_true")
    ap.add_argument("--from", dest="start", type=dt.date.fromisoformat)
    ap.add_argument("--max", type=int, default=1_290_000)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if not (a.scan or a.bulletin):
        ap.error("pass --scan and/or --bulletin")
    apply_schema()
    rc = 0
    if a.bulletin:
        rc = do_bulletin(a.start)
    if rc == 0 and a.scan:
        rc = do_scan(a.max, a.limit)
    log("finished")
    return rc


if __name__ == "__main__":
    sys.exit(main())
