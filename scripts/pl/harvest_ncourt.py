#!/usr/bin/env python3
"""Polish common-court judgments from the ncourt-api feed (migration 254).

  python3 scripts/pl/harvest_ncourt.py --index          # list the feed
  python3 scripts/pl/harvest_ncourt.py --report         # what would be loaded
  python3 scripts/pl/harvest_ncourt.py --load --limit 20
  python3 scripts/pl/harvest_ncourt.py --index --load   # daily

SAOS mirrors this feed and stores each judgment's feed id in source_url, so only
what SAOS and the HF import lack is loaded; for the rest pl_ncourt_index just
records that the feed has it.

How the API behaves (measured 2026-11-09, undocumented): deep offsets are slow
(offset 100,000 takes 25 s, 300,000 times out), and the order is not stable
between pages (a 3,443-row month came back as 2,517 distinct ids). So the listing
never pages: a window whose total exceeds one 1000-row response is halved.
lastUpdateFrom/To catches revisions.

SAOS stored the feed under three hosts over the years, so the join is on the id
after "id=", not on the URL.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import lxml.etree as ET
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plprod  # noqa: E402

API = "https://apiorzeczenia.wroclaw.sa.gov.pl/ncourt-api"
MIGRATION = os.path.join(HERE, "..", "..", "mcp_backend", "src", "migrations",
                         "254_pl_ncourt.sql")
WORKERS = int(os.environ.get("WORKERS", "4"))
PASSES = 6
RATE = float(os.environ.get("RATE", "8"))
START = dt.date(2012, 1, 1)
UA = "lawrider.pl ncourt open-data harvester"
IDX_COLS = ["id", "signature", "decided_on", "published_at", "last_update", "court_id",
            "department_id", "types"]
DEC_COLS = ["id", "source", "court_type", "case_number", "decision_type", "decision_date",
            "judge", "judges", "keywords", "legal_bases", "referenced_regulations",
            "full_text", "source_url", "metadata_json"]
TYPES = {"SENTENCE": "SENTENCE", "DECISION": "DECISION", "REASON": "REASONS",
         "REGULATION": "REGULATION"}
TITLE = re.compile(r"^(Przewodnicz\S*:?\s+)?(sędzi[ae]|SSA|SSO|SSR|SR|SO|SA)\s+"
                   r"(sądu\s+\S+\s+)?(\(?del\.\)?\s+)?", re.I)

_lock = threading.Lock()
_next = [0.0]
_local = threading.local()
counts = {"loaded": 0, "empty": 0, "failed": 0}
started = time.time()


def get(path, params):
    s = getattr(_local, "s", None)
    if s is None:
        s = _local.s = requests.Session()
        s.headers["User-Agent"] = UA
    for attempt in range(5):
        with _lock:
            now = time.time()
            wait = _next[0] - now
            _next[0] = max(now, _next[0]) + 1.0 / RATE
        if wait > 0:
            time.sleep(wait)
        try:
            r = s.get(f"{API}/{path}", params=params, timeout=120)
        except requests.RequestException:
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 200:
            return r.content, 200
        if r.status_code == 404:
            return None, 404
        time.sleep(10 * (attempt + 1))
    return None, 599


def txt(el, tag):
    v = el.findtext(tag)
    return v.strip() if v and v.strip() else None


def stamp(v):
    """'2020-01-23 01:00:00.0 CET' -> ISO with the offset Postgres understands."""
    if not v:
        return None
    m = re.match(r"(\S+ \d\d:\d\d:\d\d)\.\d+ (CEST|CET)", v)
    return f"{m.group(1)}{'+02' if m.group(2) == 'CEST' else '+01'}" if m else None


def page(prefix, lo, hi, offset=0):
    """(total, rows) of one response for [lo, hi] on the {prefix}From/To filter."""
    body, code = get("judgements", {f"{prefix}From": lo.isoformat(),
                                    f"{prefix}To": hi.isoformat(),
                                    "limit": 1000, "offset": offset})
    if code != 200:
        raise RuntimeError(f"listing {prefix} {lo}..{hi}: HTTP {code}")
    root = ET.fromstring(body, ET.XMLParser(recover=True, huge_tree=True))
    rows = [(txt(j, "id"), txt(j, "signature"), (txt(j, "date") or "")[:10] or None,
             stamp(txt(j, "publicationDate")), stamp(txt(j, "lastUpdate")),
             txt(j, "courtId"), txt(j, "departmentId"), txt(j, "type"))
            for j in root.findall("judgement")]
    return int(root.get("total") or 0), rows


def full_day(prefix, lo, hi, total, first):
    """A day holding more than one response. The filter ignores the time of
    day, so it cannot be split further: page through it. Page order is not
    stable, so repeat the walk until every record has been seen."""
    seen = {r[0]: r for r in first}
    for _ in range(PASSES):
        for off in range(0, total, 1000):
            seen.update((r[0], r) for r in page(prefix, lo, hi, off)[1])
        if len(seen) >= total:
            break
    if len(seen) < total:
        print(f"WARNING {prefix} {lo}..{hi}: {total} records, got {len(seen)}",
              file=sys.stderr, flush=True)
    return list(seen.values())


def listing(prefix, lo, hi):
    """Every record in [lo, hi]. Windows share their boundary day; the upsert
    makes that harmless."""
    total, rows = page(prefix, lo, hi)
    if total <= len(rows):
        return rows
    if hi - lo <= dt.timedelta(days=1):
        return full_day(prefix, lo, hi, total, rows)
    mid = lo + (hi - lo) / 2
    return listing(prefix, lo, mid) + listing(prefix, mid, hi)


def write_index(rows):
    uniq = {r[0]: r for r in rows if r[0]}
    if uniq:
        plprod.upsert_rows("pl_ncourt_index", IDX_COLS, list(uniq.values()), ["id"],
                           prefer_new=False, batch=2000)
    return len(uniq)


def do_days(days):
    """Re-list single days, without touching the progress row."""
    for d in days:
        lo = dt.date.fromisoformat(d)
        n = write_index(listing("publicationDate", lo, lo + dt.timedelta(days=1)))
        print(f"index day {d}: {n} rows", flush=True)


def do_index():
    v = plprod.scalar("SELECT listed_to FROM pl_ncourt_progress")
    today = dt.date.today()
    if v:
        # daily path: revisions and new publications since two days before
        since = dt.date.fromisoformat(v) - dt.timedelta(days=2)
        tomorrow = today + dt.timedelta(days=1)
        n = write_index(listing("lastUpdate", since, tomorrow))
        n += write_index(listing("publicationDate", since, tomorrow))
        print(f"index delta since {since}: {n} rows", flush=True)
    else:
        lo = START
        n = 0
        while lo <= today:
            hi = lo + dt.timedelta(days=30)
            n += write_index(listing("publicationDate", lo, hi))
            print(f"index {lo}..{hi}: {n} rows", flush=True)
            lo = hi
    plprod.psql(f"INSERT INTO pl_ncourt_progress (id, listed_to) VALUES (1, '{today}') "
                "ON CONFLICT (id) DO UPDATE SET listed_to = EXCLUDED.listed_to, updated_at = now()")


WORK = """
FROM pl_ncourt_index i
LEFT JOIN pl_court_decisions s ON s.source = 'saos'
     AND substring(s.source_url from 'id=(.*)$') = i.id
LEFT JOIN pl_court_decisions h ON h.source = 'hf-pl-court-raw'
     AND h.case_number = i.signature AND h.decision_date = i.decided_on
WHERE s.id IS NULL AND h.id IS NULL
  AND i.loaded_update IS DISTINCT FROM i.last_update
  AND coalesce(i.fetch_status, 0) NOT IN (204)
"""


def block_text(body):
    root = ET.fromstring(body, ET.XMLParser(recover=True, huge_tree=True))
    lines = []
    for el in root.iter("xName", "xText"):
        parent = el.getparent()
        if parent is not None and parent.tag in ("xPart", "xText"):
            continue
        t = re.sub(r"[ \t\r\f\v\u00a0]+", " ", "".join(el.itertext())).strip()
        if t:
            lines.append(t)
    return "\n".join(lines).replace("\x00", "")


def name(v):
    return TITLE.sub("", v.strip()).strip() if v else None


def one(row):
    jid, last = row
    url = f"{API}/judgement/details?id={jid}"
    body, code = get("judgement/details", {"id": jid})
    if code != 200:
        counts["failed"] += 1
        return (jid, last, code), None
    d = ET.fromstring(body, ET.XMLParser(recover=True, huge_tree=True))
    cont, c2 = get("judgement/content", {"id": jid})
    if c2 != 200:
        counts["failed"] += 1
        return (jid, last, c2), None
    text = block_text(cont) if cont else ""
    if not text:
        counts["empty"] += 1
        return (jid, last, 204), None
    chair = name(txt(d, "chairman"))
    judges = [name(j.text) for j in d.findall("judges/judge") if j.text]
    jj = [{"name": n, "function": None, "specialRoles": ["PRESIDING_JUDGE"] if n == chair else []}
          for n in judges]
    types = [t.strip() for t in (txt(d, "type") or "").split(",") if t.strip()]
    meta = {"feedId": jid, "courtId": txt(d, "courtId"), "departmentId": txt(d, "departmentId"),
            "types": types, "publicationDate": txt(d, "publicationDate"),
            "lastUpdate": txt(d, "dateOfLastUpdate"), "recorder": txt(d, "recorder"),
            "reviser": txt(d, "reviser"), "publisher": txt(d, "publisher"),
            "decision": txt(d, "decision"), "chairmanRaw": txt(d, "chairman")}

    def arr(path):
        v = [(x.text or "").strip().replace("\\", "\\\\").replace('"', '\\"')
             for x in d.findall(path)]
        return "{" + ",".join(f'"{x}"' for x in v if x) + "}"

    refs = [{"text": (x.text or "").strip()} for x in d.findall("references/reference") if x.text]
    rec = (f"ncourt-{jid}", "ncourt", "COMMON", txt(d, "signature"),
           TYPES.get(types[0]) if types else None, (txt(d, "date") or "")[:10] or None,
           chair, json.dumps(jj, ensure_ascii=False), arr("themePhrases/themePhrase"),
           arr("legalBases/legalBasis"), json.dumps(refs, ensure_ascii=False), text, url,
           json.dumps(meta, ensure_ascii=False))
    counts["loaded"] += 1
    return (jid, last, 200), rec


def do_load(limit):
    q = "SELECT i.id, i.last_update " + WORK + (f" LIMIT {limit}" if limit else "")
    work = list(plprod.rows_of(q))
    print(f"{len(work)} to load", flush=True)
    for i in range(0, len(work), 200):
        marks, recs = [], []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for m, r in pool.map(one, work[i:i + 200]):
                marks.append(m)
                if r:
                    recs.append(r)
        if recs:
            plprod.upsert_rows("pl_court_decisions", DEC_COLS, recs, ["id"],
                               prefer_new=False, batch=100)
        ok = [m for m in marks if m[2] in (200, 204)]
        if ok:
            vals = ",".join("('%s','%s'::timestamptz,%d)" % (m[0].replace("'", "''"), m[1], m[2])
                            for m in ok)
            plprod.psql("UPDATE pl_ncourt_index i SET loaded_update = v.u, fetch_status = v.s "
                        f"FROM (VALUES {vals}) v(id,u,s) WHERE i.id = v.id")
        print(f"[{int(time.time() - started):>6}s] {min(i + 200, len(work))}/{len(work)} {counts}",
              flush=True)
    return 1 if counts["failed"] > max(5, len(work) // 100) else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", action="store_true")
    ap.add_argument("--load", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--days", nargs="+", help="re-list these publication days")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    with open(MIGRATION, encoding="utf-8") as f:
        r = subprocess.run(plprod._argv(), input=f.read(), capture_output=True, text=True,
                           timeout=plprod.PSQL_TIMEOUT)
    if r.returncode != 0:
        raise SystemExit(f"schema failed: {r.stderr.strip()[:600]}")
    if a.index:
        do_index()
    if a.days:
        do_days(a.days)
    if a.report:
        print("indexed", plprod.scalar("SELECT count(*) FROM pl_ncourt_index"))
        print("to load", plprod.scalar("SELECT count(*) " + WORK))
        print("by year", plprod.psql(
            "SELECT string_agg(y || ':' || n, ' ' ORDER BY y) FROM (SELECT "
            "extract(year from i.decided_on)::int y, count(*) n " + WORK + " GROUP BY 1) t"))
    rc = 0
    if a.load:
        rc = do_load(a.limit)
    return rc


if __name__ == "__main__":
    sys.exit(main())
