#!/usr/bin/env python3
"""Stage 1 of the UK legislation pipeline: build the uk_legislation register.

Enumerates every item of legislation of the configured types from the Atom feeds
and writes one row per item. Text and versions are stages 2 and 3; this stage is
metadata only and is deliberately cheap.

Why the Atom feed and not the sitemaps
--------------------------------------
Measured 2026-08-22, because the obvious-looking route is a trap:

  sitemap-ukpga.xml    3,673 leaf files
  sitemap-uksi.xml    34,917 leaf files
  one leaf (sitemap-ukpga-revised-2006-40-49.xml) holds 7,583 <url> entries

The leaves are provision-level, not item-level: ten Acts expand to 7.5k URLs. A
sitemap enumeration therefore costs ~38,600 requests and yields millions of URLs
that have to be filtered back down to items. The Atom feed costs ~90 requests for
ukpga and ~950 for uksi at results-count=200, and each entry already carries the
id, title, year, number, type and an <updated> timestamp.

Source: https://www.legislation.gov.uk, OGL v3.0. Fair use is 3,000 requests per
5 minutes per IP (10/s) and a User-Agent header is mandatory; over-limit is 403.
There is no API key and no registration. Apache behind CloudFront, no anti-bot.

Usage:
  python3 01_harvest_register.py --types ukpga --dry-run
  python3 01_harvest_register.py --types ukpga,uksi
  python3 01_harvest_register.py --types uksi --since 2026-08-01   # incremental
"""

import argparse
import os
import re
import sys
import time
import xml.etree.ElementTree as ET

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

ATOM = "{http://www.w3.org/2005/Atom}"
UKM = "{http://www.legislation.gov.uk/namespaces/metadata}"

# England & Wales plus UK-wide only. Scotland (asp, ssi), Wales (asc, wsi) and
# Northern Ireland (nia, nisr) are deliberately out of scope for this pass.
IN_SCOPE = ["ukpga", "uksi", "apgb", "ukppa", "aep", "ukcm", "ukla"]

# The real ceiling is 1,500 requests / 5 minutes per IP (5/s), stated in the body
# of the 429 the server returns. The developer docs claim 3,000; they are wrong.
RATE = float(os.environ.get("UK_RATE", "4"))
MIN_INTERVAL = 1.0 / RATE

# Ids come in two shapes and the second one is easy to miss:
#   modern:  /id/ukpga/2006/46
#   regnal:  /id/ukpga/Eliz2/6-7/9   (pre-1963 Acts are cited by regnal year)
# Requiring a 4-digit year drops every Act before 1963 - about 14,000 of the
# 17,560 ukpga items - so the path is taken whole and the calendar year comes
# from ukm:Year instead.
ID_RE = re.compile(r"/id/([a-z]+)/(.+)$")


class Fetcher:
    """Rate-limited GET with retry. 403 means the fair-use limit was tripped, so it
    is treated as backpressure rather than as a permanent failure."""

    def __init__(self):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self.last = 0.0

    def get(self, url, tries=5):
        for attempt in range(tries):
            wait = MIN_INTERVAL - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.s.get(url, timeout=60)
            except requests.RequestException as e:
                print(f"    net error ({e}); retry {attempt + 1}/{tries}", flush=True)
                time.sleep(3 * (attempt + 1))
                continue
            if r.status_code == 200:
                return r.text
            if r.status_code in (403, 429, 503):
                back = int(r.headers.get("Retry-After") or 30 * (attempt + 1))
                print(f"    throttled {r.status_code}; sleeping {back}s", flush=True)
                time.sleep(back)
                continue
            if r.status_code == 404:
                return None
            print(f"    http {r.status_code} on {url}", flush=True)
            time.sleep(2 * (attempt + 1))
        return None


def parse_feed_page(xml_text):
    """Return (rows, n_entries, next_url).

    n_entries is reported separately from len(rows) on purpose. "the page held no
    entries" and "the page held entries I could not parse" are different facts, and
    treating the second as the first is exactly how this harvester lost every
    pre-1963 Act on its first run, and how the TNA case-law harvest silently
    truncated ewhc/admin at April 2016. A page that fails to parse raises, so it is
    retried rather than being mistaken for the end of the feed.
    """
    root = ET.fromstring(xml_text)
    rows = []
    entries = root.findall(f"{ATOM}entry")
    for e in entries:
        ident = e.findtext(f"{ATOM}id") or ""
        m = ID_RE.search(ident)
        if not m:
            continue
        leg_type, tail = m.group(1), m.group(2).strip("/")
        path = f"{leg_type}/{tail}"

        # Prefer the publisher's own metadata over parsing the URI: regnal-year
        # items still carry a calendar year here.
        year = None
        y_el = e.find(f".//{UKM}Year")
        if y_el is not None and (y_el.get("Value") or "").isdigit():
            year = int(y_el.get("Value"))
        number = None
        n_el = e.find(f".//{UKM}Number")
        if n_el is not None:
            number = (n_el.get("Value") or "").strip() or None
        if number is None:
            number = tail.rsplit("/", 1)[-1]

        # Welsh SIs (and a handful of others) use <title type="xhtml"> with the
        # bilingual title in nested markup, so findtext returns whitespace. Flatten
        # instead: this is what left 6,460 of 6,649 wsi rows titleless on the first run.
        t_el = e.find(f"{ATOM}title")
        title = None
        if t_el is not None:
            title = re.sub(r"\s+", " ", "".join(t_el.itertext())).strip() or None
        updated = (e.findtext(f"{ATOM}updated") or "").strip() or None
        rows.append({
            "id": path,
            "leg_type": leg_type,
            "year": year,
            "number": number,
            "title": title,
            "source_url": f"{BASE}/{path}",
            "updated": updated,
        })
    next_url = None
    for link in root.findall(f"{ATOM}link"):
        if link.get("rel") == "next":
            next_url = link.get("href")
            break
    if next_url and next_url.startswith("http://"):
        next_url = "https://" + next_url[len("http://"):]
    return rows, len(entries), next_url


UPSERT = """
INSERT INTO uk_legislation (id, leg_type, year, number, title, source_url, updated_at)
SELECT v.id::text, v.leg_type::text, v.year::int, v.number::text, v.title::text,
       v.source_url::text, now()
  FROM (VALUES %s) AS v(id, leg_type, year, number, title, source_url)
ON CONFLICT (id) DO UPDATE SET
    title      = COALESCE(EXCLUDED.title, uk_legislation.title),
    source_url = EXCLUDED.source_url,
    updated_at = now()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", default="ukpga",
                    help=f"comma-separated; in scope: {','.join(IN_SCOPE)}")
    ap.add_argument("--per-page", type=int, default=200)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-pages", type=int, default=0, help="0 = no limit")
    ap.add_argument("--since", default="",
                    help="ISO date; stop a type once entries are older than this "
                         "(feed is sorted by most recently updated)")
    args = ap.parse_args()

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    unknown = [t for t in types if t not in IN_SCOPE]
    if unknown:
        sys.exit(f"out of scope for this pass: {unknown}. In scope: {IN_SCOPE}")
    if not DB_URL and not args.dry_run:
        sys.exit("DATABASE_URL is required")

    conn = cur = None
    if not args.dry_run:
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()

    f = Fetcher()
    grand = 0
    for leg_type in types:
        url = f"{BASE}/{leg_type}/data.feed?results-count={args.per_page}"
        if args.since:
            url += "&sort=modified"
        page = 0
        seen = 0
        unparsed = 0
        batch = []
        print(f"\n=== {leg_type} ===", flush=True)
        while url:
            page += 1
            if args.max_pages and page > args.max_pages:
                print(f"  stopping at --max-pages {args.max_pages}", flush=True)
                break
            xml_text = f.get(url)
            if xml_text is None:
                # Do NOT treat this as end-of-feed. Say so loudly and stop the type
                # so the gap is visible instead of being recorded as complete.
                print(f"  ABORT {leg_type}: page {page} unfetchable after retries. "
                      f"Register for this type is INCOMPLETE.", flush=True)
                break
            try:
                rows, n_entries, next_url = parse_feed_page(xml_text)
            except ET.ParseError as e:
                print(f"  ABORT {leg_type}: page {page} malformed ({e}). INCOMPLETE.",
                      flush=True)
                break
            if n_entries == 0:
                break
            if not rows:
                # Entries were present but none were understood. Keep going, and say
                # so, rather than reading it as the end of the feed.
                unparsed += n_entries
                print(f"  WARNING {leg_type} page {page}: {n_entries} entries, "
                      f"0 parsed", flush=True)
            elif len(rows) < n_entries:
                unparsed += n_entries - len(rows)
            seen += len(rows)
            if args.since and all((r["updated"] or "") < args.since for r in rows):
                print(f"  reached --since {args.since} at page {page}", flush=True)
                next_url = None
            batch.extend(rows)
            if len(batch) >= 1000 and not args.dry_run:
                execute_values(cur, UPSERT,
                               [(r["id"], r["leg_type"], r["year"], r["number"],
                                 r["title"], r["source_url"]) for r in batch])
                conn.commit()
                batch.clear()
            if page % 10 == 0:
                print(f"  page {page}: {seen} items", flush=True)
            url = next_url
        if batch and not args.dry_run:
            execute_values(cur, UPSERT,
                           [(r["id"], r["leg_type"], r["year"], r["number"],
                             r["title"], r["source_url"]) for r in batch])
            conn.commit()
        print(f"  {leg_type}: {seen} items over {page} pages"
              + (f", {unparsed} entries UNPARSED" if unparsed else ""), flush=True)
        grand += seen

    print(f"\ntotal items: {grand}")
    if cur:
        cur.execute("SELECT leg_type, count(*) FROM uk_legislation GROUP BY 1 ORDER BY 2 DESC")
        for t, n in cur.fetchall():
            print(f"  {t:8s} {n}")
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
