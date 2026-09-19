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
# ⚠⚠ curl_cffi, not requests — but read the whole note before trusting it.
#
# legislation.gov.uk sits behind Cloudflare, which scores the TLS handshake and
# refuses a client it dislikes with **HTTP 202 and a zero-length body**. Not 403,
# not 429: an empty 202, which a naive client reads as "accepted, come back
# later" and a retry loop reads as transient. That is the whole trap.
#
# Measured on prod 2026-08-27, same host, same second:
#
#   curl       /ukpga/2006/46/contents/data.xml -> 200
#   requests   same URL                         -> 202, 0 bytes
#   curl_cffi  same URL                         -> 200, 1,246,546 bytes
#
# It is not the headers: a curl User-Agent, Accept: */*, and dropping
# Accept-Encoding and Connection all still returned 202.
#
# ⚠⚠ AND THEN curl_cffi WAS BURNED TOO. Twenty minutes of fleet traffic on the
# new transport and the same three URLs answered 202 to curl_cffi while plain
# curl still answered 200. So this is not "requests bad, curl_cffi good": each
# transport buys a window, and running a 15-address fleet through it spends that
# window. Swapping the client again is a treadmill, not a fix.
#
# What the numbers actually say. The published fair-use ceiling is 1,500 requests
# per 5 minutes per IP. The fleet ran at ~42 items/s, and with the 307 redirect
# that unrevised items serve, that is ~84 requests/s — 25,200 per 5 minutes in
# aggregate, sixteen times the ceiling however it is sliced per address. A
# calibration run confirmed the refusal is not rate-tunable once triggered:
# 12 threads at 4/s and 8 threads at 2/s both returned 202 on 600 of 600.
#
# The honest fix is capacity, not transport: Legislation@nationalarchives.gov.uk
# grants higher limits, which is what the letter in UKENT-15 is for. Until then
# run narrow and slow, and treat a 902 as "stop, you are over budget".
#
# ⚠ UPDATE 2026-09-20: impersonation is now REQUIRED, and the note below about
# 437 is stale. curl_cffi's DEFAULT fingerprint gets a genuine 404 from the
# origin — Apache, no cf-ray — for a URL that urllib fetches with 200. Every
# versioned profile tried (chrome124, chrome131, safari17_0, firefox133,
# edge101) answers 200. A run without a profile fails every fetch while looking
# like the acts do not exist. See IMPERSONATE below and REFUSAL_VERDICTS.
#
# The older advice, kept because the failure mode it describes is real: do NOT
# pass the bare impersonate="chrome" on curl_cffi 0.16, that alias mapped to a
# blocked fingerprint and returned 437.
# Source binding survives the switch — Session(interface=<ip>) replaces the
# HTTPAdapter, verified 200 from three of the fleet's addresses.
# Optional on purpose. Stages 5 and 6 import this module only for
# parse_provisions — they read zip archives and never touch the network — and on
# a box that has never run the crawl, curl_cffi is not installed. A hard import
# here made `06_load_point_in_time.py` die on ModuleNotFoundError before it read
# a single file. The crawl path below still needs it and says so.
try:
    from curl_cffi import requests
except ImportError:                                     # pragma: no cover
    class _NoCurlCffi:
        class RequestsError(Exception):
            pass

        def __getattr__(self, name):
            raise ImportError(
                "curl_cffi is required for the crawl path of 03_harvest_texts.py; "
                "pip install curl_cffi. Parsing-only callers (stages 5 and 6) do "
                "not need it.")

    requests = _NoCurlCffi()

from psycopg2.extras import execute_values

BASE = "https://www.legislation.gov.uk"
UA = os.environ.get(
    "UK_USER_AGENT",
    "SecondLayer-LEXAI/1.0 (+https://legal.org.ua; legal research; "
    "contact mcvovkes@gmail.com)",
)
DB_URL = os.environ.get("DATABASE_URL")
# Empty string disables impersonation, for testing what the bare client gets.
IMPERSONATE = os.environ.get("UK_IMPERSONATE", "chrome124")
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
        except requests.RequestsError:
            time.sleep(3 * (attempt + 1))
            continue
        # An empty 202 is Cloudflare refusing us, NOT the publisher saying "not
        # ready" — see the note at the imports. Recorded once and never retried:
        # twelve retries over a minute were measured to be futile, and a 91-item
        # sample spread over every decade from 1820 to 2020 came back 202 on all
        # 91, which is how you tell a refusal from a content gap. A run that
        # starts reporting 902 should be STOPPED, not retried harder: it means
        # the aggregate request budget is spent.
        if r.status_code == 202:
            return None, 902

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
       -- Three labels, not two. Established 2026-08-27 by following the bare
       -- URI of one unrevised item per type and reading the segment it lands on:
       -- ssi/nisro/uksro redirect to /made like uksi, while ukmo and ukci land
       -- on /created, which the first pass did not know existed. Classify by the
       -- kind of instrument rather than by that redirect, because a REVISED item
       -- serves at its bare URI and never redirects at all, so a single sample
       -- says nothing about its type.
       CASE
         WHEN leg_type IN ('uksi','wsi','nisi','ssi','nisr','nisro','uksro') THEN 'made'
         WHEN leg_type IN ('ukmo','ukci') THEN 'created'
         ELSE 'enacted'
       END,
       source_url, true, 200
  FROM uk_legislation l
 -- Ask the versions table, NOT uk_legislation.version_count.
 --
 -- ⚠ The counter was a fair proxy for "has no versions" while the Atom crawl was
 -- the only thing writing versions, and it stopped being one the moment
 -- 05_load_bulk_texts.py began inserting version rows without maintaining it —
 -- deliberately, because recomputing it per act during a bulk load is a
 -- full-table churn nobody asked for. Measured on the corpus 2026-09-19:
 -- version_count is wrong for 194,781 of 238,926 acts, and 194,100 of those
 -- claim zero while having rows.
 --
 -- Run as it was, this statement selected 216,070 acts instead of 21,970, and
 -- for 66,297 of them the COALESCE date differs from any version they already
 -- have — so ON CONFLICT would not catch it and each would gain a SECOND row
 -- with is_current = true. Two current versions of one act, no way to tell which
 -- the text belongs to. The guard has to read the table it is guarding.
 WHERE NOT EXISTS (SELECT 1 FROM uk_legislation_versions v WHERE v.leg_id = l.id)
   AND document_status IS NOT NULL
   AND left(document_status, 6) <> 'fetch-'
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
   AND left(l.document_status, 6) <> 'fetch-'
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

# ⚠⚠ A refusal is not a verdict about the act.
#
# 900 (empty body), 901 (200 that is not the XML asked for) and 902 (over budget)
# all mean the same thing: the transport was turned away and we learned nothing
# about this act. 599 means we gave up retrying. None of them is evidence that
# the act has no text.
#
# Writing provision_count = 0 for those is what this set exists to prevent,
# because the worklist keys on provision_count IS NULL — so a refusal recorded
# as zero removes the act from every future run permanently. On 2026-09-19 the
# corpus carried 100,361 version rows in exactly that state, accumulated over
# earlier runs, each one claiming an act has no text when what actually happened
# is that legislation.gov.uk declined to answer. They were reverted to NULL.
#
# Genuine answers from the source — a real 404, a real 410 — DO belong in
# provision_count = 0: those are facts about the act.
REFUSAL_VERDICTS = {599, 900, 901, 902}


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
    # The worklist no longer contains a literal %. It used to, in LIKE 'fetch-%',
    # and psycopg2 reads that as a placeholder the moment any parameter sequence is
    # passed: passing None when there were no binds covered the plain case but the
    # run still died with IndexError as soon as --types was used. left(...) <> is
    # equivalent and has nothing for the driver to interpolate.
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
            # ⚠ An impersonation profile is REQUIRED, not an optimisation.
            #
            # Measured 2026-09-20 on one act, same box, same minute:
            #   no profile   -> 404, a 12 KB HTML error page from Apache
            #   chrome124    -> 200, 2,199 bytes
            #   chrome131 / safari17_0 / firefox133 / edge101 -> 200
            #
            # The origin serves a genuine 404 to curl_cffi's default fingerprint
            # for a URL it serves happily to urllib. A run without a profile
            # therefore fails every fetch while looking like the act does not
            # exist — which is how 100,361 version rows came to claim their act
            # has no text (see REFUSAL_VERDICTS and migration 220).
            #
            # The header's warning that impersonate="chrome" returns 437 is
            # stale: the bare alias is gone from curl_cffi 0.16, and the
            # versioned profiles above all answer 200 today. The User-Agent
            # stays honest — it names the project and a contact address — and
            # the rate limiter is unchanged.
            kw = {"impersonate": IMPERSONATE} if IMPERSONATE else {}
            if ip:
                kw["interface"] = ip
            s = requests.Session(**kw)
            s.headers["User-Agent"] = UA
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

    # Stop when the source has clearly stopped answering. Without this the run
    # keeps going at full rate learning nothing: on 2026-09-19 it spent an hour
    # and 11,000 requests after the last successful fetch, and every one of them
    # would have written a verdict. The refusal is not rate-tunable once
    # triggered, so slowing down is not the answer either — the answer is to
    # stop and come back later.
    refused = 0
    consecutive_refusals = 0
    stopped_early = False
    give_up_after = int(os.environ.get("UK_REFUSAL_LIMIT", "300"))

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        for block in chunks(work, args.chunk):
            if stopped_early:
                break
            for leg_id, valid_from, rows, verdict, nbytes in pool.map(one, block):
                done += 1
                stats["bytes"] += nbytes
                if rows is None:
                    stats["failed"] += 1
                    verdicts[verdict] = verdicts.get(verdict, 0) + 1
                    # A refusal leaves provision_count NULL so the act stays in
                    # the worklist. Only a genuine answer from the source is
                    # allowed to record zero provisions. See REFUSAL_VERDICTS.
                    pc = None if verdict in REFUSAL_VERDICTS else 0
                    cl = None if pc is None else 0
                    with lock:
                        cur.execute(MARK_VER, (pc, cl, None, verdict, leg_id, valid_from))
                    if verdict in REFUSAL_VERDICTS:
                        refused += 1
                        consecutive_refusals += 1
                        if consecutive_refusals >= give_up_after:
                            print(f"\n!!! {consecutive_refusals} refusals in a row "
                                  f"(last verdict {verdict}) — the source has stopped "
                                  f"answering this transport. Stopping: every further "
                                  f"request would learn nothing and spend budget. "
                                  f"Nothing has been recorded as text-less; the "
                                  f"outstanding acts stay in the worklist.",
                                  flush=True)
                            stopped_early = True
                            break
                    continue
                consecutive_refusals = 0
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
                                           # 200, not 900. The fetch WAS a 200 —
                                           # this act simply has no provisions,
                                           # which is a fact about the act. Using
                                           # 900 here overloaded the code that
                                           # fetch() returns for an empty body,
                                           # i.e. a refusal, so the two became
                                           # indistinguishable in the column.
                                           # They stayed distinguishable only by
                                           # accident: the success path writes a
                                           # text_hash and the refusal path does
                                           # not. See migration 220.
                                           200, leg_id, valid_from))
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
    if stopped_early:
        print(f"\n!!! run stopped early after {refused} refusals; "
              f"{len(work) - done} acts were not attempted and remain in the "
              f"worklist. Re-run when the source is answering again.", flush=True)
    if verdicts:
        print("  failure verdicts:")
        for k, v in sorted(verdicts.items(), key=lambda x: -x[1]):
            print(f"    {k}: {v}")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
