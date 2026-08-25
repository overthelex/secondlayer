#!/usr/bin/env python3
"""Stage 4: fill uk_legislation_effects from the Changes to Legislation dataset.

Amendments are ingested, never diffed. legislation.gov.uk states every change
explicitly, in two places, and both are needed:

  changes-feed  /changes/affected/{type}/{year}/data.feed
                one <ukm:Effect> per entry, applied and unapplied alike, with the
                affecting provision, the commencement authority and the in-force
                dates. This is the authority.
  unapplied     <ukm:UnappliedEffect> already sitting inside every item XML that
                stage 3 wrote to disk. Costs no request at all, and is kept as a
                backstop: if the feed ever loses a scope, the editorial backlog
                for that act is still recoverable from local files.

API facts, measured against the live service on 2026-08-24, not extrapolated
--------------------------------------------------------------------------
  * /changes/data.feed is unusable: 504 Gateway Time-out at every page size
    tried, including results-count=1 on a second attempt.
  * /changes/affected/{type}/data.feed answers 200 but reports
    totalResults=523,791 -- the GLOBAL count -- for any type. Type-level scoping
    is silently ignored by the source. Never trust a count from that URL.
  * /changes/affected/{type}/{year}/data.feed is correct: ukpga/2006 reports
    22,656 and all 200 entries on page 1 carry AffectedYear="2006" and
    AffectedClass="UnitedKingdomPublicGeneralAct".
  * results-count=200 is honoured: 200 entries, ~504 KB, and rel="next" pages
    with &page=N.
  * /changes/affected/{type}/{year}/data.csv is capped at 50 rows per page and
    flattens the structure into 25 columns, losing the commencement authority
    and the in-force dates. The Atom feed is strictly better; the CSV is only
    convenient if you want the editorial QA columns.

Attribute universe over a real 200-entry page, so the parser is not guessing:
  always     EffectId URI Type Modified Row Applied RequiresApplied
             AffectedURI AffectedClass AffectedYear AffectedNumber
             AffectedProvisions AffectingURI AffectingClass AffectingYear
             AffectingNumber AffectingProvisions
  sometimes  AffectedExtent (129/200)  AffectingEffectsExtent (71/200)
             Comments (5)  AppendedCommentary (12)  Notes (2)  AppliedModified (4)
  children   AffectedTitle AffectingTitle AffectedProvisions AffectingProvisions
             Savings CommencementAuthority InForceDates/InForce
There is no royal-assent attribute in the feed -- that is a CSV-only column --
so royal_assent_date is filled afterwards from the affecting act's own
enactment_date, and stays NULL when the affecting act is outside the register
(Scottish, Welsh and Northern Ireland legislation is not harvested; see the
coverage note in 01_harvest_register.py).

Progress lives in uk_legislation_effect_scopes (migration 196) and not in the
effects themselves, because an effect records the affected YEAR and CLASS and
never the register's leg_type, so a scope with genuinely zero effects would be
indistinguishable from one never fetched.

Rate: 1,500 requests / 5 minutes per IP, i.e. 5/s, whatever the developer docs
say. Default 4/s per source address, same as stages 2 and 3.

Usage:
  python3 04_harvest_effects.py --source unapplied           # offline, no requests
  python3 04_harvest_effects.py --limit 5                    # smoke test
  python3 04_harvest_effects.py --types ukpga
  python3 04_harvest_effects.py --source-ips auto            # every outstanding scope
  python3 04_harvest_effects.py --refresh --types ukpga      # re-crawl finished scopes
  python3 04_harvest_effects.py --finalise                   # recount once nothing is
                                                             # outstanding; see --finalise
"""

import argparse
import glob
import gzip
import itertools
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
RAW_DIR = os.environ.get("UK_CHANGES_RAW_DIR", "/home/ubuntu/opendata/uk/legislation/changes")
FULL_DIR = os.environ.get("UK_TEXT_RAW_DIR", "/home/ubuntu/opendata/uk/legislation/full")

ATOM = "{http://www.w3.org/2005/Atom}"
UKM = "{http://www.legislation.gov.uk/namespaces/metadata}"
ID_PREFIX = re.compile(r"^https?://(?:www\.)?legislation\.gov\.uk/id/")
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
    """Secondary private addresses on the interface carrying the default route.
    Every other address on this host is a docker bridge or WireGuard and cannot
    reach the internet."""
    import subprocess

    def run(cmd):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout

    try:
        route = run(["ip", "-4", "route", "show", "default"])
        m = re.search(r"\bdev\s+(\S+)", route)
        if not m:
            return []
        out = run(["ip", "-4", "-o", "addr", "show", "dev", m.group(1)])
    except Exception:
        return []
    return re.findall(r"inet (\d+\.\d+\.\d+\.\d+)/", out)


def fetch(session, limiter, url, tries=4):
    """Returns (text, verdict). Verdict follows the npa.* convention: an HTTP
    status, or a code above the HTTP range for a fetch that succeeded but is
    unusable.
      900 = empty body   901 = served 200 but not an Atom feed   599 = gave up
    A scope truncated by --max-pages is recorded as 903 by crawl_scope, so a
    silent cap stays visible and outstanding rather than looking complete.
    """
    for attempt in range(tries):
        limiter.wait()
        try:
            r = session.get(url, timeout=(10, 60))
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 200:
            body = r.text
            if not body.strip():
                return None, 900
            if "<feed" not in body[:4000]:
                return None, 901
            return body, 200
        # 504 belongs here and not in the permanent-failure branch: the changes
        # service returns it under load on wide scopes and answers the identical
        # URL a moment later.
        if r.status_code in (403, 429, 502, 503, 504):
            back = int(r.headers.get("Retry-After") or 30 * (attempt + 1))
            time.sleep(back)
            continue
        if r.status_code == 404:
            return None, 404
        time.sleep(2 * (attempt + 1))
    return None, 599


# ------------------------------------------------------------------ parsing ----

def strip_id(uri):
    """http://www.legislation.gov.uk/id/ukpga/2006/40 -> ukpga/2006/40.

    Applied to both sides of an effect. The affecting act is frequently outside
    the register (nia, asp, ssi), which is why affected_id and affecting_id are
    plain natural keys with no foreign key: the view LEFT JOINs them."""
    if not uri:
        return None
    out = ID_PREFIX.sub("", uri.strip()).strip("/")
    return out or None


def joined_text(el):
    if el is None:
        return None
    txt = " ".join(t.strip() for t in el.itertext() if t and t.strip())
    return txt or None


def as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def as_bool(v):
    if v is None:
        return None
    return v.strip().lower() in ("true", "1", "yes")


def in_force_date(effect):
    """Earliest declared commencement. An effect can carry several <ukm:InForce>:
    a prospective one with no Date and one or more dated entries as the parts are
    commenced. Reporting the earliest dated one answers "when did this start to
    bite", which is the question a reader has; the prospective-only case leaves
    the column NULL, which the 'applied' flag already distinguishes."""
    dates = []
    for inf in effect.iter(f"{UKM}InForce"):
        d = inf.get("Date")
        if d and DATE_RE.match(d):
            dates.append(d)
    return min(dates) if dates else None


def notes_of(effect):
    """The feed spreads editorial prose over three optional attributes. Keep all
    of them rather than picking one, and keep the labels so the origin of each
    fragment survives."""
    parts = []
    for attr, label in (("Notes", None), ("Comments", "Comments"),
                        ("AppendedCommentary", "Commentary")):
        v = (effect.get(attr) or "").strip()
        if v:
            parts.append(f"{label}: {v}" if label else v)
    return " | ".join(parts) or None


def effect_row(effect, origin):
    """One <ukm:Effect> or <ukm:UnappliedEffect> -> one tuple for the table.

    UnappliedEffect carries no Applied attribute at all (that is the whole point
    of the element), so origin decides: an effect read out of UnappliedEffects is
    unapplied by definition."""
    eid = effect.get("EffectId") or strip_id(effect.get("URI"))
    if not eid:
        return None
    applied = as_bool(effect.get("Applied"))
    if applied is None and origin == "unapplied":
        applied = False
    return (
        eid,
        effect.get("AffectedURI"),
        strip_id(effect.get("AffectedURI")),
        effect.get("AffectedClass"),
        as_int(effect.get("AffectedYear")),
        effect.get("AffectedNumber"),
        joined_text(effect.find(f"{UKM}AffectedTitle")),
        effect.get("AffectedProvisions"),
        effect.get("AffectedExtent"),
        effect.get("AffectingURI"),
        strip_id(effect.get("AffectingURI")),
        effect.get("AffectingClass"),
        as_int(effect.get("AffectingYear")),
        effect.get("AffectingNumber"),
        joined_text(effect.find(f"{UKM}AffectingTitle")),
        effect.get("AffectingProvisions"),
        effect.get("Type"),
        as_bool(effect.get("RequiresApplied")),
        applied,
        in_force_date(effect),
        None,  # royal_assent_date: not in the feed, backfilled in finalise()
        joined_text(effect.find(f"{UKM}CommencementAuthority")),
        notes_of(effect),
        origin,
        effect.get("Modified"),
    )


UPSERT = """
INSERT INTO uk_legislation_effects (
    effect_id, affected_uri, affected_id, affected_class, affected_year,
    affected_number, affected_title, affected_provisions, affected_extent,
    affecting_uri, affecting_id, affecting_class, affecting_year,
    affecting_number, affecting_title, affecting_provisions,
    effect_type, requires_applied, applied, in_force_date, royal_assent_date,
    commencement_authority, notes, origin, modified)
VALUES %s
ON CONFLICT (effect_id) DO UPDATE SET
    affected_uri = EXCLUDED.affected_uri,
    affected_id = EXCLUDED.affected_id,
    affected_class = EXCLUDED.affected_class,
    affected_year = EXCLUDED.affected_year,
    affected_number = EXCLUDED.affected_number,
    affected_title = EXCLUDED.affected_title,
    affected_provisions = EXCLUDED.affected_provisions,
    affected_extent = EXCLUDED.affected_extent,
    affecting_uri = EXCLUDED.affecting_uri,
    affecting_id = EXCLUDED.affecting_id,
    affecting_class = EXCLUDED.affecting_class,
    affecting_year = EXCLUDED.affecting_year,
    affecting_number = EXCLUDED.affecting_number,
    affecting_title = EXCLUDED.affecting_title,
    affecting_provisions = EXCLUDED.affecting_provisions,
    effect_type = EXCLUDED.effect_type,
    requires_applied = EXCLUDED.requires_applied,
    applied = EXCLUDED.applied,
    in_force_date = EXCLUDED.in_force_date,
    commencement_authority = EXCLUDED.commencement_authority,
    notes = EXCLUDED.notes,
    origin = EXCLUDED.origin,
    modified = EXCLUDED.modified
-- Precedence is by ORIGIN and nothing else. The local UnappliedEffects pass must
-- never overwrite a row the feed already placed, because the feed states Applied
-- and the item XML cannot; a feed row always wins, including over an older feed
-- row. Modified is stored but deliberately NOT part of this predicate: within a
-- run the feed serves each effect once per scope, and a later crawl is meant to
-- refresh unconditionally rather than to be refused as stale.
WHERE EXCLUDED.origin = 'changes-feed'
   OR uk_legislation_effects.origin = 'unapplied'
"""

# royal_assent_date is not published in the feed. For an affecting act inside the
# register its enactment date IS the royal assent date (ukm:EnactmentDate is what
# stage 2 stored), so fill it from there and leave the rest NULL rather than
# inventing a value.
FILL_RA = """
UPDATE uk_legislation_effects e
   SET royal_assent_date = l.enactment_date
  FROM uk_legislation l
 WHERE l.id = e.affecting_id
   AND l.enactment_date IS NOT NULL
   AND e.royal_assent_date IS DISTINCT FROM l.enactment_date
"""

# LEFT JOIN and not a plain join on the counts: a refresh can move an effect from
# unapplied to applied, and an act whose backlog cleared has to fall back to 0
# rather than keep the stale figure.
RECOUNT = """
WITH counts AS (
    SELECT affected_id AS id, count(*)::int AS n
      FROM uk_legislation_effects
     WHERE applied IS NOT TRUE
       AND affected_id IS NOT NULL
     GROUP BY 1
)
UPDATE uk_legislation l
   SET unapplied_effects = COALESCE(c.n, 0),
       updated_at = now()
  FROM (SELECT id FROM uk_legislation) ids
  LEFT JOIN counts c ON c.id = ids.id
 WHERE l.id = ids.id
   AND l.unapplied_effects IS DISTINCT FROM COALESCE(c.n, 0)
"""

SCOPE_DONE = """
INSERT INTO uk_legislation_effect_scopes
    (leg_type, year, pages, entries, total_results, http_status, last_modified, fetched_at)
VALUES (%s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (leg_type, year) DO UPDATE SET
    pages = EXCLUDED.pages,
    entries = EXCLUDED.entries,
    total_results = EXCLUDED.total_results,
    http_status = EXCLUDED.http_status,
    last_modified = EXCLUDED.last_modified,
    fetched_at = now()
"""

WORKLIST = """
SELECT DISTINCT l.leg_type, l.year
  FROM uk_legislation l
  LEFT JOIN uk_legislation_effect_scopes s
         ON s.leg_type = l.leg_type AND s.year = l.year
 WHERE l.year IS NOT NULL
   AND (%(refresh)s OR s.leg_type IS NULL OR s.http_status IS DISTINCT FROM 200)
"""


def store_rows(cur, rows):
    """Deduplicate before the upsert. ON CONFLICT DO UPDATE raises "cannot affect
    row a second time" if one statement carries the same key twice, which would
    abort a whole batch over a single repeated EffectId."""
    if not rows:
        return 0
    uniq = {}
    for r in rows:
        uniq[r[0]] = r
    execute_values(cur, UPSERT, list(uniq.values()), page_size=500)
    return len(uniq)


# --------------------------------------------------------------- changes feed --

def crawl_scope(leg_type, year, session, limiter, cur, keep_raw, max_pages):
    """Page one (type, year) scope to exhaustion. Returns a scope summary."""
    url = f"{BASE}/changes/affected/{leg_type}/{year}/data.feed?results-count=200"
    pages = entries = 0
    total = None
    newest = None
    status = 200
    while url and pages < max_pages:
        body, verdict = fetch(session, limiter, url)
        if verdict != 200:
            status = verdict
            break
        pages += 1
        if keep_raw:
            path = os.path.join(RAW_DIR, leg_type, str(year))
            os.makedirs(path, exist_ok=True)
            with gzip.open(os.path.join(path, f"p{pages}.xml.gz"), "wt",
                           encoding="utf-8") as fh:
                fh.write(body)
        try:
            feed = ET.fromstring(body)
        except ET.ParseError:
            status = 901
            break
        if total is None:
            t = feed.find(".//{http://a9.com/-/spec/opensearch/1.1/}totalResults")
            total = as_int(t.text) if t is not None else None
        rows = []
        for effect in feed.iter(f"{UKM}Effect"):
            row = effect_row(effect, "changes-feed")
            if row:
                rows.append(row)
                if row[24] and (newest is None or row[24] > newest):
                    newest = row[24]
        entries += store_rows(cur, rows)
        url = None
        for link in feed.findall(f"{ATOM}link"):
            if link.get("rel") == "next":
                # The feed emits rel="next" as http://, not https://. Left alone
                # it would leave the session's https:// adapter unused, so the
                # request would go out on the default address instead of the one
                # this thread was bound to and quietly spend another IP's budget.
                url = re.sub(r"^http://", "https://", link.get("href") or "")
                break
    if url and status == 200:
        # The page ceiling was hit with a rel="next" still outstanding. Recording
        # this as 200 would mark a truncated scope complete and the worklist
        # would never come back to it — a silent cap, which is the one failure
        # mode a resumable crawler must not have. 903 keeps it outstanding and
        # visible in idx_uk_eff_scope_bad.
        status = 903
        print(f"  !! {leg_type}/{year}: hit --max-pages={max_pages}, scope truncated",
              flush=True)
    return {"pages": pages, "entries": entries, "total": total,
            "status": status, "newest": newest}


# ------------------------------------------------------------ local unapplied --

def crawl_local(cur, batch=2000):
    """Read <ukm:UnappliedEffect> out of the item XML stage 3 already stored.

    Zero requests. Sized on prod 2026-08-24: 157,232 gzipped files, 4.9 GB, and
    47 of a random 200 carry an UnappliedEffects block."""
    files = sorted(glob.glob(os.path.join(FULL_DIR, "**", "*.xml.gz"), recursive=True))
    print(f"local item files: {len(files)}", flush=True)
    rows, seen, done = [], 0, 0
    for path in files:
        done += 1
        try:
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                body = fh.read()
        except OSError:
            continue
        if "UnappliedEffect" not in body:
            continue
        try:
            doc = ET.fromstring(body)
        except ET.ParseError:
            continue
        for effect in doc.iter(f"{UKM}UnappliedEffect"):
            row = effect_row(effect, "unapplied")
            if row:
                rows.append(row)
        if len(rows) >= batch:
            seen += store_rows(cur, rows)
            rows = []
            print(f"  {done}/{len(files)} effects={seen}", flush=True)
    seen += store_rows(cur, rows)
    print(f"local pass done: {seen} unapplied effects from {done} files", flush=True)
    return seen


FINALISE_GUARD = """
SELECT (SELECT count(*) FROM uk_legislation_effect_scopes WHERE http_status = 200),
       (SELECT count(*) FROM (SELECT DISTINCT leg_type, year FROM uk_legislation
                               WHERE year IS NOT NULL) w)
"""


def finalise(cur, force=False):
    """Recompute the derived columns. Refuses to run on a partial crawl.

    uk_legislation.unapplied_effects is filled by stage 2 from each item's own
    XML, so recomputing it from an incomplete effects table does not leave a
    stale number, it overwrites a good one with zero. The opt-in flag alone is
    not enough of a guard: --finalise --types ukpga is also opt-in and would
    still clobber every act outside that type. So check the scope table against
    the full worklist and refuse unless they match.
    """
    cur.execute(FINALISE_GUARD)
    done, wanted = cur.fetchone()
    if done < wanted and not force:
        print(f"REFUSING to finalise: {done} of {wanted} scopes completed. "
              f"unapplied_effects would be recomputed from a partial effects "
              f"table and zeroed on every act whose scopes were not fetched. "
              f"Finish the crawl, or pass --force-finalise if you know better.",
              flush=True)
        return
    cur.execute(FILL_RA)
    print(f"royal_assent_date filled on {cur.rowcount} effects", flush=True)
    cur.execute(RECOUNT)
    print(f"unapplied_effects recounted on {cur.rowcount} acts", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=("changes", "unapplied", "both"),
                    default="changes")
    ap.add_argument("--types", help="comma-separated leg_type filter")
    ap.add_argument("--years", help="comma-separated year filter")
    ap.add_argument("--limit", type=int, help="stop after N scopes")
    ap.add_argument("--rate", type=float, default=4.0, help="requests/s per source IP")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-pages", type=int, default=400,
                    help="page ceiling per scope; 400 x 200 = 80,000 effects, well "
                         "above the widest scope measured (ukpga/2006, 22,656)")
    ap.add_argument("--source-ips", default="",
                    help="comma-separated local addresses to bind to, or 'auto'")
    ap.add_argument("--refresh", action="store_true",
                    help="re-crawl scopes already recorded as 200")
    ap.add_argument("--no-raw", action="store_true")
    # Opt-in, and deliberately so. finalise() recomputes uk_legislation.unapplied_effects
    # from the effects table, but stage 2 already populated that column by counting
    # <ukm:UnappliedEffect> in each item's own XML. Running the recount while the
    # effects table is still partial does not leave a stale number, it overwrites a
    # good one with zero: a --limit 3 smoke test on 2026-08-24 zeroed the counter on
    # 33,434 acts. Only pass --finalise after a full crawl.
    ap.add_argument("--force-finalise", action="store_true",
                    help="run the recount even though scopes are outstanding")
    ap.add_argument("--finalise", action="store_true",
                    help="recompute royal_assent_date and unapplied_effects. Run this "
                         "ONLY after a complete crawl -- on a partial one it zeroes "
                         "the counter stage 2 filled.")
    args = ap.parse_args()

    if not DB_URL:
        sys.exit("DATABASE_URL is required")

    conn = psycopg2.connect(DB_URL)
    # This database sets idle_in_transaction_session_timeout = 1min, and the
    # worklist read would otherwise hold a transaction open across the first
    # network fetches. Autocommit keeps every statement self-contained.
    conn.autocommit = True
    cur = conn.cursor()

    if args.source in ("unapplied", "both"):
        crawl_local(cur)
        if args.source == "unapplied":
            if args.finalise:
                finalise(cur, args.force_finalise)
            return

    q = WORKLIST
    params = {"refresh": args.refresh}
    if args.types:
        q += " AND l.leg_type = ANY(%(types)s)"
        params["types"] = [t.strip() for t in args.types.split(",")]
    if args.years:
        q += " AND l.year = ANY(%(years)s)"
        params["years"] = [int(y) for y in args.years.split(",")]
    # Newest first: recent years hold almost all of the dataset, so a run that is
    # cut short still leaves the useful half in place.
    q += " ORDER BY l.year DESC, l.leg_type"
    if args.limit:
        q += f" LIMIT {int(args.limit)}"
    cur.execute(q, params)
    work = cur.fetchall()
    print(f"outstanding scopes: {len(work)}", flush=True)
    if not work:
        if args.finalise:
            finalise(cur, args.force_finalise)
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
    ip_counter = itertools.count()
    local = threading.local()
    lock = threading.Lock()
    stats = {"scopes": 0, "pages": 0, "effects": 0, "failed": 0}
    verdicts = {}
    started = time.time()

    def worker_state():
        if getattr(local, "session", None) is None:
            idx = next(ip_counter)
            s = requests.Session()
            s.headers["User-Agent"] = UA
            s.headers["Accept"] = "application/atom+xml, application/xml"
            if source_ips:
                addr = source_ips[idx % len(source_ips)]
                # Both schemes: a redirect to http:// would otherwise slip past the
                # binding and land on the default address.
                s.mount("https://", SourceAddressAdapter(addr))
                s.mount("http://", SourceAddressAdapter(addr))
            local.session = s
            local.limiter = limiters[idx % len(limiters)]
            # One connection per thread: execute_values on a shared cursor from
            # eight threads corrupts the protocol state, and psycopg2 connections
            # are cheap next to a 200-entry page fetch.
            c = psycopg2.connect(DB_URL)
            c.autocommit = True
            local.conn = c
            local.cur = c.cursor()
        return local

    def run(item):
        leg_type, year = item
        st = worker_state()
        try:
            r = crawl_scope(leg_type, year, st.session, st.limiter, st.cur,
                            not args.no_raw, args.max_pages)
        except Exception as exc:  # one bad scope must not kill the fleet
            r = {"pages": 0, "entries": 0, "total": None, "status": 902,
                 "newest": None}
            print(f"  !! {leg_type}/{year}: {type(exc).__name__}: {exc}", flush=True)
        st.cur.execute(SCOPE_DONE, (leg_type, year, r["pages"], r["entries"],
                                    r["total"], r["status"], r["newest"]))
        with lock:
            stats["scopes"] += 1
            stats["pages"] += r["pages"]
            stats["effects"] += r["entries"]
            if r["status"] != 200:
                stats["failed"] += 1
                verdicts[r["status"]] = verdicts.get(r["status"], 0) + 1
            if stats["scopes"] % 25 == 0:
                el = time.time() - started
                print(f"  {stats['scopes']}/{len(work)} pages={stats['pages']} "
                      f"effects={stats['effects']} failed={stats['failed']} "
                      f"{stats['scopes'] / el:.2f} scopes/s", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(run, work))

    print("\n=== summary ===", flush=True)
    for k in ("scopes", "pages", "effects", "failed"):
        print(f"  {k:<10} {stats[k]}", flush=True)
    if verdicts:
        print("  failure verdicts:", flush=True)
        for k in sorted(verdicts):
            print(f"    {k}: {verdicts[k]}", flush=True)

    if args.finalise:
        finalise(cur, args.force_finalise)


if __name__ == "__main__":
    main()
