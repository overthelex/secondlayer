#!/usr/bin/env python3
"""Stage 3: fetch the current version of each act and load its provisions.

Runs after stage 2, which fills document_status and the version list. This stage
fetches /{id}/data.xml once per item, which is the expensive part of the whole
pipeline, and splits it into one row per provision.

Volume, measured 2026-08-22 rather than estimated: ukpga averages ~1.3 MB per act
(4.2 MB seen), uksi ~156 KB (median ~37 KB). Across ~158K items that is roughly
50 GB for one version each. Fetching every point-in-time version at whole-act
level is out of the question: ukpga/2006/46 alone declares 202 versions at 15 MB
each. Historical text, when it is wanted, is fetched per provision instead
(a single dated section is ~35 KB).

Provision model
---------------
Every provision is a CLML <P1> carrying a DocumentURI:

    .../ukpga/1998/42/section/1
    .../ukpga/1998/42/schedule/1/part/I/chapter/1/paragraph/1

so type, label, schedule, part and chapter all come from that one path and no
wrapper state has to be tracked while walking. Rows are keyed on
(leg_id, valid_from, ord) and not on the label, because Schedules restart
numbering and an Act routinely holds several "paragraph 1".

Usage:
  python3 03_harvest_texts.py --limit 50            # smoke test
  python3 03_harvest_texts.py --types ukpga
  python3 03_harvest_texts.py
"""

import argparse
import gzip
import itertools
import hashlib
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
RAW_DIR = os.environ.get("UK_TEXT_RAW_DIR", "/home/ubuntu/opendata/uk/legislation/full")

L = "{http://www.legislation.gov.uk/namespaces/legislation}"

BLOCK_TAGS = {f"{L}Text", f"{L}P2", f"{L}P3", f"{L}P4", f"{L}ListItem", f"{L}Para"}

# The path segment that names the provision, and what practice calls it.
TYPE_WORDS = ("section", "regulation", "article", "rule", "paragraph", "chapter",
              "part", "schedule", "crossheading")


class Limiter:
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


class SourceAddressAdapter(requests.adapters.HTTPAdapter):
    """Bind outgoing connections to one local address, so each session leaves the
    box from a different public IP."""

    def __init__(self, source_address, **kwargs):
        self._source_address = source_address
        super().__init__(**kwargs)

    def init_poolmanager(self, *args, **kwargs):
        kwargs["source_address"] = (self._source_address, 0)
        super().init_poolmanager(*args, **kwargs)


def detect_source_ips():
    """Secondary private addresses on the main interface. On this host each one is
    associated with its own Elastic IP, verified by binding curl to each and asking
    checkip.amazonaws.com: nine addresses, nine distinct public IPs."""
    import subprocess

    def run(cmd):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout

    try:
        # Only the interface that carries the default route. Picking every address
        # on the box would hand back docker bridges (172.17/172.18) and the
        # WireGuard address, none of which can reach the internet.
        route = run(["ip", "-4", "route", "show", "default"])
        m = re.search(r"\bdev\s+(\S+)", route)
        if not m:
            return []
        dev = m.group(1)
        out = run(["ip", "-4", "-o", "addr", "show", "dev", dev])
    except Exception:
        return []
    ips = []
    for line in out.splitlines():
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)/", line)
        if m:
            ips.append(m.group(1))
    return ips


def fetch(session, limiter, url, tries=4):
    """(text, verdict). 900 = empty, 901 = 200 but not the XML we asked for."""
    for attempt in range(tries):
        limiter.wait()
        try:
            # Separate connect and read timeouts. A single large timeout parks a
            # thread on a wedged socket for its whole duration: observed on prod
            # with all 32 workers sitting in do_select while the machine was idle
            # and a fresh curl to the same host answered in 0.07s. Failing fast and
            # retrying beats waiting on a connection that will never deliver.
            r = session.get(url, timeout=(10, 90))
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
            time.sleep(int(r.headers.get("Retry-After") or 30 * (attempt + 1)))
            continue
        if r.status_code == 404:
            return None, 404
        time.sleep(2 * (attempt + 1))
    return None, 599


def node_text(el, skip_own_number=True):
    """Flatten a provision. Block-level elements get a newline so the stored text
    keeps the shape a reader expects; everything else is joined inline.

    Two details that matter, both found by reading the output rather than the spec:
    CLML puts <Pnumber> immediately before the text it numbers with no separator,
    so a naive flatten yields "11In this Act" and "aArticles 2 to 12"; and the
    provision's own top-level Pnumber is already the label, so repeating it inside
    the text is noise.
    """
    parts = []
    own_number = None
    if skip_own_number:
        for ch in el:
            if ch.tag == f"{L}Pnumber":
                own_number = ch
                break

    def walk(e):
        if e.text:
            parts.append(e.text)
        for ch in e:
            if ch is own_number:
                if ch.tail:
                    parts.append(ch.tail)
                continue
            walk(ch)
            if ch.tag == f"{L}Pnumber":
                parts.append(" ")
            if ch.tag in BLOCK_TAGS:
                parts.append("\n")
            if ch.tail:
                parts.append(ch.tail)

    walk(el)
    txt = "".join(parts).replace("\x00", "")
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r"\n\s*\n+", "\n", txt)
    return txt.strip()


def path_facets(doc_uri, leg_id):
    """Turn a DocumentURI into (label, type, schedule, part, chapter)."""
    if not doc_uri:
        return None, None, None, None, None
    tail = doc_uri.split(".gov.uk/", 1)[-1]
    if tail.startswith("id/"):
        tail = tail[3:]
    if tail.startswith(leg_id + "/"):
        tail = tail[len(leg_id) + 1:]
    segs = [s for s in tail.split("/") if s]

    facets = {}
    i = 0
    while i < len(segs) - 1:
        if segs[i] in TYPE_WORDS:
            facets[segs[i]] = segs[i + 1]
            i += 2
        else:
            i += 1

    ptype = None
    pnum = None
    for word in ("paragraph", "rule", "article", "regulation", "section"):
        if word in facets:
            ptype, pnum = word, facets[word]
            break
    if ptype is None and segs:
        # e.g. .../schedule/2 with no inner provision
        if len(segs) >= 2 and segs[-2] in TYPE_WORDS:
            ptype, pnum = segs[-2], segs[-1]
        else:
            pnum = segs[-1]

    sched = facets.get("schedule")
    part = facets.get("part")
    chap = facets.get("chapter")

    if sched:
        label = f"Sch. {sched}"
        if part:
            label += f" Pt. {part}"
        if pnum:
            label += f" para. {pnum}"
    else:
        label = pnum or (segs[-1] if segs else "?")
    return label, ptype, sched, part, chap


def parse_provisions(xml_text, leg_id):
    root = ET.fromstring(xml_text)
    # The section heading lives on the enclosing <P1group>, and ElementTree cannot
    # walk upwards: p1.find("../Title") silently returns None rather than failing,
    # which is why every title came back empty on the first run.
    parent = {c: p for p in root.iter() for c in p}
    rows = []
    for ord_, p1 in enumerate(root.iter(f"{L}P1")):
        doc_uri = p1.get("DocumentURI") or p1.get("IdURI")
        label, ptype, sched, part, chap = path_facets(doc_uri, leg_id)
        title = None
        grp = parent.get(p1)
        if grp is not None:
            t_el = grp.find(f"{L}Title")
            if t_el is not None:
                title = re.sub(r"\s+", " ", "".join(t_el.itertext())).strip() or None
        text = node_text(p1)
        if not text:
            continue
        rows.append({
            "ord": ord_,
            "provision_label": (label or "?")[:200],
            "provision_type": ptype,
            "provision_uri": doc_uri,
            "part": part,
            "chapter": chap,
            "schedule_no": sched,
            "title": title[:500] if title else None,
            "text": text,
            "n_chars": len(text),
        })
    return rows


# Items with no dated version at all (document_status = 'final') still need a row
# to hang provisions off, otherwise the provision key has no valid_from. The base
# version is the enacted/made text, which is what the bare URI serves.
BASE_VERSIONS = """
INSERT INTO uk_legislation_versions
    (leg_id, valid_from, version_label, version_uri, is_current, http_status)
SELECT id,
       COALESCE(valid_date, made_date, enactment_date, coming_into_force,
                make_date(year, 1, 1)),
       CASE WHEN leg_type IN ('uksi','wsi','nisi') THEN 'made' ELSE 'enacted' END,
       source_url, true, 200
  FROM uk_legislation
 WHERE version_count = 0
   AND document_status IS NOT NULL
   AND document_status NOT LIKE 'fetch-%'
   AND year IS NOT NULL
ON CONFLICT (leg_id, valid_from) DO NOTHING
"""

WORKLIST = """
SELECT l.id, v.valid_from
  FROM uk_legislation l
  JOIN uk_legislation_versions v
    ON v.leg_id = l.id AND v.is_current
 WHERE v.provision_count IS NULL
   AND l.document_status IS NOT NULL
   AND l.document_status NOT LIKE 'fetch-%'
"""

INS_PROV = """
INSERT INTO uk_legislation_provisions
    (leg_id, valid_from, ord, provision_label, provision_type, provision_uri,
     part, chapter, schedule_no, title, text, n_chars)
SELECT v.leg_id::text, v.valid_from::date, v.ord::int, v.provision_label::text,
       v.provision_type::text, v.provision_uri::text, v.part::text, v.chapter::text,
       v.schedule_no::text, v.title::text, v.text::text, v.n_chars::int
  FROM (VALUES %s) AS v(leg_id, valid_from, ord, provision_label, provision_type,
                        provision_uri, part, chapter, schedule_no, title, text, n_chars)
ON CONFLICT (leg_id, valid_from, ord) DO UPDATE SET
    provision_label = EXCLUDED.provision_label,
    text            = EXCLUDED.text,
    n_chars         = EXCLUDED.n_chars
"""

MARK_VER = """
UPDATE uk_legislation_versions SET provision_count = %s, char_len = %s,
       text_hash = %s, http_status = %s, fetched_at = now()
 WHERE leg_id = %s AND valid_from = %s
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
    ap.add_argument("--source-ips", default="",
                    help="comma-separated local addresses to bind to, or 'auto'. "
                         "The 1,500/5min ceiling is per IP, so each address adds a "
                         "budget. 'auto' uses every non-loopback, non-WireGuard "
                         "address on the box.")
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

    cur.execute(BASE_VERSIONS)
    print(f"base versions created for unversioned items: {cur.rowcount}", flush=True)
    conn.commit()

    q = WORKLIST
    params = []
    if args.types:
        q += " AND l.leg_type = ANY(%s)"
        params.append([t.strip() for t in args.types.split(",")])
    q += " ORDER BY l.id"
    if args.limit:
        q += f" LIMIT {int(args.limit)}"
    # params must be None, not [], when there are no binds: the worklist contains a
    # literal % from LIKE 'fetch-%', which psycopg2 reads as a placeholder the moment
    # any parameter sequence is passed.
    cur.execute(q, params or None)
    work = cur.fetchall()
    print(f"outstanding items: {len(work)}", flush=True)
    if not work:
        return

    if args.source_ips == "auto":
        source_ips = detect_source_ips()
    elif args.source_ips:
        source_ips = [x.strip() for x in args.source_ips.split(",") if x.strip()]
    else:
        source_ips = []
    if source_ips:
        print(f"source IPs: {len(source_ips)} -> {', '.join(source_ips)}", flush=True)
        print(f"aggregate ceiling: {len(source_ips) * args.rate:.0f} req/s", flush=True)
    limiters = [Limiter(args.rate) for _ in range(max(1, len(source_ips)))]
    limiter = limiters[0]
    ip_counter = itertools.count()
    local = threading.local()
    lock = threading.Lock()
    stats = {"ok": 0, "failed": 0, "provisions": 0, "empty": 0, "bytes": 0}
    verdicts = {}

    def session():
        """One session per thread, pinned to one source IP, with that IP's own
        limiter. The rate ceiling is per IP, so N addresses give N budgets."""
        if not hasattr(local, "s"):
            idx = next(ip_counter)
            ip = source_ips[idx % len(source_ips)] if source_ips else None
            s = requests.Session()
            s.headers["User-Agent"] = UA
            if ip:
                ad = SourceAddressAdapter(source_address=ip)
                s.mount("https://", ad)
                s.mount("http://", ad)
            local.s = s
            local.lim = limiters[idx % len(limiters)]
            local.ip = ip
        return local.s

    def one(item):
        leg_id, valid_from = item
        sess = session()
        body, verdict = fetch(sess, local.lim, f"{BASE}/{leg_id}/data.xml")
        if body is None:
            return leg_id, valid_from, None, verdict, 0
        if not args.no_raw:
            path = os.path.join(RAW_DIR, leg_id + ".xml.gz")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8") as fh:
                fh.write(body)
        try:
            rows = parse_provisions(body, leg_id)
        except ET.ParseError:
            return leg_id, valid_from, None, 902, len(body)
        return leg_id, valid_from, rows, 200, len(body)

    batch = []
    t0 = time.time()
    done = 0

    # Blocks, not the whole worklist: measured on stage 2, handing
    # ThreadPoolExecutor.map all 147k items drops throughput from 8.0 to 2.5
    # items/s because every future is materialised up front.
    def chunks(seq, n):
        for i in range(0, len(seq), n):
            yield seq[i:i + n]

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        for block in chunks(work, args.chunk):
            for leg_id, valid_from, rows, verdict, nbytes in pool.map(one, block):
                done += 1
                stats["bytes"] += nbytes
                if rows is None:
                    stats["failed"] += 1
                    verdicts[verdict] = verdicts.get(verdict, 0) + 1
                    with lock:
                        cur.execute(MARK_VER, (0, 0, None, verdict, leg_id, valid_from))
                    continue
                if not rows:
                    stats["empty"] += 1
                stats["ok"] += 1
                stats["provisions"] += len(rows)
                full = "\n".join(r["text"] for r in rows)
                with lock:
                    for r in rows:
                        batch.append((leg_id, valid_from, r["ord"],
                                      r["provision_label"], r["provision_type"],
                                      r["provision_uri"], r["part"], r["chapter"],
                                      r["schedule_no"], r["title"], r["text"],
                                      r["n_chars"]))
                    if len(batch) >= 2000:
                        execute_values(cur, INS_PROV, batch, page_size=1000)
                        batch.clear()
                    cur.execute(MARK_VER, (len(rows), len(full),
                                           hashlib.sha256(full.encode()).hexdigest(),
                                           200 if rows else 900, leg_id, valid_from))
                if done % 1000 == 0:
                    el = time.time() - t0
                    print(f"  {done}/{len(work)} ok={stats['ok']} "
                          f"failed={stats['failed']} prov={stats['provisions']} "
                          f"{stats['bytes'] / 1e9:.1f}GB {done / el:.1f} items/s",
                          flush=True)
    with lock:
        if batch:
            execute_values(cur, INS_PROV, batch, page_size=1000)

    print("\n=== summary ===")
    for k, v in stats.items():
        print(f"  {k:11s} {v if k != 'bytes' else f'{v / 1e9:.1f} GB'}")
    if verdicts:
        print("  failure verdicts:")
        for k, v in sorted(verdicts.items(), key=lambda x: -x[1]):
            print(f"    {k}: {v}")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
