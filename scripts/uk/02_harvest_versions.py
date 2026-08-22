#!/usr/bin/env python3
"""Stage 2: fill uk_legislation_versions and the rest of uk_legislation.

For each item in the register, read its metadata block and the list of
point-in-time versions the publisher itself declares. Nothing is diffed and
nothing is inferred: legislation.gov.uk emits one
<atom:link rel="http://purl.org/dc/terms/hasVersion"> per available version.

Why /contents/data.xml and not /data.xml
----------------------------------------
Measured 2026-08-22, same metadata block, an order of magnitude cheaper:

  ukpga/2006/46   full 14,837 KB   contents 1,217 KB
  uksi/1998/1833  full  1,103 KB   contents    46 KB
  ukpga/1998/42   full    299 KB   contents    65 KB

Both carry ukm:DocumentStatus, dct:valid, the hasVersion links and
ukm:UnappliedEffects. Provision text is stage 3's problem.

Worklist comes from the database, not a checkpoint file (the pattern in
scripts/nl/harvest_bwb_texts.py): an item is outstanding while its
document_status is NULL, so the job is resumable and idempotent by construction.

Raw XML is kept gzipped on disk so that fixing the parser later costs no re-crawl
(the lesson from scripts/uae/leg/fetch_modifications.py).

Rate: the real ceiling is 1,500 requests / 5 minutes per IP, i.e. 5/s. The
developer docs say 3,000 / 5 minutes; the server disagrees, and the server wins.
Running at 9/s got us 429s whose body states the 1,500 figure verbatim, and
because the retry path absorbs 429 as backpressure the throttling never showed
up in the failure counters: throughput just sat at 3.3 items/s no matter how
many threads were used. Default here is 4/s, leaving headroom for retries.
More than that needs Legislation@nationalarchives.gov.uk.

Usage:
  python3 02_harvest_versions.py --limit 200          # smoke test
  python3 02_harvest_versions.py --types ukpga
  python3 02_harvest_versions.py                      # everything outstanding
"""

import argparse
import gzip
import os
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import psycopg2
import requests
from psycopg2.extras import execute_values

BASE = "https://www.legislation.gov.uk"
UA = os.environ.get(
    "UK_USER_AGENT",
    "SecondLayer-LEXAI/1.0 (+https://legal.org.ua; legal research; "
    "contact mcvovkes@gmail.com)",
)
DB_URL = os.environ.get("DATABASE_URL")
RAW_DIR = os.environ.get("UK_RAW_DIR", "/home/ubuntu/opendata/uk/legislation/contents")

ATOM = "{http://www.w3.org/2005/Atom}"
UKM = "{http://www.legislation.gov.uk/namespaces/metadata}"
DC = "{http://purl.org/dc/elements/1.1/}"
DCT = "{http://purl.org/dc/terms/}"

HASVERSION = "http://purl.org/dc/terms/hasVersion"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Limiter:
    """One global token gate. Threads share it so the process, not each thread,
    respects the per-IP ceiling."""

    def __init__(self, rate):
        self.interval = 1.0 / rate
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = time.time()
            if self.next_at < now:
                self.next_at = now
            delay = self.next_at - now
            self.next_at += self.interval
        if delay > 0:
            time.sleep(delay)


def fetch(session, limiter, url, tries=4):
    """Returns (text, verdict). Verdict follows the npa.* convention: HTTP status,
    or a code above the HTTP range for a fetch that succeeded but is unusable.
      900 = empty body   901 = served 200 but not the expected XML
    """
    for attempt in range(tries):
        limiter.wait()
        try:
            # Separate connect and read timeouts. A single large timeout parks a
            # thread on a wedged socket for its whole duration: observed on prod
            # with all 32 workers sitting in do_select while the machine was idle
            # and a fresh curl to the same host answered in 0.07s. Failing fast and
            # retrying beats waiting on a connection that will never deliver.
            r = session.get(url, timeout=(10, 30))
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200:
            body = r.text
            if not body.strip():
                return None, 900
            if "<Legislation" not in body[:4000]:
                return None, 901
            return body, 200
        if r.status_code in (403, 429, 503):
            back = int(r.headers.get("Retry-After") or 30 * (attempt + 1))
            time.sleep(back)
            continue
        if r.status_code == 404:
            return None, 404
        time.sleep(2 * (attempt + 1))
    return None, 599


def parse_contents(xml_text, leg_id):
    root = ET.fromstring(xml_text)
    meta = root.find(f".//{UKM}Metadata")
    if meta is None:
        return None

    def ukm_attr(tag, attr="Date"):
        el = meta.find(f".//{UKM}{tag}")
        return el.get(attr) if el is not None else None

    def d(v):
        return v if v and DATE_RE.match(v) else None

    status_el = meta.find(f".//{UKM}DocumentStatus")
    title = (meta.findtext(f"{DC}title") or "").strip() or None
    long_title = (meta.findtext(f"{DC}description") or "").strip() or None
    if long_title:
        long_title = re.sub(r"\s+", " ", long_title)

    versions = []
    for link in root.iter(f"{ATOM}link"):
        if link.get("rel") != HASVERSION:
            continue
        label = (link.get("title") or "").strip() or None
        href = link.get("href") or None
        if href and href.startswith("http://"):
            href = "https://" + href[len("http://"):]
        versions.append((label, href))

    valid = d(root.findtext(f".//{DCT}valid") or meta.findtext(f".//{DCT}valid"))

    return {
        "id": leg_id,
        "title": title,
        "long_title": long_title,
        "document_status": status_el.get("Value") if status_el is not None else None,
        "extent": root.get("RestrictExtent"),
        "enactment_date": d(ukm_attr("EnactmentDate")),
        "made_date": d(ukm_attr("MadeDate")),
        "coming_into_force": d(ukm_attr("ComingIntoForce")),
        "valid_date": valid,
        "restrict_start_date": d(root.get("RestrictStartDate")),
        "unapplied_effects": len(list(root.iter(f"{UKM}UnappliedEffect"))),
        "versions": versions,
    }


UPD_ITEM = """
UPDATE uk_legislation AS t SET
    title               = COALESCE(v.title::text, t.title),
    long_title          = COALESCE(v.long_title::text, t.long_title),
    document_status     = COALESCE(v.document_status::text, t.document_status),
    extent              = COALESCE(v.extent::text, t.extent),
    enactment_date      = COALESCE(v.enactment_date::date, t.enactment_date),
    made_date           = COALESCE(v.made_date::date, t.made_date),
    coming_into_force   = COALESCE(v.coming_into_force::date, t.coming_into_force),
    valid_date          = COALESCE(v.valid_date::date, t.valid_date),
    restrict_start_date = COALESCE(v.restrict_start_date::date, t.restrict_start_date),
    unapplied_effects   = v.unapplied_effects::int,
    version_count       = v.version_count::int,
    first_version       = v.first_version::date,
    last_version        = v.last_version::date,
    updated_at          = now()
FROM (VALUES %s) AS v(id, title, long_title, document_status, extent, enactment_date,
                      made_date, coming_into_force, valid_date, restrict_start_date,
                      unapplied_effects, version_count, first_version, last_version)
WHERE t.id = v.id::text
"""

INS_VER = """
INSERT INTO uk_legislation_versions
    (leg_id, valid_from, version_label, version_uri, is_current, http_status, fetched_at)
SELECT v.leg_id::text, v.valid_from::date, v.version_label::text, v.version_uri::text,
       v.is_current::boolean, 200, now()
  FROM (VALUES %s) AS v(leg_id, valid_from, version_label, version_uri, is_current)
ON CONFLICT (leg_id, valid_from) DO UPDATE SET
    version_label = EXCLUDED.version_label,
    version_uri   = EXCLUDED.version_uri,
    is_current    = EXCLUDED.is_current
"""

# A fetch that failed still has to be recorded, otherwise the worklist hands the
# same dead item back for ever.
MARK_BAD = """
UPDATE uk_legislation SET document_status = %s, updated_at = now() WHERE id = %s
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--rate", type=float, default=float(os.environ.get("UK_RATE", "4")))
    # 8 is ample: at the real 5/s ceiling and ~0.2s response times the pool is
    # never the constraint. An earlier reading that 32 threads were faster was an
    # artefact of measuring during a throttled window.
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--batch", type=int, default=200)
    ap.add_argument("--chunk", type=int, default=4000,
                    help="worklist block size handed to the pool at a time")
    ap.add_argument("--no-raw", action="store_true")
    args = ap.parse_args()

    if not DB_URL:
        sys.exit("DATABASE_URL is required")

    conn = psycopg2.connect(DB_URL)
    # This database sets idle_in_transaction_session_timeout = 1min. Reading the
    # worklist opens a transaction that would then sit idle through the first
    # network fetches, and the server kills the connection. Autocommit keeps every
    # statement self-contained so no transaction is ever held across a fetch.
    conn.autocommit = True
    cur = conn.cursor()
    q = "SELECT id, leg_type FROM uk_legislation WHERE document_status IS NULL"
    params = []
    if args.types:
        q += " AND leg_type = ANY(%s)"
        params.append([t.strip() for t in args.types.split(",")])
    q += " ORDER BY id"
    if args.limit:
        q += f" LIMIT {int(args.limit)}"
    cur.execute(q, params)
    work = cur.fetchall()
    print(f"outstanding items: {len(work)}", flush=True)
    if not work:
        return

    limiter = Limiter(args.rate)
    local = threading.local()
    lock = threading.Lock()
    stats = {"ok": 0, "versions": 0, "failed": 0, "no_meta": 0}
    by_status = {}

    def session():
        if not hasattr(local, "s"):
            local.s = requests.Session()
            local.s.headers["User-Agent"] = UA
        return local.s

    def one(item):
        leg_id, leg_type = item
        url = f"{BASE}/{leg_id}/contents/data.xml"
        body, verdict = fetch(session(), limiter, url)
        if body is None:
            return leg_id, None, verdict
        if not args.no_raw:
            path = os.path.join(RAW_DIR, leg_id + ".xml.gz")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8") as fh:
                fh.write(body)
        try:
            rec = parse_contents(body, leg_id)
        except ET.ParseError:
            return leg_id, None, 902
        if rec is None:
            return leg_id, None, 903
        return leg_id, rec, 200

    items_batch, vers_batch = [], []

    def flush():
        if items_batch:
            execute_values(cur, UPD_ITEM, items_batch, page_size=len(items_batch))
        if vers_batch:
            execute_values(cur, INS_VER, vers_batch, page_size=len(vers_batch))
        conn.commit()
        items_batch.clear()
        vers_batch.clear()

    t0 = time.time()
    done = 0

    # Feed the pool in blocks rather than handing it the whole worklist. Measured:
    # the same code over a 5k slice runs at 8.0 items/s, and over the full 147k
    # worklist at 2.5, because ThreadPoolExecutor.map materialises every future up
    # front. Chunking keeps the queue the size the fast configuration had.
    def chunks(seq, n):
        for i in range(0, len(seq), n):
            yield seq[i:i + n]

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        for block in chunks(work, args.chunk):
            for leg_id, rec, verdict in pool.map(one, block):
                done += 1
                if rec is None:
                    stats["failed"] += 1
                    by_status[verdict] = by_status.get(verdict, 0) + 1
                    with lock:
                        cur.execute(MARK_BAD, (f"fetch-{verdict}", leg_id))
                else:
                    stats["ok"] += 1
                    vers = [(lbl, href) for lbl, href in rec["versions"]
                            if lbl and DATE_RE.match(lbl)]
                    dates = sorted(lbl for lbl, _ in vers)
                    current = rec["valid_date"]
                    for lbl, href in vers:
                        vers_batch.append((rec["id"], lbl, lbl, href, lbl == current))
                    # 'enacted' / 'made' / 'prospective' carry no date of their own;
                    # they are reachable from the item URI and are not point-in-time
                    # rows.
                    stats["versions"] += len(vers)
                    items_batch.append((
                        rec["id"], rec["title"], rec["long_title"],
                        rec["document_status"], rec["extent"], rec["enactment_date"],
                        rec["made_date"], rec["coming_into_force"], rec["valid_date"],
                        rec["restrict_start_date"], rec["unapplied_effects"],
                        len(vers), dates[0] if dates else None,
                        dates[-1] if dates else None,
                    ))
                if len(items_batch) >= args.batch or len(vers_batch) >= args.batch * 10:
                    with lock:
                        flush()
                if done % 2000 == 0:
                    el = time.time() - t0
                    print(f"  {done}/{len(work)} ok={stats['ok']} "
                          f"failed={stats['failed']} versions={stats['versions']} "
                          f"{done / el:.1f} items/s", flush=True)
    with lock:
        flush()

    print("\n=== summary ===")
    for k, v in stats.items():
        print(f"  {k:10s} {v}")
    if by_status:
        print("  failure verdicts:")
        for k, v in sorted(by_status.items(), key=lambda x: -x[1]):
            print(f"    {k}: {v}")

    # valid_to is derivable, so it is derived once here rather than guessed per row.
    print("\nderiving valid_to ...", flush=True)
    cur.execute("""
        UPDATE uk_legislation_versions v SET valid_to = n.next_from - 1
          FROM (SELECT leg_id, valid_from,
                       lead(valid_from) OVER (PARTITION BY leg_id ORDER BY valid_from)
                         AS next_from
                  FROM uk_legislation_versions) n
         WHERE v.leg_id = n.leg_id AND v.valid_from = n.valid_from
           AND n.next_from IS NOT NULL
           AND v.valid_to IS DISTINCT FROM n.next_from - 1
    """)
    print(f"  valid_to set on {cur.rowcount} rows")
    conn.commit()
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
