#!/usr/bin/env python3
"""Stage 5: load provision text from the research.legislation.gov.uk bulk archives.

Replaces the per-item crawl of stage 3 for everything the bulk collections carry.
The National Archives granted pre-release access to research.legislation.gov.uk on
2026-08-28 and publishes the whole statute book as zipped CLML, refreshed daily:

    /data/downloads/texts/{collection}/{format}/{collection}-{format}.zip

    enacted-epublished    4.55 GB    revised-all-versions   19.76 GB
    revised-current       2.50 GB    best-collection         1.34 GB

Why this exists rather than more of stage 3
-------------------------------------------
Stage 3 fetched /{id}/data.xml once per item at 4 requests per second per address
and still left 40,636 devolved items with no text, because TNA reduced the crawl
rate limits under load and started refusing us with an empty HTTP 202 (see the
note at the imports of 03_harvest_texts.py). The same content arrives here as two
downloads that took under two minutes.

Measured against the register on 2026-08-31, before loading anything:

    acts in the register                          199,067
    acts with text from the stage 3 crawl          70,296
    acts the bulk carries text for                 89,965
    of those, currently text-less                  19,842   <- what this recovers
    acts still with no text anywhere              108,929
    ids in the bulk that are NOT in the register    39,794   <- retained EU law,
                                                                eur/eudn/eudr, a
                                                                gap for later

⚠ The bulk does not supersede the crawl everywhere. nisro, uksro, gbla, ukmo and
aosp are essentially absent from these two collections (1 of 8,792 nisro, 0 of
307 uksro, 0 of 273 gbla), so the pre-1948 secondary and local material stays
text-less. best-collection has not been checked yet and may hold some of it.

Identity comes from IdURI inside each file, never from the filename: the archive
names regnal items like `aep-Hen3c23-52-23-revised-data.xml`, which no sane rule
maps back to `aep/Hen3/23`, while every file carries
IdURI="http://www.legislation.gov.uk/id/{path}" in its first kilobyte.

Usage:
  python3 05_load_bulk_texts.py --zip /path/revised-current-xml.zip --dry-run
  python3 05_load_bulk_texts.py --zip a.zip --zip b.zip
  python3 05_load_bulk_texts.py --zip a.zip --only-missing
"""

import argparse
import importlib.util
import os
import re
import sys
import zipfile
from datetime import date

import psycopg2
from psycopg2.extras import execute_values

DB_URL = os.environ.get("DATABASE_URL")

ID_RE = re.compile(rb'IdURI="https?://(?:www\.)?legislation\.gov\.uk/id/([^"]+)"')

# The provision parser is stage 3's, imported rather than copied: the two must not
# drift, because a difference in how a <P1> becomes a row would silently produce a
# corpus whose crawled half and bulk half are shaped differently.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "uk_stage3", os.path.join(_here, "03_harvest_texts.py"))
stage3 = importlib.util.module_from_spec(_spec)
_saved_argv, sys.argv = sys.argv, [sys.argv[0]]
_spec.loader.exec_module(stage3)
sys.argv = _saved_argv

INS_PROV = stage3.INS_PROV

# valid_from for a bulk row. Prefer the version the register already knows is
# current, so crawled and bulk rows land on the same key instead of creating a
# second, parallel version of the same text. Fall back to the item's own dates.
VALID_FROM = """
SELECT l.id,
       COALESCE(
         (SELECT v.valid_from FROM uk_legislation_versions v
           WHERE v.leg_id = l.id AND v.is_current ORDER BY v.valid_from DESC LIMIT 1),
         (SELECT max(v.valid_from) FROM uk_legislation_versions v WHERE v.leg_id = l.id),
         l.valid_date, l.made_date, l.enactment_date, l.coming_into_force,
         make_date(l.year, 1, 1))
  FROM uk_legislation l
 WHERE l.year IS NOT NULL
"""

BASE_VERSION = """
INSERT INTO uk_legislation_versions
    (leg_id, valid_from, version_label, version_uri, is_current, http_status)
VALUES %s
ON CONFLICT (leg_id, valid_from) DO NOTHING
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", action="append", required=True,
                    help="bulk archive; repeat for several")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip items that already have provisions")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch", type=int, default=2000)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DB_URL and not args.dry_run:
        sys.exit("DATABASE_URL is required")

    conn = cur = None
    valid_from = {}
    have_text = set()
    if not args.dry_run:
        conn = psycopg2.connect(DB_URL)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(VALID_FROM)
        valid_from = {r[0]: r[1] for r in cur.fetchall()}
        print(f"register items with a resolvable version date: {len(valid_from)}",
              flush=True)
        if args.only_missing:
            cur.execute("SELECT DISTINCT leg_id FROM uk_legislation_provisions")
            have_text = {r[0] for r in cur.fetchall()}
            print(f"already carrying text: {len(have_text)}", flush=True)

    rows = []
    stats = {"files": 0, "no_id": 0, "not_in_register": 0, "skipped": 0,
             "parsed": 0, "empty": 0, "provisions": 0, "failed": 0}
    seen_versions = []
    # Acts written earlier in this run. revised-current is processed first and is
    # the better text where both archives carry an act, so enacted-epublished must
    # not overwrite it.
    done = set()

    def flush():
        # Deduplicate on the primary key before the upsert. ON CONFLICT DO UPDATE
        # raises "cannot affect row a second time" if one statement carries the
        # same (leg_id, valid_from, ord) twice, which happens as soon as an act
        # appears in both archives — revised-current and enacted-epublished
        # overlap heavily — and aborts the whole batch rather than that one row.
        if not rows or args.dry_run:
            rows.clear()
            seen_versions.clear()
            return
        if seen_versions:
            uniq_v = {(r[0], r[1]): r for r in seen_versions}
            execute_values(cur, BASE_VERSION, list(uniq_v.values()), page_size=1000)
            seen_versions.clear()
        uniq = {(r[0], r[1], r[2]): r for r in rows}
        execute_values(cur, INS_PROV, list(uniq.values()), page_size=1000)
        rows.clear()

    for zp in args.zip:
        z = zipfile.ZipFile(zp)
        names = [f for f in z.namelist() if f.endswith(".xml")]
        print(f"\n=== {os.path.basename(zp)}: {len(names)} xml", flush=True)
        for name in names:
            if args.limit and stats["files"] >= args.limit:
                break
            stats["files"] += 1
            try:
                body = z.open(name).read()
            except Exception:
                stats["failed"] += 1
                continue
            m = ID_RE.search(body[:2000])
            if not m:
                stats["no_id"] += 1
                continue
            leg_id = m.group(1).decode().strip("/")
            if leg_id not in valid_from and not args.dry_run:
                # Retained EU law and anything else stage 1 never enumerated.
                stats["not_in_register"] += 1
                continue
            if leg_id in have_text or leg_id in done:
                stats["skipped"] += 1
                continue
            vf = valid_from.get(leg_id) or date(1900, 1, 1)
            try:
                provs = stage3.parse_provisions(body.decode("utf-8", "replace"), leg_id)
            except Exception:
                stats["failed"] += 1
                continue
            stats["parsed"] += 1
            if not provs:
                stats["empty"] += 1
                continue
            seen_versions.append((leg_id, vf, "bulk", None, False, 200))
            done.add(leg_id)
            for p in provs:
                # the parser's own ord, not a fresh enumerate: it skips P1s with no
                # text, and renumbering here would give the bulk half a different
                # key from the crawled half for the same act
                rows.append((leg_id, vf, p["ord"], p.get("provision_label"),
                             p.get("provision_type"), p.get("provision_uri"),
                             p.get("part"), p.get("chapter"), p.get("schedule_no"),
                             p.get("title"), p.get("text"),
                             len(p.get("text") or "")))
                stats["provisions"] += 1
            if len(rows) >= args.batch:
                flush()
            if stats["files"] % 5000 == 0:
                print(f"  {stats['files']} files | parsed={stats['parsed']} "
                      f"provisions={stats['provisions']} empty={stats['empty']} "
                      f"outside={stats['not_in_register']}", flush=True)
        flush()

    flush()
    print("\n=== summary", flush=True)
    for k in ("files", "parsed", "provisions", "empty", "skipped",
              "not_in_register", "no_id", "failed"):
        print(f"  {k:<16} {stats[k]}", flush=True)


if __name__ == "__main__":
    main()
